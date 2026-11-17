#!/usr/bin/env node
// Compare every DB-invariant pin against the LIVE database definition.
//
// WHY THIS EXISTS, and why the blocking CI guard is not enough:
//
// __tests__/db-invariants-drift-guard.test.ts asserts that a supabase/tests/*.sql
// file's embedded DDL matches THE MIGRATION ITS PINS ENTRY NAMES. That keeps the
// copy honest against the repo, but it says nothing about production: if the
// function was later redefined and the new definition was applied via MCP without
// being committed as a migration file, the pin, the test, and the guard all stay
// green while the test validates a definition that no longer runs anywhere.
//
// That is not hypothetical. On 2026-07-31 three pins were in exactly that state:
//   promote_unmapped_sales               — pinned 3 months behind live
//   fmv_clamp_disconnected_ask_topshot   — pinned to a superseded clamp predicate
//   compute_pack_ev_per_edition_weighted — pinned ~2 weeks behind live
// and for the latter two the repo carried exactly ONE migration defining the
// function, so "does the pin name the newest committed migration?" answers green.
// Only the live DB can answer this.
//
// Usage:
//   node scripts/check-db-pin-staleness.mjs          # report + non-zero exit if stale
//   node scripts/check-db-pin-staleness.mjs --json   # machine-readable
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from .env.local
// if not already in the environment). Reads only pg_proc — it mutates nothing.

import { readFileSync, existsSync } from 'fs'
import { resolve, basename } from 'path'
import { createClient } from '@supabase/supabase-js'

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
const GUARD = '__tests__/db-invariants-drift-guard.test.ts'

// Pinned functions that are deliberately NOT deployed. Reported, but they do not
// fail the check — otherwise the exit code is red forever and stops meaning
// anything. Two-way, like RAW_FMV_DESC_ALLOWLIST: if one of these turns up live
// again the entry is stale and the check fails, so the list cannot rot silently.
//
// Currently EMPTY, deliberately. Its one entry (compute_listing_divergence) was
// removed on 2026-07-31 along with the pin itself: a green test for a function
// that exists in no schema, no function body, no view and no cron job asserts
// nothing — it is a test that cannot fail. Prefer deleting such a pin over
// excusing it here; this allowlist is for a function that is genuinely pending
// deployment, not one that has been retired.
const NOT_DEPLOYED_OK = {}

// ── the pin list, parsed from the guard so the two can never diverge ─────────
function readPins() {
  const src = readFileSync(resolve(process.cwd(), GUARD), 'utf-8')
  // `[\s\S]*?` (non-greedy) between the fields tolerates comment lines a PINS
  // entry may carry between test: and migration: — e.g. a "re-pointed 2026-…"
  // note explaining why the pin moved. The old `\s*\n\s*`-only pattern required
  // the three fields on strictly adjacent lines, so it SILENTLY dropped any
  // commented entry from the check (get_wallet_moments_with_fmv + get_team_detail
  // were both invisible to the live-drift check for exactly this reason, found
  // 2026-08-08). Non-greedy stops at the first test:/migration: after each fn:,
  // so it can't bleed into the next object. __tests__/db-pin-staleness-parser-
  // coverage.test.ts asserts this regex captures EVERY pin the guard defines.
  const re = /fn:\s*"([^"]+)",[\s\S]*?test:\s*"([^"]+)",[\s\S]*?migration:\s*"([^"]+)",/g
  const pins = [...src.matchAll(re)].map((m) => ({ fn: m[1], test: m[2], migration: m[3] }))
  if (pins.length === 0) throw new Error(`parsed 0 pins from ${GUARD} — has the PINS shape changed?`)
  return pins
}

