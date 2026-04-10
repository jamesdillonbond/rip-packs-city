#!/usr/bin/env node
/**
 * scripts/backfill-edition-onchain-ids.mjs
 *
 * Local backfill script — resolves on-chain integer setID/playID for editions
 * that only have UUID-format external_id. Uses the Top Shot public GQL API
 * (getEdition) to look up each edition individually. This runs locally so
 * Cloudflare doesn't block us.
 *
 * After running, re-run the metadata bridge migration to cascade player names,
 * tiers, and set names from wallet_moments_cache into newly-bridgeable editions.
 *
 * Usage:
 *   node scripts/backfill-edition-onchain-ids.mjs
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
  console.error("[backfill] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TS_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "rpc-backfill/1.0",
};
const DELAY_MS = 200;
const LOG_EVERY = 50;


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
  const res = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase UPDATE ${table} failed: ${res.status} ${text}`);
  }
}

// ── Top Shot GQL ─────────────────────────────────────────────────────────────
const SEARCH_EDITIONS_QUERY = `
  query SearchEditionBackfill($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      data {
        searchSummary {
          data {
            ... on Editions {
              data {
                ... on Edition {
                  setID
                  playID
                  circulationCount
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchEditionGQL(setUUID, playUUID) {
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "SearchEditionBackfill",
      query: SEARCH_EDITIONS_QUERY,
      variables: {
        input: {
          filters: { bySetID: setUUID, byPlayID: playUUID },
          searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
        },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || "GQL error");
  // Navigate: data.searchEditions.data.searchSummary.data.data[0]
  const editions = json?.data?.searchEditions?.data?.searchSummary?.data?.data;
  return Array.isArray(editions) ? editions[0] ?? null : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch all editions missing on-chain IDs
  // PostgREST limit is 1000 by default, paginate to get all
  let allEditions = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=id,external_id,circulation_count&or=(set_id_onchain.is.null,play_id_onchain.is.null)&order=id&offset=${offset}&limit=${pageSize}`
    );
    allEditions.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`[backfill] Found ${allEditions.length} editions missing on-chain IDs`);

  let processed = 0;
  let updated = 0;
  let failures = 0;

  for (const edition of allEditions) {
    processed++;
    const extId = edition.external_id;
    if (!extId || !extId.includes(":")) {
      failures++;
      if (failures <= 10) console.warn(`[backfill] ${processed}/${allEditions.length} — bad external_id: ${extId}`);
      continue;
    }

    const [setUUID, playUUID] = extId.split(":");
    if (!setUUID || !playUUID) {
      failures++;
      continue;
    }

    try {
      const data = await fetchEditionGQL(setUUID, playUUID);
      if (!data || data.setID == null || data.playID == null) {
        failures++;
        if (failures <= 20) console.warn(`[backfill] ${processed}/${allEditions.length} — GQL returned null for ${extId}`);
        await sleep(DELAY_MS);
        continue;
      }

      const setIdOnchain = Number(data.setID);
      const playIdOnchain = Number(data.playID);
      const circulationCount = data.circulationCount ? Number(data.circulationCount) : null;

      const patch = {
        set_id_onchain: setIdOnchain,
        play_id_onchain: playIdOnchain,
      };
      if (!edition.circulation_count && circulationCount) patch.circulation_count = circulationCount;

      await supabaseUpdate("editions", `id=eq.${edition.id}`, patch);
      updated++;

      if (processed % LOG_EVERY === 0) {
        console.log(`[backfill] ${processed}/${allEditions.length} — setID=${setIdOnchain} playID=${playIdOnchain}`);
      }
    } catch (err) {
      failures++;
      if (failures <= 20) console.warn(`[backfill] ${processed}/${allEditions.length} — error for ${extId}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  // Summary
  console.log("");
  console.log("[backfill] ─── Summary ──────────────────────────────────────");
  console.log(`[backfill] Total processed  : ${processed}`);
  console.log(`[backfill] Updated          : ${updated}`);
  console.log(`[backfill] Failures         : ${failures}`);

  // Check remaining nulls
  try {
    const remaining = await supabaseSelect(
      "editions",
      "select=id&or=(set_id_onchain.is.null,play_id_onchain.is.null)&limit=1&offset=0"
    );
    // Need a count — use a HEAD request with Prefer: count=exact
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/editions?select=id&or=(set_id_onchain.is.null,play_id_onchain.is.null)`,
      { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } }
    );
    const range = countRes.headers.get("content-range") || "";
    const total = range.split("/")[1] || "?";
    console.log(`[backfill] Still null       : ${total}`);
  } catch {
    console.log("[backfill] (could not check remaining count)");
  }
  console.log("[backfill] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] FATAL:", err);
    process.exit(1);
  });
