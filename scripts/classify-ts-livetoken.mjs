#!/usr/bin/env node
/**
 * classify-ts-livetoken.mjs
 *
 * Drains the inferred_no_signal rows in moment_acquisitions for NBA Top Shot
 * by joining Livetoken's activityFeed CSV on momentID == nft_id. This replaces
 * the prior Dapper-CSV classifier, which relied on ±2s payment↔receive
 * timestamp pairing and broke on pack reveals, transfers, and adjustments.
 *
 * Default behavior is DRY-RUN. Pass --apply to perform DB writes.
 *
 * Usage:
 *   node scripts/classify-ts-livetoken.mjs                # dry run
 *   node scripts/classify-ts-livetoken.mjs --apply        # write to DB
 *   node scripts/classify-ts-livetoken.mjs --csv path.csv # override path
 */

import { readFileSync, writeFileSync, createReadStream } from "fs"
import { resolve } from "path"
import { createClient } from "@supabase/supabase-js"
import { parse } from "csv-parse"

/* ── env ──────────────────────────────────────────────────────────── */

;(function loadLocalEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local")
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/)
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq === -1) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!process.env[k]) process.env[k] = v
    }
  } catch {
    // .env.local optional
  }
})()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[ts-livetoken] Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY in .env.local"
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/* ── constants ────────────────────────────────────────────────────── */

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const SUSPICIOUS_DELTA_MS = 5 * 60 * 1000

// Livetoken activity types that represent an inbound acquisition.
const ACQ_METHOD_MAP = new Map([
  ["Bought", "marketplace"],
  ["Auction Bought", "marketplace"],
  ["Pack", "pack_pull"],
  ["Received Gift", "gift"],
  ["Received", "gift"],
  ["Reward", "challenge_reward"],
])

const METHODS = ["pack_pull", "marketplace", "gift", "challenge_reward"]

/* ── CLI ──────────────────────────────────────────────────────────── */

function parseArgs() {
  const argv = process.argv.slice(2)
  let csvPath = "scripts/data/livetoken-activity.csv"
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--csv" && argv[i + 1]) csvPath = argv[++i]
    else if (argv[i] === "--apply") apply = true
  }
  return { csvPath: resolve(process.cwd(), csvPath), apply }
}

/* ── CSV parse ────────────────────────────────────────────────────── */

// Counterparty looks like: "0xabcdef0123456789 (handle)" — extract hex.
const COUNTERPARTY_RE = /\b(0x[0-9a-fA-F]{1,16})\b/

function extractSourceWallet(counterparty) {
  if (!counterparty) return null
  const m = String(counterparty).match(COUNTERPARTY_RE)
  return m ? m[1].toLowerCase() : null
}

function parsePrice(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function parseIsoToMs(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

async function parseLivetokenCsv(csvPath) {
  const activitiesByMoment = new Map()
  let totalParsed = 0
  let inboundRows = 0
  const skippedByActivity = new Map()

  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    })
  )

  for await (const rec of parser) {
    totalParsed++
    const activity = String(rec["activity"] ?? "").trim()
    const method = ACQ_METHOD_MAP.get(activity)
    if (!method) {
      skippedByActivity.set(activity, (skippedByActivity.get(activity) || 0) + 1)
      continue
    }
    const momentID = String(rec["momentID"] ?? "").trim()
    if (!momentID) continue
    const tsMs = parseIsoToMs(rec["dateGMT"])
    if (tsMs == null) continue

    inboundRows++
    const entry = {
      tsMs,
      isoDate: new Date(tsMs).toISOString(),
      method,
      sourceWallet: extractSourceWallet(rec["counterparty"]),
      price: parsePrice(rec["price"]),
      activity,
      moment: String(rec["moment"] ?? ""),
      counterparty: String(rec["counterparty"] ?? ""),
    }
    const existing = activitiesByMoment.get(momentID)
    if (existing) existing.push(entry)
    else activitiesByMoment.set(momentID, [entry])
  }

  return { activitiesByMoment, totalParsed, inboundRows, skippedByActivity }
}

/* ── DB fetch ─────────────────────────────────────────────────────── */