// ── DDL extraction, mirroring the guard's own parser ─────────────────────────
// Skips `CREATE OR REPLACE FUNCTION` occurrences that sit inside a `--` comment,
// since migrations routinely carry the prior version commented out in a note.
//
// ⚠ PROCEDURE, NOT JUST FUNCTION — and this parser is the SECOND copy.
// __tests__/db-invariants-drift-guard.test.ts hit exactly this bug and fixed it on
// 2026-08-16 (its FN_KINDS), recording that a FUNCTION-only needle "made every
// PROCEDURE in this database UNPINNABLE". This file's header says it mirrors that
// parser — and it did not get the same fix, so the mirror was broken for six days
// while the comment claiming the mirror sat right here.
//
// The consequence was NOT a loud failure. `reconcile_all_saved_wallet_stats` is a
// PROCEDURE, so its DDL could never be extracted, the pin reported
// NO_DDL_IN_MIGRATION every run, and — the part that matters — the live-drift
// comparison for it NEVER RAN. It writes the cached portfolio figures every
// collector sees on their saved wallets, and it was in the PINS array looking
// covered the whole time. A pin that cannot parse its own DDL asserts nothing.
const DDL_KINDS = ['FUNCTION', 'PROCEDURE']
function bodiesOf(src, name) {
  const out = []
  for (const kind of DDL_KINDS) bodiesOfKind(src, name, kind, out)
  return out
}
function bodiesOfKind(src, name, kind, out) {
  const needle = `CREATE OR REPLACE ${kind} public.${name}`
  let from = 0
  for (;;) {
    const i = src.indexOf(needle, from)
    if (i < 0) break
    const lineStart = src.lastIndexOf('\n', i) + 1
    if (!src.slice(lineStart, i).includes('--')) {
      const rest = src.slice(i)
      const tag = /\$([a-zA-Z_]*)\$/.exec(rest)
      if (tag) {
        const open = tag.index + tag[0].length
        const close = rest.indexOf(tag[0], open)
        if (close >= 0) out.push(rest.slice(open, close))
      }
    }
    from = i + needle.length
  }
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
const stripComments = (s) => s.replace(/--[^\n]*/g, '')
// Two normalizations. Live prosrc is frequently comment-stripped relative to the
// committed file (the definition was applied from an editor buffer, not the file),
// so a comments-included comparison alone reports drift that is purely cosmetic.
// A match under EITHER normalization means the logic is the same.
const variants = (s) => [collapse(s), collapse(stripComments(s))]

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const pins = readPins()
  const names = [...new Set(pins.map((p) => p.fn))]

  // One read. query_sql() is the service_role-only reader (execute_sql returns void).
  const { data, error } = await supabase.rpc('query_sql', {
    query: `SELECT p.proname AS fn,
                   pg_get_function_identity_arguments(p.oid) AS sig,
                   p.prosrc AS body
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND p.proname IN (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')})`,
  })
  if (error) {
    console.error('query_sql failed:', error.message)
    process.exit(2)
  }

  const live = new Map()
  for (const row of data ?? []) {
    if (!live.has(row.fn)) live.set(row.fn, [])
    live.get(row.fn).push(row)
  }

  const results = []
  for (const pin of pins) {
    const migPath = resolve(process.cwd(), pin.migration)
    if (!existsSync(migPath)) {
      results.push({ ...pin, status: 'MISSING_MIGRATION' })
      continue
    }
    const committed = bodiesOf(readFileSync(migPath, 'utf-8'), pin.fn)
    if (committed.length === 0) {
      results.push({ ...pin, status: 'NO_DDL_IN_MIGRATION' })
      continue
    }
    const overloads = live.get(pin.fn)
    const excused = Object.prototype.hasOwnProperty.call(NOT_DEPLOYED_OK, pin.fn)
    if (!overloads || overloads.length === 0) {
      // The pinned function is not deployed. The SQL test still passes (it creates
      // its own copy), so this is invisible without asking the database.
      results.push({
        ...pin,
        status: excused ? 'NOT_DEPLOYED_EXPECTED' : 'NOT_IN_LIVE_DB',
        note: excused ? NOT_DEPLOYED_OK[pin.fn] : undefined,
      })
      continue
    }
    if (excused) {
      // It came back. The allowlist entry is now a lie — fail so it gets removed.
      results.push({ ...pin, status: 'ALLOWLIST_STALE' })
      continue
    }
    const want = new Set(committed.flatMap(variants))
    const hit = overloads.find((o) => variants(o.body).some((v) => want.has(v)))
    results.push(
      hit
        ? { ...pin, status: 'OK', sig: hit.sig }
        : { ...pin, status: 'STALE', overloads: overloads.map((o) => o.sig) }
    )
  }

  const benign = new Set(['OK', 'NOT_DEPLOYED_EXPECTED'])
  const bad = results.filter((r) => !benign.has(r.status))

  if (JSON_OUT) {
    console.log(JSON.stringify({ checked: results.length, stale: bad.length, results }, null, 2))
  } else {
    for (const r of results) {
      if (r.status === 'OK') continue
      console.log(`${r.status.padEnd(22)} ${r.fn}`)
      console.log(`  pinned migration: ${basename(r.migration)}`)
      console.log(`  pinned test:      ${basename(r.test)}`)
      if (r.status === 'STALE') {
        console.log(`  → the live definition differs from the pinned copy.`)
        console.log(`    Capture it with pg_get_functiondef() into a snapshot migration,`)
        console.log(`    repoint the PINS entry, and re-check the test's ASSERTIONS —`)
        console.log(`    a stale pin usually means the assertions describe old behaviour.`)
        if (r.overloads?.length > 1) console.log(`    live overloads: ${r.overloads.join(' | ')}`)
      }
      if (r.status === 'NOT_IN_LIVE_DB') {
        console.log(`  → pinned function is not deployed. The pin asserts nothing about`)
        console.log(`    production; either the function was dropped or it never shipped.`)
        console.log(`    If that is intended, add it to NOT_DEPLOYED_OK with the reason.`)
      }
      if (r.status === 'NOT_DEPLOYED_EXPECTED') console.log(`  → known-retired: ${r.note}`)
      if (r.status === 'ALLOWLIST_STALE') {
        console.log(`  → listed in NOT_DEPLOYED_OK but it IS deployed now. Drop the entry`)
        console.log(`    so this pin goes back to being compared against live.`)
      }
      console.log('')
    }
    console.log(`checked ${results.length} pins — ${results.length - bad.length} clean, ${bad.length} needing attention`)
  }

  // Set exitCode rather than calling process.exit(): the supabase client keeps
  // handles open, and an abrupt exit trips a libuv assertion on Windows.
  process.exitCode = bad.length > 0 ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
