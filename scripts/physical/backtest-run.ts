#!/usr/bin/env -S npx tsx
// Run the physical-cards backtest over saved feed responses (offline; no network).
//
//   npx tsx scripts/physical/backtest-run.ts <dir-of-sales-json> [--days 365]
//
// Each file in <dir> is one card's HobbyCardIndex `/prices/:id/sales?days=365`
// response saved as JSON (the setup month allows 500 such calls). The script
// maps every sale, backtests each (grader, grade) with ≥ 6 confirmed sales,
// and prints a per-grade and overall verdict against DEFAULT_PASS_BAR.
//
// ⚠ The saved responses are licensed data: keep them out of git and delete them
// within 30 days of the plan ending (HCI terms).

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { mapHciSales } from "../../lib/physical/hci-client"
import { backtestCard, passes, DEFAULT_PASS_BAR } from "../../lib/physical/backtest"
import { normalizeGrade, isConfirmedPaid, type PhysicalSale } from "../../lib/physical/valuation-range"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: backtest-run.ts <dir-of-sales-json>")
  process.exit(2)
}

type Row = { file: string; grader: string; grade: string; scored: number; mape: number | null; within25: number | null; coverage: number | null; pass: boolean }
const rows: Row[] = []
const allApe: number[] = []
let allWithin = 0
let allScored = 0

for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { sales?: unknown[] }
  const sales = mapHciSales(body.sales ?? [])
  const groups = new Map<string, PhysicalSale[]>()
  for (const s of sales) {
    const k = `${s.grader}|${normalizeGrade(s.grade)}`
    groups.set(k, [...(groups.get(k) ?? []), s])
  }
  for (const [k, g] of groups) {
    if (g.filter(isConfirmedPaid).length < 6) continue
    const [grader, grade] = k.split("|")
    const s = backtestCard(g, grader as PhysicalSale["grader"], grade)
    if (!s.scored) continue
    rows.push({ file: f, grader, grade, scored: s.scored, mape: s.medianAbsPctError, within25: s.within25Pct, coverage: s.rangeCoverage, pass: passes(s) })
    for (const r of s.rows) {
      allApe.push(r.absPctError)
      if (r.absPctError <= 0.25) allWithin++
    }
    allScored += s.scored
  }
}

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`)
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.file}  ${r.grader} ${r.grade}  n=${r.scored}  medAPE=${pct(r.mape)}  ±25%=${pct(r.within25)}  inRange=${pct(r.coverage)}`)
}
allApe.sort((a, b) => a - b)
const med = allApe.length ? allApe[Math.floor(allApe.length / 2)] : null
const within = allScored ? allWithin / allScored : null
const overall = med != null && within != null && med <= DEFAULT_PASS_BAR.maxMedianAbsPctError && within >= DEFAULT_PASS_BAR.minWithin25Pct
console.log(`\nOVERALL ${overall ? "PASS" : "FAIL"}: grades=${rows.length} scored=${allScored} medAPE=${pct(med)} ±25%=${pct(within)} (bar: medAPE ≤ ${pct(DEFAULT_PASS_BAR.maxMedianAbsPctError)}, ±25% ≥ ${pct(DEFAULT_PASS_BAR.minWithin25Pct)})`)
process.exit(overall ? 0 : 1)
