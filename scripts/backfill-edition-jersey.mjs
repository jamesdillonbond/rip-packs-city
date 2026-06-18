#!/usr/bin/env node
/**
 * scripts/backfill-edition-jersey.mjs
 *
 * Backfills editions.jersey_number (per-MOMENT jersey) for NBA Top Shot from the
 * on-chain play metadata: TopShot.getPlayMetaData(playID)["JerseyNumber"]. This is
 * the number worn in THAT play — Top Shot's own jersey-match basis — and is correct
 * for number-changers, unlike players.jersey_number (one last-known value per player).
 *
 * Why on-chain and not GQL: TS GQL `searchEditions` rejects integer set/play IDs
 * (returns `invalid input syntax for type uuid`), and our canonical TS editions are
 * integer-keyed. Flow REST + getPlayMetaData takes the integer playID directly and
 * is not behind Cloudflare, so it works from anywhere. Jersey is a property of the
 * play, so we dedupe by play_id_onchain and one read covers every edition of that play.
 *
 * Idempotent + re-runnable: only targets editions with jersey_number IS NULL, so a
 * re-run after Top Shot mints new plays just fills the newcomers. Ongoing freshness is
 * handled by the ingest writer (app/api/ingest/route.ts upsertEdition).
 *
 * Usage:
 *   node scripts/backfill-edition-jersey.mjs
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
  console.error("[jersey] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=final";
const BATCH = 300; // proven safe under the Flow script compute limit
const DELAY_MS = 250;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function supabaseSelect(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: { ...headers, Prefer: "return=representation" } });
  if (!res.ok) throw new Error(`Supabase SELECT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function rpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function b64Utf8(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

// Cadence {String: String} via Flow REST → flat JS dict { playID: jerseyStr }.
function flattenCadenceDict(parsed) {
  const out = {};
  const v = parsed?.value;
  if (!Array.isArray(v)) return out;
  for (const entry of v) {
    const k = entry?.key?.value;
    const val = entry?.value?.value;
    if (typeof k === "string" && typeof val === "string") out[k] = val;
  }
  return out;
}

async function fetchJerseysForPlays(playIds) {
  const script = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(): {String: String} {
    let ids: [UInt32] = [${playIds.join(", ")}]
    let out: {String: String} = {}
    for id in ids {
        if let meta = TopShot.getPlayMetaData(playID: id) {
            if let j = meta["JerseyNumber"] {
                out[id.toString()] = j
            }
        }
    }
    return out
}
`.trim();

  const res = await fetch(FLOW_REST, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: b64Utf8(script), arguments: [] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Flow REST ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const raw = await res.text();
  const parsed = JSON.parse(atob(raw.replace(/^"|"$/g, "").trim()));
  return flattenCadenceDict(parsed); // { playID: jerseyStr }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1. Pull all TS editions still missing a per-moment jersey; dedupe to plays.
  const plays = new Set();
  let offset = 0;
  const pageSize = 1000;
  let edRows = 0;
  while (true) {
    const rows = await supabaseSelect(
      "editions",
      `select=play_id_onchain&jersey_number=is.null&play_id_onchain=not.is.null&collection_id=eq.${TOPSHOT_COLLECTION_ID}&order=play_id_onchain&offset=${offset}&limit=${pageSize}`
    );
    edRows += rows.length;
    for (const r of rows) if (r.play_id_onchain != null) plays.add(Number(r.play_id_onchain));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  const distinctPlays = [...plays];
  console.log(`[jersey] ${edRows} editions missing jersey → ${distinctPlays.length} distinct plays`);

  let editionsUpdated = 0;
  let jerseysFound = 0;
  let chunks = 0;
  let chunkFailures = 0;

  for (let i = 0; i < distinctPlays.length; i += BATCH) {
    chunks++;
    const slice = distinctPlays.slice(i, i + BATCH);
    let jerseyMap;
    try {
      jerseyMap = await fetchJerseysForPlays(slice);
    } catch (err) {
      chunkFailures++;
      console.warn(`[jersey] chunk ${chunks} Flow read failed: ${err.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    const pairs = [];
    for (const [playStr, jerseyStr] of Object.entries(jerseyMap)) {
      const playId = Number(playStr);
      const jersey = parseInt(jerseyStr, 10); // "00" -> 0; serial>0 gate ignores 0
      if (Number.isFinite(playId) && Number.isFinite(jersey)) {
        pairs.push({ play_id: playId, jersey });
      }
    }
    jerseysFound += pairs.length;

    if (pairs.length) {
      try {
        const n = await rpc("backfill_edition_jersey", { p_pairs: pairs });
        editionsUpdated += typeof n === "number" ? n : 0;
      } catch (err) {
        chunkFailures++;
        console.warn(`[jersey] chunk ${chunks} RPC failed: ${err.message}`);
      }
    }

    console.log(
      `[jersey] chunk ${chunks}/${Math.ceil(distinctPlays.length / BATCH)} — ` +
        `plays ${slice.length}, jerseys ${pairs.length}, editions updated so far ${editionsUpdated}`
    );
    await sleep(DELAY_MS);
  }

  console.log("");
  console.log("[jersey] ─── Summary ──────────────────────────────────────");
  console.log(`[jersey] Distinct plays     : ${distinctPlays.length}`);
  console.log(`[jersey] Jerseys found      : ${jerseysFound}`);
  console.log(`[jersey] Editions updated   : ${editionsUpdated}`);
  console.log(`[jersey] Chunk failures     : ${chunkFailures}`);
  console.log("[jersey] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[jersey] FATAL:", err);
    process.exit(1);
  });
