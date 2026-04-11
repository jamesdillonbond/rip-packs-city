#!/usr/bin/env node
/**
 * scripts/backfill-team-name.mjs
 *
 * Backfills editions.team_name via Top Shot GQL (searchEditions → play.stats.teamAtMoment).
 * Routes through the Cloudflare Worker proxy when TS_PROXY_URL + TS_PROXY_SECRET
 * are set; Top Shot's public GQL blocks Vercel/cloud IPs without it but usually
 * accepts local IPs directly.
 *
 * Strategy: group target editions by set_id_onchain so we make one GQL request
 * per set instead of one per edition. Each request returns every edition in the
 * set — we match by play.flowID and patch team_name.
 *
 * Usage:
 *   node scripts/backfill-team-name.mjs
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load .env.local ─────────────────────────────────────────────────────────
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
  console.error("[team-backfill] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TS_PROXY_URL = process.env.TS_PROXY_URL;
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET;
const TS_GQL = TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "rpc-backfill/1.0",
  ...(TS_PROXY_URL && TS_PROXY_SECRET ? { "X-Proxy-Secret": TS_PROXY_SECRET } : {}),
};

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const DELAY_MS = 500;

// ── Supabase REST helpers ───────────────────────────────────────────────────
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

// ── Top Shot GQL ────────────────────────────────────────────────────────────
const SEARCH_SET_EDITIONS = `
  query BackfillTeamBySet($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
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

// Returns Map<playFlowID, teamAtMoment>
async function fetchSetTeamMap(setUUID) {
  const playMap = new Map();

  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "BackfillTeamBySet",
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
    const team = ed.play?.stats?.teamAtMoment || null;
    if (playFlowID && team) {
      playMap.set(String(playFlowID), String(team).trim());
    }
  }

  return playMap;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    "[team-backfill] Proxy:",
    TS_PROXY_URL ? TS_PROXY_URL : "DIRECT (no proxy — may be blocked by Cloudflare)"
  );

  // 1. Fetch all editions with null team_name for NBA Top Shot
  let allEditions = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=id,external_id,set_id_onchain,play_id_onchain&team_name=is.null&collection_id=eq.${TOPSHOT_COLLECTION_ID}&order=id&offset=${offset}&limit=${pageSize}`
    );
    allEditions.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`[team-backfill] Found ${allEditions.length} editions with null team_name`);

  // 2. Build set flowId → UUID map from existing UUID-format editions.
  //    PostgREST doesn't expose regex filters, so pull all and filter locally.
  const setFlowIdToUUID = new Map();
  let setMapOffset = 0;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=set_id_onchain,external_id&set_id_onchain=not.is.null&order=set_id_onchain&offset=${setMapOffset}&limit=1000`
    );
    for (const row of rows) {
      const extId = row.external_id;
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
  console.log(`[team-backfill] Set flowId→UUID map: ${setFlowIdToUUID.size} entries`);

  // 3. Group editions by set. For UUID-format external_ids the set UUID is
  //    already in the key; for integer-format we fall back to the flowId→UUID map.
  //    Key each group by the setUUID we'll actually query.
  const bySet = new Map(); // setUUID → editions[]
  let missingSet = 0;

  for (const ed of allEditions) {
    const extId = String(ed.external_id ?? "");
    let setUUID = null;

    if (extId.length > 36 && extId.includes("-")) {
      setUUID = extId.split(":")[0];
    } else if (ed.set_id_onchain != null) {
      setUUID = setFlowIdToUUID.get(String(ed.set_id_onchain)) ?? null;
    }

    if (!setUUID) {
      missingSet++;
      continue;
    }

    if (!bySet.has(setUUID)) bySet.set(setUUID, []);
    bySet.get(setUUID).push(ed);
  }

  console.log(
    `[team-backfill] Grouped into ${bySet.size} sets (${missingSet} editions have no resolvable set UUID)`
  );

  let updated = 0;
  let failures = 0;
  let setsProcessed = 0;

  for (const [setUUID, editions] of bySet) {
    setsProcessed++;

    try {
      const teamMap = await fetchSetTeamMap(setUUID);

      for (const edition of editions) {
        // Prefer on-chain play flowID if present, otherwise extract from external_id
        let playKey = null;
        if (edition.play_id_onchain != null) {
          playKey = String(edition.play_id_onchain);
        }

        let team = playKey ? teamMap.get(playKey) : null;

        // Fallback: UUID-format external_ids don't carry the flowID, so if the
        // per-set lookup gave us exactly one result we can apply it safely only
        // when the edition has a unique play — otherwise skip.
        if (!team && !edition.play_id_onchain && teamMap.size === 1) {
          team = teamMap.values().next().value;
        }

        if (!team) {
          failures++;
          continue;
        }

        try {
          await supabaseUpdate("editions", `id=eq.${edition.id}`, { team_name: team });
          updated++;
        } catch (err) {
          failures++;
          if (failures <= 20) console.warn(`[team-backfill] PATCH failed for ${edition.id}: ${err.message}`);
        }
      }

      if (setsProcessed % 10 === 0) {
        console.log(
          `[team-backfill] Sets: ${setsProcessed}/${bySet.size} — updated: ${updated}, failures: ${failures}`
        );
      }
    } catch (err) {
      failures += editions.length;
      console.warn(`[team-backfill] GQL failed for set UUID=${setUUID}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  // Summary
  console.log("");
  console.log("[team-backfill] ─── Summary ──────────────────────────────────────");
  console.log(`[team-backfill] Total editions   : ${allEditions.length}`);
  console.log(`[team-backfill] Updated          : ${updated}`);
  console.log(`[team-backfill] Failures         : ${failures}`);
  console.log(`[team-backfill] Missing set UUID : ${missingSet}`);

  try {
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/editions?select=id&team_name=is.null&collection_id=eq.${TOPSHOT_COLLECTION_ID}`,
      { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } }
    );
    const range = countRes.headers.get("content-range") || "";
    const total = range.split("/")[1] || "?";
    console.log(`[team-backfill] Still null team  : ${total}`);
  } catch {
    console.log("[team-backfill] (could not check remaining count)");
  }
  console.log("[team-backfill] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[team-backfill] FATAL:", err);
    process.exit(1);
  });
