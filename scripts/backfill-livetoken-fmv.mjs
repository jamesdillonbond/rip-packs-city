#!/usr/bin/env node
/**
 * scripts/backfill-livetoken-fmv.mjs
 *
 * Pulls per-serial FMV for every moment in a wallet from LiveToken's
 * portfolio API, then inserts LOW-confidence fmv_snapshots for editions
 * that have no existing FMV.
 *
 * REQUIRES: LiveToken session cookie (expires periodically).
 *   1. Log into livetoken.co in your browser
 *   2. Open DevTools → Network → find any /api/ request → copy the Cookie header value
 *   3. Set LIVETOKEN_COOKIE in .env.local
 *
 * Usage:
 *   node scripts/backfill-livetoken-fmv.mjs
 *   node scripts/backfill-livetoken-fmv.mjs --force       # overwrite existing FMV
 *   node scripts/backfill-livetoken-fmv.mjs --dry-run     # preview without writing
 *   node scripts/backfill-livetoken-fmv.mjs --wallet=0x...
 *
 * See livetoken-api-intelligence.md for API docs.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// ── Self-parse .env.local ───────────────────────────────────────────────────
try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

// ── Config ──────────────────────────────────────────────────────────────────
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const DEFAULT_WALLET = "0xbd94cade097e50ac";

const args = process.argv.slice(2);
const walletArg = args.find((a) => a.startsWith("--wallet="));
const wallet = walletArg ? walletArg.split("=")[1] : DEFAULT_WALLET;
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

const cookie = process.env.LIVETOKEN_COOKIE;
if (!cookie) {
  console.error(
    "[livetoken-fmv] ERROR: LIVETOKEN_COOKIE not set.\n" +
      "  1. Log into livetoken.co\n" +
      "  2. DevTools → Network → copy Cookie header from any /api/ request\n" +
      '  3. Add LIVETOKEN_COOKIE=<value> to .env.local'
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Fetch LiveToken portfolio ───────────────────────────────────────────────
async function fetchPortfolio(walletAddr) {
  // LiveToken portfolio URL includes 0x prefix
  const url = `https://livetoken.co/api/topshot/portfolio/${walletAddr}`;
  console.log(`[livetoken-fmv] Fetching: ${url}`);

  const res = await fetch(url, {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://livetoken.co/",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LiveToken ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[livetoken-fmv] Wallet: ${wallet}`);
  console.log(`[livetoken-fmv] Force overwrite: ${force}`);
  console.log(`[livetoken-fmv] Dry run: ${dryRun}`);

  // Step 1: Fetch portfolio
  const portfolio = await fetchPortfolio(wallet);

  // Response is a JSON array of moment objects (not paginated)
  const moments = Array.isArray(portfolio) ? portfolio : portfolio.moments ?? portfolio.data ?? [];

  if (!moments.length) {
    console.error("[livetoken-fmv] No moments returned. Cookie may be expired.");
    if (!Array.isArray(portfolio)) {
      console.error("[livetoken-fmv] Response keys:", Object.keys(portfolio));
    }
    process.exit(1);
  }

  console.log(`[livetoken-fmv] Received ${moments.length} moments`);

  // Log first moment's keys so Claude Code can verify field mappings
  if (moments[0]) {
    console.log(`[livetoken-fmv] Sample moment keys: ${Object.keys(moments[0]).join(", ")}`);
    console.log(`[livetoken-fmv] Sample: setID=${moments[0].setID}, playID=${moments[0].playID}, valueFMV=${moments[0].valueFMV}`);
  }

  // Step 2: Group by edition (setID:playID), compute per-edition median FMV
  // LiveToken fields (see livetoken-api-intelligence.md):
  //   flowID, setID, playID, serial, circulation, valueFMV, dealRating,
  //   liquidityRating, buyPrice, acquiredDate, lowestAsk, highestOffer
  const editionMap = new Map();
  let skippedNoFmv = 0;
  let skippedNoEdition = 0;

  for (const m of moments) {
    const setID = m.setID;
    const playID = m.playID;
    const fmv = m.valueFMV;

    if (setID == null || playID == null) {
      skippedNoEdition++;
      continue;
    }
    if (typeof fmv !== "number" || fmv <= 0) {
      skippedNoFmv++;
      continue;
    }

    const key = `${setID}:${playID}`;
    if (!editionMap.has(key)) {
      editionMap.set(key, {
        fmvValues: [],
        circulation: m.circulation ?? null,
        liquidityRating: m.liquidityRating ?? null,
        lowestAsk: m.lowestAsk ?? null,
      });
    }
    const entry = editionMap.get(key);
    entry.fmvValues.push(fmv);
    if (m.lowestAsk != null && (entry.lowestAsk == null || m.lowestAsk < entry.lowestAsk)) {
      entry.lowestAsk = m.lowestAsk;
    }
  }

  console.log(`[livetoken-fmv] ${editionMap.size} distinct editions with FMV`);
  console.log(`[livetoken-fmv] Skipped: ${skippedNoFmv} no FMV, ${skippedNoEdition} no setID/playID`);

  // Step 3: Load existing FMV edition IDs (skip unless --force)
  let existingFmvEditions = new Set();
  if (!force) {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: rows } = await supabase
        .from("fmv_snapshots")
        .select("edition_id")
        .eq("collection_id", COLLECTION_ID)
        .range(offset, offset + PAGE - 1);
      if (!rows || rows.length === 0) break;
      for (const r of rows) existingFmvEditions.add(r.edition_id);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    console.log(`[livetoken-fmv] ${existingFmvEditions.size} editions already have FMV (will skip)`);
  }

  // Step 4: Match "setID:playID" → edition UUID in DB
  const editionKeys = Array.from(editionMap.keys());
  const editionIdMap = new Map();
  const BATCH = 200;

  for (let i = 0; i < editionKeys.length; i += BATCH) {
    const batch = editionKeys.slice(i, i + BATCH);

    // Integer-format external_id match
    const { data: intRows } = await supabase
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", COLLECTION_ID)
      .in("external_id", batch);

    for (const row of intRows ?? []) {
      editionIdMap.set(row.external_id, row.id);
    }

    // Fallback: set_id_onchain + play_id_onchain for UUID-format editions
    const unmatched = batch.filter((k) => !editionIdMap.has(k));
    for (const key of unmatched) {
      const [setId, playId] = key.split(":").map(Number);
      if (isNaN(setId) || isNaN(playId)) continue;

      const { data: rows } = await supabase
        .from("editions")
        .select("id")
        .eq("collection_id", COLLECTION_ID)
        .eq("set_id_onchain", setId)
        .eq("play_id_onchain", playId)
        .limit(1);

      if (rows?.length) editionIdMap.set(key, rows[0].id);
    }

    if ((i + BATCH) % 1000 === 0) {
      console.log(`[livetoken-fmv] Edition lookup: ${i + BATCH}/${editionKeys.length}`);
    }
  }

  console.log(`[livetoken-fmv] Matched ${editionIdMap.size}/${editionKeys.length} editions to DB`);

  // Step 5: Build snapshots to insert
  const toInsert = [];

  for (const [key, data] of editionMap) {
    const editionId = editionIdMap.get(key);
    if (!editionId) continue;
    if (!force && existingFmvEditions.has(editionId)) continue;

    // Median FMV across serials owned
    const sorted = data.fmvValues.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianFmv =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const minFmv = sorted[0];

    toInsert.push({
      edition_id: editionId,
      collection_id: COLLECTION_ID,
      fmv_usd: Math.round(medianFmv * 100) / 100,
      floor_price_usd: Math.round(minFmv * 100) / 100,
      wap_usd: Math.round(medianFmv * 100) / 100,
      confidence: "LOW",
      sales_count_7d: 0,
      sales_count_30d: 0,
      days_since_sale: null,
      algo_version: "v1.5.1_livetoken",
      computed_at: new Date().toISOString(),
      liquidity_rating: data.liquidityRating ?? null,
      ask_proxy_fmv: data.lowestAsk ? Math.round(data.lowestAsk * 100) / 100 : null,
    });
  }

  console.log(`[livetoken-fmv] ${toInsert.length} new FMV snapshots to insert`);

  if (dryRun) {
    console.log("[livetoken-fmv] DRY RUN — not writing");
    const sample = toInsert.slice(0, 3).map((r) => ({
      fmv: r.fmv_usd, floor: r.floor_price_usd, ask: r.ask_proxy_fmv, liq: r.liquidity_rating,
    }));
    console.log("[livetoken-fmv] Sample:", JSON.stringify(sample, null, 2));
    return;
  }

  // Step 6: Delete existing if --force (collection_id required — partitioned table)
  if (force && toInsert.length > 0) {
    const idsToDelete = toInsert.map((r) => r.edition_id);
    for (let i = 0; i < idsToDelete.length; i += BATCH) {
      const batch = idsToDelete.slice(i, i + BATCH);
      await supabase
        .from("fmv_snapshots")
        .delete()
        .eq("collection_id", COLLECTION_ID)
        .in("edition_id", batch);
    }
    console.log(`[livetoken-fmv] Deleted existing snapshots for ${idsToDelete.length} editions`);
  }

  // Step 7: Insert in batches
  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from("fmv_snapshots").insert(batch);
    if (error) {
      console.error(`[livetoken-fmv] Batch ${i}-${i + batch.length} error:`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  console.log(`\n[livetoken-fmv] ─── Summary ───────────────────────────`);
  console.log(`[livetoken-fmv] LiveToken moments  : ${moments.length}`);
  console.log(`[livetoken-fmv] Distinct editions  : ${editionMap.size}`);
  console.log(`[livetoken-fmv] Matched to DB      : ${editionIdMap.size}`);
  console.log(`[livetoken-fmv] Inserted snapshots : ${inserted}`);
  if (errors) console.log(`[livetoken-fmv] Errors             : ${errors}`);
  console.log(`[livetoken-fmv] ────────────────────────────────────────`);
}

main().catch((err) => {
  console.error("[livetoken-fmv] Fatal:", err.message);
  process.exit(1);
});
