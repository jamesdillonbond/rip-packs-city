#!/usr/bin/env node
/**
 * scripts/backfill-edition-tiers.mjs
 *
 * Backfills null tier and team_name on editions using the Top Shot public GQL.
 *
 * Strategy: editions with null tier have integer-format external_ids (setID:playID)
 * but GQL requires UUIDs. We resolve set UUIDs from sibling editions that have
 * UUID-format external_ids, then query GQL per-set to get all editions in that set.
 * We match by play.flowID to find the tier and team for each edition.
 *
 * Usage:
 *   node scripts/backfill-edition-tiers.mjs
 *
 * Requires in .env.local:
 *   SUPABASE_URL  (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load .env.local ──────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    console.error("Could not read .env.local — run from project root");
    process.exit(1);
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[tier-backfill] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TS_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = { "Content-Type": "application/json", "User-Agent": "rpc-backfill/1.0" };
const DELAY_MS = 200;

// ── Supabase REST helpers ────────────────────────────────────────────────────
const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function supabaseSelect(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: { ...headers, Prefer: "return=representation" } });
  if (!res.ok) throw new Error(`Supabase SELECT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabaseUpdate(table, match, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${match}`;
  const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase UPDATE ${table} failed: ${res.status} ${text}`);
  }
}

// ── Top Shot GQL ─────────────────────────────────────────────────────────────
const SEARCH_SET_EDITIONS = `
  query BackfillTierBySet($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                tier
                set { flowId }
                play { flowID stats { teamAtMoment } }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch all editions for a given set UUID.
 * Uses a large limit (500) to avoid cursor pagination issues.
 * Returns a Map of playFlowID → { tier, teamAtMoment }
 */
async function fetchSetEditions(setUUID) {
  const playMap = new Map();

  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "BackfillTierBySet",
      query: SEARCH_SET_EDITIONS,
      variables: {
        input: {
          filters: { bySetIDs: [setUUID] },
          searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 500 } },
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || "GQL error");

  const editions = json?.data?.searchEditions?.searchSummary?.data?.data;
  if (!Array.isArray(editions)) return playMap;

  for (const ed of editions) {
    const playFlowID = ed.play?.flowID;
    const tier = ed.tier?.replace(/^MOMENT_TIER_/, "") || null;
    const teamAtMoment = ed.play?.stats?.teamAtMoment || null;
    if (playFlowID && tier) {
      playMap.set(String(playFlowID), { tier, teamAtMoment });
    }
  }

  return playMap;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch all editions with null tier
  let allEditions = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=id,external_id,set_id_onchain,play_id_onchain,team_name&tier=is.null&order=id&offset=${offset}&limit=${pageSize}`
    );
    allEditions.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`[tier-backfill] Found ${allEditions.length} editions with null tier`);

  // 2. Build set flowId → UUID map from existing UUID-format editions
  //    PostgREST doesn't support regex, so fetch all and filter locally
  let setMapOffset = 0;
  const setFlowIdToUUID = new Map();
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=set_id_onchain,external_id&set_id_onchain=not.is.null&order=set_id_onchain&offset=${setMapOffset}&limit=1000`
    );
    for (const row of rows) {
      const extId = row.external_id;
      // UUID format: xxxxxxxx-xxxx-...
      if (extId && extId.length > 36 && extId.includes("-") && extId.includes(":")) {
        const setUUID = extId.split(":")[0];
        const flowId = String(row.set_id_onchain);
        if (!setFlowIdToUUID.has(flowId) && setUUID.length >= 36) {
          setFlowIdToUUID.set(flowId, setUUID);
        }
      }
    }
    if (rows.length < 1000) break;
    setMapOffset += 1000;
  }
  console.log(`[tier-backfill] Set flowId→UUID map: ${setFlowIdToUUID.size} entries`);

  // 3. Group null-tier editions by set_id_onchain
  const bySet = new Map();
  for (const ed of allEditions) {
    const setKey = String(ed.set_id_onchain);
    if (!bySet.has(setKey)) bySet.set(setKey, []);
    bySet.get(setKey).push(ed);
  }
  console.log(`[tier-backfill] ${bySet.size} distinct sets to process`);

  let updated = 0;
  let failures = 0;
  let skippedNoUUID = 0;
  let setsProcessed = 0;

  for (const [setFlowId, editions] of bySet) {
    setsProcessed++;
    const setUUID = setFlowIdToUUID.get(setFlowId);

    if (!setUUID) {
      skippedNoUUID += editions.length;
      if (skippedNoUUID <= editions.length) {
        console.warn(`[tier-backfill] No UUID for set flowId=${setFlowId} — skipping ${editions.length} editions`);
      }
      continue;
    }

    try {
      const playMap = await fetchSetEditions(setUUID);

      for (const edition of editions) {
        const playKey = String(edition.play_id_onchain);
        const match = playMap.get(playKey);

        if (!match || !match.tier) {
          failures++;
          continue;
        }

        const patch = { tier: match.tier };
        if (!edition.team_name && match.teamAtMoment) patch.team_name = match.teamAtMoment;

        try {
          await supabaseUpdate("editions", `id=eq.${edition.id}`, patch);
          updated++;
        } catch (err) {
          failures++;
          if (failures <= 20) console.warn(`[tier-backfill] PATCH failed for ${edition.id}: ${err.message}`);
        }
      }

      if (setsProcessed % 10 === 0) {
        console.log(`[tier-backfill] Sets: ${setsProcessed}/${bySet.size} — updated: ${updated}, failures: ${failures}`);
      }
    } catch (err) {
      failures += editions.length;
      console.warn(`[tier-backfill] GQL failed for set flowId=${setFlowId} (UUID=${setUUID}): ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  // Summary
  console.log("");
  console.log("[tier-backfill] ─── Summary ──────────────────────────────────────");
  console.log(`[tier-backfill] Total editions   : ${allEditions.length}`);
  console.log(`[tier-backfill] Updated          : ${updated}`);
  console.log(`[tier-backfill] Failures         : ${failures}`);
  console.log(`[tier-backfill] Skipped (no UUID): ${skippedNoUUID}`);

  try {
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/editions?select=id&tier=is.null`,
      { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } }
    );
    const range = countRes.headers.get("content-range") || "";
    const total = range.split("/")[1] || "?";
    console.log(`[tier-backfill] Still null tier  : ${total}`);
  } catch {
    console.log("[tier-backfill] (could not check remaining count)");
  }
  console.log("[tier-backfill] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[tier-backfill] FATAL:", err);
    process.exit(1);
  });
