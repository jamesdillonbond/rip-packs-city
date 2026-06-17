#!/usr/bin/env node
/**
 * scripts/backfill-atlas-edition-map.mjs
 *
 * Populates public.topshot_atlas_edition_map — the RPC-edition <-> Dapper Atlas
 * integer-editionId map the Underpriced #1s deal-board ingest needs to TARGET a
 * candidate edition's #1 / perfect-serial listing query.
 *
 * Strategy (RPC-driven, complete, offset-stable):
 *   1. Read the authoritative distinct TopShot set list from RPC (editions.set_id_onchain).
 *   2. For each set, enumerate that set's editions via the public Dapper Atlas API
 *      EditionService/SearchEditions with a setId filter (stable per-set pagination).
 *   3. Send raw Atlas rows to upsert_topshot_atlas_edition_map(jsonb); the DB joins
 *      each row to its RPC edition via (set_id_onchain=Atlas.setId,
 *      play_id_onchain=Atlas.editionTemplateId) and maps it. Rows for editions RPC
 *      does not have simply don't join and are dropped.
 *
 * Join key VERIFIED 2026-06-16 on edition 26:695 / Atlas 2017
 * (set + play + player + circ + game_date all agree).
 *
 * Atlas egress: public host api.production.atlas.dapperlabs.com, no auth/cookie,
 * needs Origin/Referer/UA + the two Connect headers. It soft-throttles under rapid
 * calls (HTTP 200 with empty results), so this script is deliberately gentle.
 *
 * Usage:
 *   node scripts/backfill-atlas-edition-map.mjs            # full run (all 250 sets)
 *   node scripts/backfill-atlas-edition-map.mjs --max-sets 3   # smoke test
 *   node scripts/backfill-atlas-edition-map.mjs --dry-run      # fetch only, no DB write
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

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
  console.error("[atlas-map] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const ATLAS_SEARCH_EDITIONS =
  "https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions";
const ATLAS_HEADERS = {
  "connect-protocol-version": "1",
  "content-type": "application/json",
  Origin: "https://dapper.market",
  Referer: "https://dapper.market/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
const ATLAS_PAGE = 50;          // Atlas limit per call
const ATLAS_DELAY_MS = 350;     // gentle cadence between Atlas calls
const UPSERT_CHUNK = 500;       // map rows per DB upsert call

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const maxSetsIdx = argv.indexOf("--max-sets");
const MAX_SETS = maxSetsIdx !== -1 ? Number(argv[maxSetsIdx + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase REST ────────────────────────────────────────────────────────────
const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { ...sbHeaders, Prefer: "return=representation" },
  });
  if (!res.ok) throw new Error(`Supabase SELECT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function upsertMap(rows) {
  if (!rows.length || DRY_RUN) return 0;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_topshot_atlas_edition_map`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify({ p_rows: rows }),
  });
  if (!res.ok) throw new Error(`upsert RPC failed: ${res.status} ${await res.text()}`);
  return Number(await res.text()) || 0;
}

// distinct TopShot set_id_onchain — RPC is the authoritative set list
async function fetchDistinctSets() {
  const seen = new Set();
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const rows = await sbSelect(
      "editions",
      `select=set_id_onchain&collection_id=eq.${TS_COLLECTION_ID}&set_id_onchain=not.is.null&order=set_id_onchain.asc&limit=${PAGE}&offset=${offset}`
    );
    if (!rows.length) break;
    for (const r of rows) if (r.set_id_onchain != null) seen.add(r.set_id_onchain);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return [...seen].sort((a, b) => a - b);
}

// ── Atlas ────────────────────────────────────────────────────────────────────
// NOTE: Atlas's WAF 403-blocks Node/undici `fetch` (TLS/HTTP fingerprint) but
// allows curl/browser. So this LOCAL script shells out to curl. The eventual
// production ingest route cannot use a bare `fetch` to Atlas for the same reason
// — it will need a Cloudflare Worker proxy (the repo's pattern for WAF-blocked
// hosts) or a browser-fingerprint workaround. (Finding 2026-06-16.)
async function atlasSearchEditions(setId, offset) {
  const body = JSON.stringify({
    product: "nba",
    setId: [String(setId)],
    limit: String(ATLAS_PAGE),
    offset: String(offset),
  });
  const args = ["-s", "-X", "POST", ATLAS_SEARCH_EDITIONS];
  for (const [k, v] of Object.entries(ATLAS_HEADERS)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", body);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await execFileP("curl", args, { maxBuffer: 64 * 1024 * 1024 });
      const trimmed = stdout.trimStart();
      if (trimmed.startsWith("{")) return JSON.parse(stdout);
      lastErr = new Error(`non-JSON response (likely WAF block/throttle): ${stdout.slice(0, 80)}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1)); // backoff on block/throttle/network
  }
  throw new Error(`Atlas SearchEditions set ${setId} offset ${offset} failed: ${lastErr}`);
}

function atlasRowToMap(e) {
  if (!e || e.id == null || e.setId == null || e.editionTemplateId == null) return null;
  return {
    atlas_edition_id: String(e.id),
    set_id_onchain: Number(e.setId),
    play_id_onchain: Number(e.editionTemplateId),
    num_minted: e.numMinted != null ? Number(e.numMinted) : null,
    tier: e.tier ?? null,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[atlas-map] start  dryRun=${DRY_RUN}  maxSets=${MAX_SETS === Infinity ? "all" : MAX_SETS}`);
  const allSets = await fetchDistinctSets();
  const sets = allSets.slice(0, MAX_SETS === Infinity ? allSets.length : MAX_SETS);
  console.log(`[atlas-map] ${allSets.length} distinct TS sets in RPC; processing ${sets.length}`);

  let atlasRowsSeen = 0;
  let mappedTotal = 0;
  let buffer = [];
  let atlasCalls = 0;
  const emptySets = [];

  async function flush() {
    if (!buffer.length) return;
    const n = await upsertMap(buffer);
    mappedTotal += n;
    buffer = [];
  }

  for (let si = 0; si < sets.length; si++) {
    const setId = sets[si];
    let offset = 0;
    let total = null;
    let setRows = 0;

    for (;;) {
      const d = await atlasSearchEditions(setId, offset);
      atlasCalls++;
      total = Number(d?.pagination?.totalCount ?? 0);
      let eds = Array.isArray(d?.editions) ? d.editions : [];

      // soft-throttle guard: first page empty but the set has editions -> back off, retry once
      if (eds.length === 0 && total > 0 && offset === 0) {
        await sleep(2500);
        const d2 = await atlasSearchEditions(setId, offset);
        atlasCalls++;
        eds = Array.isArray(d2?.editions) ? d2.editions : [];
      }
      if (eds.length === 0) break;

      for (const e of eds) {
        const m = atlasRowToMap(e);
        if (m) {
          buffer.push(m);
          setRows++;
          atlasRowsSeen++;
        }
      }
      if (buffer.length >= UPSERT_CHUNK) await flush();

      offset += ATLAS_PAGE;
      if (offset >= total) break;
      await sleep(ATLAS_DELAY_MS);
    }

    if (setRows === 0) emptySets.push(setId);
    if ((si + 1) % 10 === 0 || si === sets.length - 1) {
      console.log(
        `[atlas-map] sets ${si + 1}/${sets.length} | atlasCalls=${atlasCalls} rowsSeen=${atlasRowsSeen} mapped=${mappedTotal}${buffer.length ? ` (+${buffer.length} buffered)` : ""}`
      );
    }
    await sleep(ATLAS_DELAY_MS);
  }

  await flush();

  console.log(`[atlas-map] DONE  atlasCalls=${atlasCalls}  atlasRowsSeen=${atlasRowsSeen}  mapped=${mappedTotal}`);
  if (emptySets.length) {
    console.log(`[atlas-map] WARNING ${emptySets.length} set(s) returned 0 Atlas editions: ${emptySets.join(", ")}`);
  }
  if (DRY_RUN) console.log(`[atlas-map] dry-run: no DB writes performed`);
}

main().catch((e) => {
  console.error("[atlas-map] FATAL", e);
  process.exit(1);
});