async function fetchInferredRows() {
  const all = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("moment_acquisitions")
      .select("id, nft_id, acquired_date, buy_price, source_wallet, transaction_hash")
      .eq("acquisition_confidence", "inferred_no_signal")
      .eq("collection_id", COLLECTION_ID)
      .order("acquired_date", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

/* ── matching ─────────────────────────────────────────────────────── */

function matchRows(dbRows, activitiesByMoment) {
  const matched = []
  const unmatched = []
  const suspicious = []

  for (const row of dbRows) {
    const key = String(row.nft_id ?? "").trim()
    const activities = activitiesByMoment.get(key)
    if (!activities || activities.length === 0) {
      unmatched.push({ id: row.id, nft_id: row.nft_id, acquired_date: row.acquired_date })
      continue
    }
    const acqMs = Date.parse(row.acquired_date)
    let best = activities[0]
    let bestDelta = Number.isFinite(acqMs) ? Math.abs(best.tsMs - acqMs) : 0
    if (Number.isFinite(acqMs)) {
      for (let i = 1; i < activities.length; i++) {
        const d = Math.abs(activities[i].tsMs - acqMs)
        if (d < bestDelta) {
          bestDelta = d
          best = activities[i]
        }
      }
    }
    const rec = { row, activity: best, deltaMs: bestDelta }
    matched.push(rec)
    if (bestDelta > SUSPICIOUS_DELTA_MS) {
      suspicious.push({
        id: row.id,
        nft_id: row.nft_id,
        acquired_date: row.acquired_date,
        livetoken_date: best.isoDate,
        deltaMs: bestDelta,
        method: best.method,
      })
    }
  }

  return { matched, unmatched, suspicious }
}

/* ── stats helpers ────────────────────────────────────────────────── */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]
}

function computeDeltaStats(matched) {
  if (matched.length === 0) return { avgDeltaMs: 0, p50DeltaMs: 0, p95DeltaMs: 0, maxDeltaMs: 0 }
  const deltas = matched.map((m) => m.deltaMs).sort((a, b) => a - b)
  const sum = deltas.reduce((a, b) => a + b, 0)
  return {
    avgDeltaMs: Math.round(sum / deltas.length),
    p50DeltaMs: percentile(deltas, 0.5),
    p95DeltaMs: percentile(deltas, 0.95),
    maxDeltaMs: deltas[deltas.length - 1],
  }
}

function methodBreakdown(matched) {
  const counts = Object.fromEntries(METHODS.map((m) => [m, 0]))
  for (const m of matched) counts[m.activity.method] = (counts[m.activity.method] || 0) + 1
  return counts
}

