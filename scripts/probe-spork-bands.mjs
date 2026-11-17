#!/usr/bin/env node
// scripts/probe-spork-bands.mjs
//
// Probes ONE small event query at the top of every historical Flow spork band
// through the `spork-proxy` Cloudflare Worker, and reports which bands answer.
//
// WHY THIS EXISTS (2026-08-07). `topshot-pack-opens-history-backfill` wedged for
// 17h and was diagnosed as a "persistently-transient 250-block range", with two
// proposed fixes (adaptive sub-chunking / bounded permanent-skip). Both were
// wrong: this probe showed every spork band <= 65,264,618 returning Cloudflare
// 522 (origin connection timeout) while every band above returned 200. The
// wedge was an UPSTREAM OUTAGE, not a range defect — so sub-chunking could not
// help (10-block windows failed identically) and skipping the range would have
// lost real 2022 provenance AND re-wedged on the next chunk within one tick.
// See docs/handoff-2026-08-07-pack-opens-history-backfill-wedge.md.
//
// Re-run this before acting on ANY spork-routed cursor stall. It answers the
// only question that matters first: is the origin up?
//
// It ALWAYS probes a known-good band as a positive control, because an
// all-fail probe with no control proves nothing about the upstream — only that
// something, somewhere, failed.
//
// Usage:  node scripts/probe-spork-bands.mjs
// Reads SPORK_PROXY_URL + SPORK_PROXY_SECRET from .env.local (or the env).
// Never prints the secret. Read-only: issues GETs, writes nothing.

import fs from "node:fs"
import path from "node:path"

const OPENED = "A.0b2a3299cc857e29.PackNFT.Opened"
const PROBE_BLOCKS = 25
const TIMEOUT_MS = 20_000

// Mirrors SPORK_MAX_HEIGHTS + SPORK_FLOOR in
// supabase/functions/ingest-topshot-pack-opens-history/index.ts.
const SPORK_FLOOR = 27_341_470
const SPORK_MAX_HEIGHTS = [
  31_735_954, 35_858_810, 40_171_633, 44_950_206, 47_169_686, 55_114_466,
  65_264_618, 85_981_134, 88_226_266, 130_290_658, 137_390_145,
]

function loadEnv() {
  const out = { ...process.env }
  const envPath = path.join(process.cwd(), ".env.local")
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  }
  return out
}

const env = loadEnv()
const SPORK_URL = (env.SPORK_PROXY_URL ?? "").replace(/\/+$/, "")
const SPORK_SECRET = env.SPORK_PROXY_SECRET ?? ""

if (!SPORK_URL || !SPORK_SECRET) {
  console.error("SPORK_PROXY_URL / SPORK_PROXY_SECRET not set (checked env + .env.local).")
  process.exit(2)
}

async function probe(lo, hi) {
  const url = `${SPORK_URL}/?event_type=${encodeURIComponent(OPENED)}&start_height=${lo}&end_height=${hi}`
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${SPORK_SECRET}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, why: String(e?.name ?? e) }
  }
}

// Positive control FIRST: if the worker itself is unreachable, every band result
// below is meaningless and we must say so rather than report "all sporks down".
const rootT0 = Date.now()
let rootOk = false
try {
  const r = await fetch(`${SPORK_URL}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  rootOk = r.ok
  console.log(`spork-proxy worker root: status=${r.status} ${Date.now() - rootT0}ms`)
} catch (e) {
  console.log(`spork-proxy worker root: THREW ${String(e?.name ?? e)} ${Date.now() - rootT0}ms`)
}
if (!rootOk) {
  console.error("\nWorker root is unreachable — cannot distinguish 'sporks down' from 'no egress'.")
  console.error("Fix connectivity first; band results below would be uninterpretable.")
  process.exit(3)
}

const bands = []
let lo = SPORK_FLOOR
for (const hi of SPORK_MAX_HEIGHTS) {
  bands.push([lo, hi])
  lo = hi + 1
}

console.log(`\nProbing ${bands.length} historical spork bands (${PROBE_BLOCKS} blocks each)…\n`)
const dead = []
const alive = []
for (const [blo, bhi] of bands) {
  const res = await probe(bhi - (PROBE_BLOCKS - 1), bhi)
  const tag = res.ok ? "UP  " : "DOWN"
  console.log(
    `${tag} band ${String(blo).padStart(10)} - ${String(bhi).padStart(10)}  ` +
      `status=${String(res.status).padEnd(3)} ${String(res.ms).padStart(6)}ms${res.why ? ` (${res.why})` : ""}`
  )
  ;(res.ok ? alive : dead).push([blo, bhi])
}

console.log(`\n${alive.length}/${bands.length} bands UP, ${dead.length} DOWN.`)
if (dead.length === 0) {
  console.log("All historical sporks reachable — a cursor stall here is NOT an upstream outage.")
} else if (alive.length === 0) {
  console.log("Every band down despite a healthy worker root — treat as a full spork-origin outage.")
} else {
  const line = dead[dead.length - 1][1]
  console.log(`Highest dead band top: ${line}. Bands above it answer; at/below it do not.`)
  console.log("A cursor held below that line is CORRECT behaviour — do not skip the range.")
}
// Exit 1 when anything is down so this can gate a check without parsing stdout.
process.exit(dead.length > 0 ? 1 : 0)
