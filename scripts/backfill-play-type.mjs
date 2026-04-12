#!/usr/bin/env node
/**
 * scripts/backfill-play-type.mjs
 *
 * Backfills editions.play_type + editions.play_category via Top Shot GQL
 * (searchEditions → play.stats.playType + play.stats.playCategory). Modeled
 * on backfill-team-name.mjs — groups editions by set, makes one GQL request
 * per set, matches responses by play.flowID, patches the rows.
 *
 * Usage:
 *   node scripts/backfill-play-type.mjs
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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
  console.error("[play-type] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
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

const SEARCH_SET_PLAY_TYPES = `
  query BackfillPlayTypeBySet($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        data {
          ... on Editions {
            data {
              ... on Edition {
                play { flowID stats { playType playCategory } }
              }
            }
          }
        }
      }
    }
  }
`;

// Returns Map<playFlowID, { playType, playCategory }>
async function fetchSetPlayTypeMap(setUUID) {
  const playMap = new Map();

  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "BackfillPlayTypeBySet",
      query: SEARCH_SET_PLAY_TYPES,
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
    const playType = ed.play?.stats?.playType || null;
    const playCategory = ed.play?.stats?.playCategory || null;
    if (playFlowID && (playType || playCategory)) {
      playMap.set(String(playFlowID), {
        playType: playType ? String(playType).trim() : null,
        playCategory: playCategory ? String(playCategory).trim() : null,
      });
    }
  }

  return playMap;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(
    "[play-type] Proxy:",
    TS_PROXY_URL ? TS_PROXY_URL : "DIRECT (no proxy — may be blocked by Cloudflare)"
  );

  // 1. Fetch all editions with null play_type for NBA Top Shot
  let allEditions = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=id,external_id,set_id_onchain,play_id_onchain&play_type=is.null&collection_id=eq.${TOPSHOT_COLLECTION_ID}&order=id&offset=${offset}&limit=${pageSize}`
    );
    allEditions.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`[play-type] Found ${allEditions.length} editions with null play_type`);

  // 2. Build set flowId → UUID map from existing UUID-format editions.
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
  console.log(`[play-type] Set flowId→UUID map: ${setFlowIdToUUID.size} entries`);

  // 3. Group editions by set UUID.
  const bySet = new Map();
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
    `[play-type] Grouped into ${bySet.size} sets (${missingSet} editions have no resolvable set UUID)`
  );

  let updated = 0;
  let failures = 0;
  let setsProcessed = 0;

  for (const [setUUID, editions] of bySet) {
    setsProcessed++;

    try {
      const playMap = await fetchSetPlayTypeMap(setUUID);

      for (const edition of editions) {
        let playKey = null;
        if (edition.play_id_onchain != null) {
          playKey = String(edition.play_id_onchain);
        }

        const hit = playKey ? playMap.get(playKey) : null;

        if (!hit || (!hit.playType && !hit.playCategory)) {
          failures++;
          continue;
        }

        const patch = {};
        if (hit.playType) patch.play_type = hit.playType;
        if (hit.playCategory) patch.play_category = hit.playCategory;

        try {
          await supabaseUpdate("editions", `id=eq.${edition.id}`, patch);
          updated++;
        } catch (err) {
          failures++;
          if (failures <= 20) console.warn(`[play-type] PATCH failed for ${edition.id}: ${err.message}`);
        }
      }

      if (setsProcessed % 10 === 0) {
        console.log(
          `[play-type] Sets: ${setsProcessed}/${bySet.size} — updated: ${updated}, failures: ${failures}`
        );
      }
    } catch (err) {
      failures += editions.length;
      console.warn(`[play-type] GQL failed for set UUID=${setUUID}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log("");
  console.log("[play-type] ─── Summary ──────────────────────────────────────");
  console.log(`[play-type] Total editions   : ${allEditions.length}`);
  console.log(`[play-type] Updated          : ${updated}`);
  console.log(`[play-type] Failures         : ${failures}`);
  console.log(`[play-type] Missing set UUID : ${missingSet}`);

  try {
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/editions?select=id&play_type=is.null&collection_id=eq.${TOPSHOT_COLLECTION_ID}`,
      { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } }
    );
    const range = countRes.headers.get("content-range") || "";
    const total = range.split("/")[1] || "?";
    console.log(`[play-type] Still null      : ${total}`);
  } catch {
    console.log("[play-type] (could not check remaining count)");
  }
  console.log("[play-type] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[play-type] FATAL:", err);
    process.exit(1);
  });