function pickRandom(arr, n) {
  if (arr.length <= n) return [...arr]
  const copy = [...arr]
  const out = []
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

/* ── apply updates ────────────────────────────────────────────────── */

async function applyUpdates(matched) {
  let updated = 0
  let buyPricePopulated = 0
  let sourceWalletPopulated = 0
  const BATCH = 100
  for (let i = 0; i < matched.length; i += BATCH) {
    const batch = matched.slice(i, i + BATCH)
    await Promise.all(
      batch.map(async ({ row, activity }) => {
        const update = {
          acquisition_method: activity.method,
          acquisition_confidence: "verified",
          source: "livetoken_activity",
          transaction_hash: `livetoken:${row.nft_id}`,
        }
        if (row.buy_price == null && typeof activity.price === "number" && activity.price > 0) {
          update.buy_price = activity.price
          buyPricePopulated++
        }
        if (row.source_wallet == null && activity.sourceWallet) {
          update.source_wallet = activity.sourceWallet
          sourceWalletPopulated++
        }
        const { error } = await supabase
          .from("moment_acquisitions")
          .update(update)
          .eq("id", row.id)
        if (error) {
          console.error(`[ts-livetoken] update failed for ${row.id}: ${error.message}`)
        } else {
          updated++
        }
      })
    )
    console.log(
      `[ts-livetoken] batch ${Math.ceil((i + BATCH) / BATCH)}: updated ${updated}/${matched.length}`
    )
  }
  return { updated, buyPricePopulated, sourceWalletPopulated }
}

/* ── dry-run reporting ────────────────────────────────────────────── */

function printDryRunPreview({
  totalParsed,
  inboundRows,
  activitiesByMoment,
  dbRows,
  matched,
  unmatched,
  suspicious,
}) {
  const breakdown = methodBreakdown(matched)
  const deltaStats = computeDeltaStats(matched)
  const buyPriceWouldPopulate = matched.filter(
    ({ row, activity }) =>
      row.buy_price == null && typeof activity.price === "number" && activity.price > 0
  ).length
  const sourceWalletWouldPopulate = matched.filter(
    ({ row, activity }) => row.source_wallet == null && activity.sourceWallet
  ).length

  console.log("")
  console.log("=== LIVETOKEN CLASSIFIER — DRY RUN ===")
  console.log(`parsed CSV rows:               ${totalParsed}`)
  console.log(`inbound acquisition rows:      ${inboundRows}`)
  console.log(`unique nft_ids with activity:  ${activitiesByMoment.size}`)
  console.log(`db inferred_no_signal rows:    ${dbRows.length}`)
  console.log(`matched:                       ${matched.length}`)
  console.log(`unmatched:                     ${unmatched.length}`)
  console.log(`suspicious (delta > 5 min):    ${suspicious.length}`)
  console.log("")
  console.log("method breakdown (matched rows):")
  const total = matched.length || 1
  for (const m of METHODS) {
    const c = breakdown[m] || 0
    const pct = ((c / total) * 100).toFixed(1)
    console.log(`  ${m.padEnd(20)} ${c.toString().padStart(5)}  ${pct.padStart(5)}%`)
  }
  console.log("")
  console.log("delta stats:")
  console.log(`  avg: ${deltaStats.avgDeltaMs} ms`)
  console.log(`  p50: ${deltaStats.p50DeltaMs} ms`)
  console.log(`  p95: ${deltaStats.p95DeltaMs} ms`)
  console.log(`  max: ${deltaStats.maxDeltaMs} ms`)
  console.log("")
  console.log("enrichment preview:")
  console.log(`  would populate buy_price:     ${buyPriceWouldPopulate}`)
  console.log(`  would populate source_wallet: ${sourceWalletWouldPopulate}`)

  // 5 random examples per method.
  console.log("")
  console.log("random samples per method (up to 5 each):")
  for (const method of METHODS) {
    const rowsForMethod = matched.filter((m) => m.activity.method === method)
    if (rowsForMethod.length === 0) {
      console.log(`\n[${method}] no matches`)
      continue
    }
    const samples = pickRandom(rowsForMethod, 5)
    console.log(`\n[${method}] ${rowsForMethod.length} total — showing ${samples.length}`)
    for (const s of samples) {
      console.log(
        `  nft_id=${s.row.nft_id}  db_acq=${s.row.acquired_date}  lt_date=${s.activity.isoDate}  delta=${s.deltaMs}ms`
      )
      console.log(
        `    moment=${JSON.stringify(s.activity.moment).slice(0, 80)}  counterparty=${JSON.stringify(
          s.activity.counterparty
        ).slice(0, 80)}`
      )
    }
  }
  console.log("")
  console.log("DRY RUN COMPLETE. To apply these updates, run: npm run classify:ts-livetoken -- --apply")
}

/* ── main ─────────────────────────────────────────────────────────── */

async function main() {
  const t0 = Date.now()
  const { csvPath, apply } = parseArgs()
  console.log(`[ts-livetoken] mode: ${apply ? "APPLY (live writes)" : "DRY RUN (no writes)"}`)
  console.log(`[ts-livetoken] csv:  ${csvPath}`)

  const { activitiesByMoment, totalParsed, inboundRows, skippedByActivity } =
    await parseLivetokenCsv(csvPath)
  console.log(
    `[ts-livetoken] parsed ${totalParsed} rows → ${inboundRows} inbound across ${activitiesByMoment.size} nft_ids`
  )

  const dbRows = await fetchInferredRows()
  console.log(`[ts-livetoken] fetched ${dbRows.length} inferred_no_signal DB rows`)

  const { matched, unmatched, suspicious } = matchRows(dbRows, activitiesByMoment)

  // Always write diagnostic files.
  const outDir = resolve(process.cwd(), "scripts/data")
  const unmatchedPath = resolve(outDir, "classify-ts-livetoken-unmatched.json")
  writeFileSync(unmatchedPath, JSON.stringify(unmatched, null, 2), "utf-8")
  console.log(`[ts-livetoken] wrote ${unmatched.length} unmatched rows → ${unmatchedPath}`)

  if (suspicious.length > 0) {
    const suspiciousPath = resolve(outDir, "classify-ts-livetoken-suspicious.json")
    writeFileSync(suspiciousPath, JSON.stringify(suspicious, null, 2), "utf-8")
    console.log(`[ts-livetoken] wrote ${suspicious.length} suspicious rows → ${suspiciousPath}`)
  }

  if (!apply) {
    printDryRunPreview({
      totalParsed,
      inboundRows,
      activitiesByMoment,
      dbRows,
      matched,
      unmatched,
      suspicious,
    })
    return
  }

  console.log(`[ts-livetoken] applying updates to ${matched.length} rows…`)
  const { updated, buyPricePopulated, sourceWalletPopulated } = await applyUpdates(matched)

  const summary = {
    rowsUpdated: updated,
    methodBreakdown: methodBreakdown(matched),
    buyPricePopulated,
    sourceWalletPopulated,
    durationMs: Date.now() - t0,
  }
  console.log("")
  console.log("=== APPLY COMPLETE ===")
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error("[ts-livetoken] fatal:", err)
  process.exit(1)
})
