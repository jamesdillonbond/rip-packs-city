#!/usr/bin/env node
// inspect-dapper-csv.mjs — one-off diagnostic for Dapper wallet CSV exports.
//
// Reads a Dapper CSV (Settings → Dapper Wallet → Home → Request CSV on
// nbatopshot.com) and prints a frequency table of (Activity Type, Status)
// pairs. Was used during the April 2026 acquisitions backfill to figure
// out which Dapper categories mapped to which acquisition_method values
// before writing classify-ts-livetoken.mjs.
//
// Usage: node scripts/inspect-dapper-csv.mjs <path-to-csv>
// Dapper is deprecated as of 2026; this stays in tree for edge-case audits.

import { createReadStream } from "fs"
import { parse } from "csv-parse"

const path = process.argv[2] || "scripts/data/dapper-wallet.csv"
const counts = new Map()
const parser = createReadStream(path).pipe(
  parse({ columns: true, trim: true, skip_empty_lines: true, relax_column_count: true, bom: true })
)
let total = 0
for await (const r of parser) {
  total++
  const t = String(r["Activity Type"] ?? "").replace(/\s+/g, " ").trim()
  const status = String(r["Status"] ?? "").trim()
  const key = `${t} | ${status}`
  counts.set(key, (counts.get(key) || 0) + 1)
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log(`total rows: ${total}`)
console.log("activity type | status:")
for (const [k, v] of sorted) console.log(`  ${v.toString().padStart(6)} ${k}`)