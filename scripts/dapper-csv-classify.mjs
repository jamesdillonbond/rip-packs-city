#!/usr/bin/env node
/**
 * dapper-csv-classify.mjs
 *
 * Drains the inferred_no_signal rows in moment_acquisitions for NBA Top Shot
 * by pairing NFT receive events from Dapper Wallet's activity CSV with their
 * corresponding payment rows (purchase, pack pull, gift, etc).
 *
 * Usage:
 *   node scripts/dapper-csv-classify.mjs
 *   node scripts/dapper-csv-classify.mjs --csv scripts/data/dapper-wallet.csv
 *
 * CSV is expected at scripts/data/dapper-wallet.csv (gitignored).
 */

import { readFileSync, writeFileSync, createReadStream } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { createClient } from "@supabase/supabase-js"
import { parse } from "csv-parse"
import "dotenv/config"

// Load .env.local explicitly (dotenv/config only picks .env by default).
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
    // .env.local may be missing in some environments — service role still required below.
  }
})()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[dapper-csv] Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY in .env.local"
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PAIR_WINDOW_MS = 2_000
const MATCH_WINDOW_MS = 5_000
const MIN_VALID_TS = Date.parse("2020-01-01T00:00:00Z")

/* ── CLI ──────────────────────────────────────────────────────────── */

function parseArgs() {
  const argv = process.argv.slice(2)
  let csvPath = "scripts/data/dapper-wallet.csv"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--csv" && argv[i + 1]) csvPath = argv[++i]
  }
  return { csvPath: resolve(process.cwd(), csvPath) }
}

/* ── Date parsing ─────────────────────────────────────────────────── */

