#!/usr/bin/env node
/**
 * scripts/backfill-livetoken-fmv.mjs
 *
 * Reads LiveToken portfolio JSON dumps (browser console export)
 * and inserts FMV snapshots into Supabase for editions missing FMV.
 *
 * Usage:
 *   node scripts/backfill-livetoken-fmv.mjs              # default: gap-fill only
 *   node scripts/backfill-livetoken-fmv.mjs --dry-run    # preview
 *   node scripts/backfill-livetoken-fmv.mjs --force      # overwrite existing
 *
 * Reads all livetoken-portfolio*.json from repo root, deduplicates by momentID.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";

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

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Load & merge JSON dumps ─────────────────────────────────────────────────
function loadDumps() {
  const rootFiles = readdirSync(".");
  const filePaths = rootFiles.filter(
    (f) => f.startsWith("livetoken-portfolio") && f.endsWith(".json")
  );

  if (!filePaths.length) {
    console.error("[livetoken-fmv] No livetoken-portfolio*.json files found in repo root.");
    process.exit(1);
  }

  const allMoments = [];
  const seen = new Set();

  for (const fp of filePaths) {
    try {
      const raw = readFileSync(fp, "utf8").trim();
      if (raw.length < 10) {
        console.log(`[livetoken-fmv] Skipping ${fp} (empty)`);
        continue;
      }
      const data = JSON.parse(raw);
      const moments = Array.isArray(data) ? data : data.portfolio?.moments ?? data.moments ?? [];
      let added = 0;
      for (const m of moments) {
        if (m.momentID && !seen.has(m.momentID)) {
          seen.add(m.momentID);
          allMoments.push(m);
          added++;
        }
      }
      console.log(`[livetoken-fmv] ${fp}: ${moments.length} rows, ${added} new unique`);
    } catch (err) {
      console.error(`[livetoken-fmv] Failed ${fp}: ${err.message}`);
    }
  }
  return allMoments;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[livetoken-fmv] Force: ${force} | Dry run: ${dryRun}\n`);

  // 1. Load moments
  const moments = loadDumps();
  if (!moments.length) { console.error("No moments loaded."); process.exit(1); }
  console.log(`\n[livetoken-fmv] Total unique moments: ${moments.length}`);
  console.log(`[livetoken-fmv] Sample keys: ${Object.keys(moments[0]).filter(k => !k.startsWith("ref") && k !== "mintedMoment").join(", ")}`);

  // 2. Group by edition (setID:playID) → median FMV
  const editionMap = new Map();
  let skippedNoFmv = 0, skippedNoKey = 0;

  for (const m of moments) {
    if (m.setID == null || m.playID == null) { skippedNoKey++; continue; }
    if (typeof m.valueFMV !== "number" || m.valueFMV <= 0) { skippedNoFmv++; continue; }

    const key = `${m.setID}:${m.playID}`;
    if (!editionMap.has(key)) {
      editionMap.set(key, { fmvValues: [], circ: m.circulationCount ?? null, liq: m.liquidityRating ?? null });
    }
    editionMap.get(key).fmvValues.push(m.valueFMV);
  }

  console.log(`[livetoken-fmv] ${editionMap.size} distinct editions with FMV`);
  console.log(`[livetoken-fmv] Skipped: ${skippedNoFmv} no FMV, ${skippedNoKey} no setID/playID`);

  // 3. Existing FMV (skip unless --force)
  let existingIds = new Set();
  if (!force) {
    let offset = 0;
    while (true) {
      const { data: rows } = await supabase
        .from("fmv_snapshots").select("edition_id")
        .eq("collection_id", COLLECTION_ID)
        .range(offset, offset + 999);
      if (!rows?.length) break;
      for (const r of rows) existingIds.add(r.edition_id);
      if (rows.length < 1000) break;
      offset += 1000;
    }
    console.log(`[livetoken-fmv] ${existingIds.size} editions already have FMV (will skip)`);
  }

  // 4. Match edition keys → DB UUIDs
  const editionKeys = Array.from(editionMap.keys());
  const idMap = new Map();
  const BATCH = 200;

  for (let i = 0; i < editionKeys.length; i += BATCH) {
    const batch = editionKeys.slice(i, i + BATCH);

    // Integer external_id match
    const { data: intRows } = await supabase
      .from("editions").select("id, external_id")
      .eq("collection_id", COLLECTION_ID)
      .in("external_id", batch);
    for (const r of intRows ?? []) idMap.set(r.external_id, r.id);

    // Fallback: onchain IDs for UUID-format editions
    for (const key of batch.filter(k => !idMap.has(k))) {
      const [s, p] = key.split(":").map(Number);
      if (isNaN(s) || isNaN(p)) continue;
      const { data: rows } = await supabase
        .from("editions").select("id")
        .eq("collection_id", COLLECTION_ID)
        .eq("set_id_onchain", s).eq("play_id_onchain", p)
        .limit(1);
      if (rows?.length) idMap.set(key, rows[0].id);
    }
  }

  console.log(`[livetoken-fmv] Matched ${idMap.size}/${editionKeys.length} editions to DB`);

  // 5. Build snapshots
  const toInsert = [];
  for (const [key, data] of editionMap) {
    const editionId = idMap.get(key);
    if (!editionId) continue;
    if (!force && existingIds.has(editionId)) continue;

    const sorted = data.fmvValues.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    toInsert.push({
      edition_id: editionId,
      collection_id: COLLECTION_ID,
      fmv_usd: Math.round(median * 100) / 100,
      floor_price_usd: Math.round(sorted[0] * 100) / 100,
      wap_usd: Math.round(median * 100) / 100,
      confidence: "LOW",
      sales_count_7d: 0,
      sales_count_30d: 0,
      days_since_sale: null,
      algo_version: "v1.5.1_livetoken",
      computed_at: new Date().toISOString(),
      liquidity_rating: data.liq ?? null,
    });
  }

  console.log(`[livetoken-fmv] ${toInsert.length} new FMV snapshots to insert`);

  if (dryRun) {
    console.log("[livetoken-fmv] DRY RUN — samples:");
    for (const r of toInsert.slice(0, 5)) {
      console.log(`  fmv=$${r.fmv_usd} floor=$${r.floor_price_usd} liq=${r.liquidity_rating}`);
    }
    return;
  }

  // 6. Delete if --force (partitioned table — collection_id required)
  if (force && toInsert.length > 0) {
    const ids = toInsert.map(r => r.edition_id);
    for (let i = 0; i < ids.length; i += BATCH) {
      await supabase.from("fmv_snapshots").delete()
        .eq("collection_id", COLLECTION_ID)
        .in("edition_id", ids.slice(i, i + BATCH));
    }
    console.log(`[livetoken-fmv] Deleted existing for ${ids.length} editions`);
  }

  // 7. Insert
  let inserted = 0, errors = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from("fmv_snapshots").insert(batch);
    if (error) {
      console.error(`[livetoken-fmv] Batch error: ${error.message}`);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  console.log(`\n[livetoken-fmv] ─── Summary ───────────────────────────`);
  console.log(`[livetoken-fmv] Moments loaded     : ${moments.length}`);
  console.log(`[livetoken-fmv] Distinct editions   : ${editionMap.size}`);
  console.log(`[livetoken-fmv] Matched to DB       : ${idMap.size}`);
  console.log(`[livetoken-fmv] Inserted snapshots  : ${inserted}`);
  if (errors) console.log(`[livetoken-fmv] Errors              : ${errors}`);
  console.log(`[livetoken-fmv] ────────────────────────────────────────`);
}

main().catch((err) => { console.error("[livetoken-fmv] Fatal:", err.message); process.exit(1); });
