#!/usr/bin/env node
// Report which heartbeated `after()` routes are being KILLED at the wall.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// A `maxDuration` kill writes NO terminal `pipeline_runs` row (`try/catch` and
// `finally` both fail to run), so a killed route is invisible in every summary
// instrument — and in `pipeline_runs_daily` a kill does not even appear as a
// failure row, it appears as a MISSING DAY, which makes the lifetime record
// read 100% ok. See `lib/pipeline/heartbeat.ts`.
//
// Correlating heartbeat rows against terminal rows is the ONLY way to see this,
// and until 2026-08-28 that correlation lived nowhere — it was re-derived by
// hand whenever someone wanted it, and on 2026-08-28 it was re-derived WRONG:
// a pooled 56% kill rate that straddled a fix was filed as an ongoing failure
// when the pipeline had in fact recovered completely. `lib/pipeline/kill-rate.ts`
// carries that case, its lesson and the classifier; this script is the thin
// runner around it.
//
// ⚠ Read the VERDICT column, never the % alone. That is the entire point.
//
// Usage:
//   node scripts/analysis/killed-after-routes.mjs
//   node scripts/analysis/killed-after-routes.mjs --json//
// Exit: 0 nothing failing now · 1 a pipeline is failing now · 2 could not measure.
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from
// .env.local if not already set). Reads `pipeline_runs` only — mutates nothing.
//
// ⚠ SCOPE, stated so a clean report is not over-read: `pipeline_runs` retains
// ~73 h, so this sees the last three days and NOTHING before. A pipeline absent
// from the output has no heartbeat in the window — which may mean it is healthy,
// idle, un-heartbeated, or never firing. This script cannot tell those apart,
// and it does not pretend to: `--json` lists what it saw, not what exists.

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { correlateRuns } from '../../lib/pipeline/kill-rate.ts'

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const JSON_OUT = process.argv.includes('--json')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}
const db = createClient(url, key, { auth: { persistSession: false } })

// ⚠ PostgREST caps a read at 1000 rows and CLAMPS an explicit higher .limit(),
// so this MUST page. And any .range() pagination needs a deterministic .order()
// on a UNIQUE key or it reads the right NUMBER of rows and the wrong ROWS —
// the duplicates and omissions cancel, so every count-based check still passes.
// `id` is the table's bigint PK.
async function readAllRuns() {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('pipeline_runs')
      .select('id,pipeline,started_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    // ⚠ A paged read that `break`s on error returns a PARTIAL list no caller
    // can distinguish from a complete one. Throw.
    if (error) throw new Error(`pipeline_runs read failed at offset ${from}: ${error.message}`)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}

// ⚠ EXIT CODES ARE THREE-STATE ON PURPOSE. 1 means "measured, and something is
// failing now"; 2 means "could NOT measure". Collapsing them would let a read
// failure render as a finding — the defect class this whole module is about.
let runs
try {
  runs = await readAllRuns()
} catch (err) {
  console.error(`could not measure: ${err.message}`)
  process.exit(2)
}

// ⚠ The correlation and the verdict both live in lib/pipeline/kill-rate.ts, under
// test against the real 2026-08-28 record with positive and negative controls.
// Do NOT re-derive either here — re-deriving it by hand is the documented defect.
const records = correlateRuns(runs)

if (JSON_OUT) {
  console.log(JSON.stringify({ window: 'pipeline_runs retention, ~73h', records }, null, 2))
} else {
  const ICON = { failing: '🚨', intermittent: '⚠ ', recovered: '✅', healthy: '  ' }
  console.log(`\n${records.length} heartbeated pipelines seen in the ~73h pipeline_runs window\n`)
  for (const r of records) {
    console.log(`${ICON[r.verdict]} ${r.verdict.toUpperCase().padEnd(13)} ${r.pipeline}`)
    console.log(`   ${r.note}`)
  }
  console.log(
    '\n⚠ Read the VERDICT, not the %. A pooled kill rate cannot tell "broken now"' +
      '\n  from "was broken, fixed, and the rate still carries the corpse".\n'
  )
}

// Exit non-zero only on a pipeline that is failing RIGHT NOW. `intermittent` and
// `recovered` are reports, not alarms — a check that goes red on history stays
// red forever and stops being read.
process.exit(records.some((r) => r.verdict === 'failing') ? 1 : 0)