function parseDapperDate(raw) {
  if (!raw) return null
  // Format: "2026-04-18 16:49:26.970036 +0000 UTC"
  let s = String(raw).trim()
  s = s.replace(/\s+\+0000\s+UTC\s*$/, "")
  // Truncate microseconds to milliseconds (JS Date only handles millis).
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/)
  if (!m) return null
  const [, date, time, frac] = m
  const ms = frac ? frac.padEnd(6, "0").slice(0, 3) : "000"
  const iso = `${date}T${time}.${ms}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/* ── Activity type classification ─────────────────────────────────── */

function normalizeActivityType(raw) {
  if (!raw) return ""
  // Collapse multi-space variants ("NBA Top Shot  receive" vs "NBA Top Shot receive")
  return String(raw).replace(/\s+/g, " ").trim()
}

function isReceive(activityType) {
  return activityType === "NBA Top Shot receive"
}

// Maps a candidate *payment* activity type to { method, sub }.
const PAYMENT_MAP = new Map([
  ["NBA Top Shot purchase", { method: "marketplace", sub: "topshot_marketplace" }],
  ["flowty purchase", { method: "marketplace", sub: "flowty" }],
  ["Dapper purchase", { method: "pack_pull", sub: "dapper_pack" }],
  ["Dapper ACCEPTED", { method: "gift", sub: "dapper_accepted" }],
  ["Dapper transfer", { method: "gift", sub: "dapper_transfer" }],
  ["Dapper adjustment", { method: "gift", sub: "dapper_adjustment" }],
])

function classifyPayment(activityType) {
  return PAYMENT_MAP.get(activityType) || null
}

/* ── Part 1 & 2: parse CSV, build pairing index ──────────────────── */

async function parseCsv(csvPath) {
  const rows = []
  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    })
  )
  for await (const record of parser) {
    rows.push(record)
  }
  return rows
}

function buildReceives(rows) {
  const parsed = []
  let parsedRows = 0
  let skippedStatus = 0
  let skippedOldDate = 0
  let skippedBadDate = 0

  for (const r of rows) {
    parsedRows++
    const status = String(r["Status"] ?? "").trim()
    if (status !== "SUCCEEDED") {
      skippedStatus++
      continue
    }
    const tsMs = parseDapperDate(r["Date"])
    if (tsMs == null) {
      skippedBadDate++
      continue
    }
    if (tsMs < MIN_VALID_TS) {
      skippedOldDate++
      continue
    }
    const activityType = normalizeActivityType(r["Activity Type"])
    const totalAmount = Number(r["Total Amount"])
    const paymentId = String(r["Payment ID"] ?? "").trim()

    parsed.push({
      tsMs,
      activityType,
      totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
      paymentId,
    })
  }

  // Sort by timestamp asc.
  parsed.sort((a, b) => a.tsMs - b.tsMs)

  // Split into receives and candidate payments.
  const receives = []
  const payments = []
  for (const r of parsed) {
    if (isReceive(r.activityType)) {
      receives.push(r)
    } else if (PAYMENT_MAP.has(r.activityType)) {
      payments.push(r)
    }
    // everything else (cash-outs, purchases without receives, etc) is ignored
  }

  // For each receive, find the closest payment row within ±2s.
  // Use a two-pointer / binary-search-ish approach since both arrays are sorted.
  const csvReceives = []
  const methodCounts = { pack_pull: 0, marketplace: 0, gift: 0 }
  const subCounts = {}
  let unpaired = 0

  // Binary search helper: index of first payment with tsMs >= target.
  function lowerBound(arr, key) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].tsMs < key) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  for (const rcv of receives) {
    const startIdx = lowerBound(payments, rcv.tsMs - PAIR_WINDOW_MS)
    let best = null
    let bestDelta = Infinity
    for (let i = startIdx; i < payments.length; i++) {
      const p = payments[i]
      const delta = p.tsMs - rcv.tsMs
      if (delta > PAIR_WINDOW_MS) break
      const abs = Math.abs(delta)
      if (abs <= PAIR_WINDOW_MS && abs < bestDelta) {
        best = p
        bestDelta = abs
      }
    }

    let classification
    let pairedActivityType = null
    let totalAmount = 0
    let paymentId = rcv.paymentId
    if (best) {
      classification = classifyPayment(best.activityType)
      pairedActivityType = best.activityType
      totalAmount = best.totalAmount
      paymentId = best.paymentId || rcv.paymentId
    } else {
      classification = { method: "gift", sub: "unpaired_receive" }
      unpaired++
    }

    methodCounts[classification.method] = (methodCounts[classification.method] || 0) + 1
    subCounts[classification.sub] = (subCounts[classification.sub] || 0) + 1

    csvReceives.push({
      tsMs: rcv.tsMs,
      isoDate: new Date(rcv.tsMs).toISOString(),
      method: classification.method,
      sub: classification.sub,
      totalAmount,
      paymentId,
      pairedActivityType,
    })
  }

  return {
    csvReceives,
    stats: {
      parsedRows,
      skippedStatus,
      skippedOldDate,
      skippedBadDate,
      receiveRows: receives.length,
      paymentRows: payments.length,
      methodCounts,
      subCounts,
      unpaired,
    },
  }
}

/* ── Part 3: match DB rows to csvReceives ────────────────────────── */

async function fetchInferredRows() {
  const all = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("moment_acquisitions")
      .select("id, nft_id, acquired_date, buy_price, transaction_hash")
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

function matchDbRows(dbRows, csvReceives) {
  // Sort csvReceives by tsMs (should already be sorted, but just in case).
  const sortedCsv = [...csvReceives].sort((a, b) => a.tsMs - b.tsMs)

  function lowerBound(arr, key) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].tsMs < key) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const matched = []
  const unmatched = []

  for (const row of dbRows) {
    const acqMs = Date.parse(row.acquired_date)
    if (!Number.isFinite(acqMs)) {
      unmatched.push({
        id: row.id,
        nft_id: row.nft_id,
        acquired_date: row.acquired_date,
        nearestDeltaMs: null,
        nearestCsvIso: null,
      })
      continue
    }

    // Find nearest by scanning neighbors around the lower_bound.
    const idx = lowerBound(sortedCsv, acqMs)
    let best = null
    let bestDelta = Infinity
    for (const i of [idx - 1, idx, idx + 1]) {
      if (i < 0 || i >= sortedCsv.length) continue
      const d = Math.abs(sortedCsv[i].tsMs - acqMs)
      if (d < bestDelta) {
        bestDelta = d
        best = sortedCsv[i]
      }
    }

    if (best && bestDelta <= MATCH_WINDOW_MS) {
      matched.push({ row, csv: best, deltaMs: bestDelta })
    } else {
      unmatched.push({
        id: row.id,
        nft_id: row.nft_id,
        acquired_date: row.acquired_date,
        nearestDeltaMs: best ? bestDelta : null,
        nearestCsvIso: best ? best.isoDate : null,
      })
    }
  }

  return { matched, unmatched }
}

/* ── Part 4: apply updates ───────────────────────────────────────── */

async function applyUpdates(matched) {
  const BATCH = 100
  let done = 0
  for (let i = 0; i < matched.length; i += BATCH) {
    const batch = matched.slice(i, i + BATCH)
    // Updates are per-row because each has a different column set.
    await Promise.all(
      batch.map(async ({ row, csv }) => {
        const update = {
          acquisition_method: csv.method,
          acquisition_confidence: "verified",
          source: "dapper_csv",
          transaction_hash: `dapper_csv:${csv.paymentId}`,
        }
        if (csv.totalAmount > 0 && row.buy_price == null) {
          update.buy_price = csv.totalAmount
        }
        const { error } = await supabase
          .from("moment_acquisitions")
          .update(update)
          .eq("id", row.id)
        if (error) {
          console.error(`[dapper-csv] update failed for ${row.id}: ${error.message}`)
        }
      })
    )
    done += batch.length
    console.log(`[dapper-csv] batch ${Math.ceil((i + BATCH) / BATCH)}: ${done}/${matched.length}`)
  }
}

/* ── Part 5: reporting ───────────────────────────────────────────── */

function computeDeltaStats(matched) {
  if (matched.length === 0) return { avgDeltaMs: 0, p95DeltaMs: 0, maxDeltaMs: 0 }
  const deltas = matched.map((m) => m.deltaMs).sort((a, b) => a - b)
  const sum = deltas.reduce((acc, d) => acc + d, 0)
  const avgDeltaMs = Math.round(sum / deltas.length)
  const p95Index = Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))
  const p95DeltaMs = deltas[p95Index]
  const maxDeltaMs = deltas[deltas.length - 1]
  return { avgDeltaMs, p95DeltaMs, maxDeltaMs }
}

function writeUnmatchedReport(unmatched, outPath) {
  writeFileSync(outPath, JSON.stringify(unmatched, null, 2), "utf-8")
}

/* ── main ────────────────────────────────────────────────────────── */

async function main() {
  const t0 = Date.now()
  const { csvPath } = parseArgs()
  console.log(`[dapper-csv] reading CSV: ${csvPath}`)

  const rawRows = await parseCsv(csvPath)
  const { csvReceives, stats } = buildReceives(rawRows)

  console.log(`[dapper-csv] parsed rows: ${stats.parsedRows}`)
  console.log(`[dapper-csv]   skipped (status != SUCCEEDED): ${stats.skippedStatus}`)
  console.log(`[dapper-csv]   skipped (pre-2020): ${stats.skippedOldDate}`)
  console.log(`[dapper-csv]   skipped (bad date): ${stats.skippedBadDate}`)
  console.log(`[dapper-csv] candidate payment rows: ${stats.paymentRows}`)
  console.log(`[dapper-csv] receive rows found: ${stats.receiveRows}`)
  console.log(`[dapper-csv] paired/classified receives: ${csvReceives.length}`)
  console.log(`[dapper-csv] method breakdown: ${JSON.stringify(stats.methodCounts)}`)
  console.log(`[dapper-csv] sub breakdown: ${JSON.stringify(stats.subCounts)}`)
  console.log(`[dapper-csv] unpaired receives: ${stats.unpaired}`)

  console.log(`[dapper-csv] fetching inferred_no_signal rows from Supabase…`)
  const dbRows = await fetchInferredRows()
  console.log(`[dapper-csv] db rows to process: ${dbRows.length}`)

  const { matched, unmatched } = matchDbRows(dbRows, csvReceives)
  console.log(`[dapper-csv] matched: ${matched.length} / unmatched: ${unmatched.length}`)

  console.log(`[dapper-csv] applying updates in batches of 100…`)
  await applyUpdates(matched)

  // Write unmatched report.
  const outDir = resolve(process.cwd(), "scripts/data")
  const outPath = resolve(outDir, "dapper-csv-unmatched.json")
  writeUnmatchedReport(unmatched, outPath)
  console.log(`[dapper-csv] wrote unmatched report: ${outPath}`)

  // Final summary.
  const methodBreakdown = { pack_pull: 0, marketplace: 0, gift: 0 }
  const subBreakdown = {}
  for (const m of matched) {
    methodBreakdown[m.csv.method] = (methodBreakdown[m.csv.method] || 0) + 1
    subBreakdown[m.csv.sub] = (subBreakdown[m.csv.sub] || 0) + 1
  }
  const deltaStats = computeDeltaStats(matched)

  const summary = {
    parsedRows: stats.parsedRows,
    receiveRows: stats.receiveRows,
    pairedReceives: csvReceives.length - stats.unpaired,
    unpaired: stats.unpaired,
    dbRowsProcessed: dbRows.length,
    matched: matched.length,
    unmatched: unmatched.length,
    methodBreakdown,
    subBreakdown,
    avgDeltaMs: deltaStats.avgDeltaMs,
    p95DeltaMs: deltaStats.p95DeltaMs,
    maxDeltaMs: deltaStats.maxDeltaMs,
    durationMs: Date.now() - t0,
  }

  console.log("\n=== FINAL SUMMARY ===")
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error("[dapper-csv] fatal:", err)
  process.exit(1)
})
