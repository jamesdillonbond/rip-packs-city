import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// BAN AT ZERO — every DB-invariant pin must name the NEWEST migration in the repo
// that defines its function. If a later migration redefines it, the pin is stale.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// On 2026-09-13 `rollup_allday_rip_pull_value` was pinned to 20260816080000 while
// THREE migrations redefined it that same day for the #92 decision (pull_value_usd
// became CURRENT fmv rather than the at-open value). None repointed the pin.
//
// ⚠ EVERY EXISTING INSTRUMENT REPORTED GREEN.
//   · db-invariants-drift-guard compares the pin to THE MIGRATION IT NAMES —
//     repo-vs-repo — so a pin pointing at a superseded migration agrees with it
//     perfectly. That is the check passing by construction.
//   · migration-parity checks the applied-but-NOT-committed direction.
//   · The SQL test itself passed, because it ran the body it pinned.
// Only the daily live sweep (scripts/check-db-pin-staleness.mjs) saw it, ~10 hours
// later, and only because it reads production. This test closes that window to the
// push that causes it, WITHOUT needing a database — which is the whole point: the
// live sweep needs SUPABASE_SERVICE_ROLE_KEY and cannot live in the blocking job.
//
// ⚠ WHAT IT DOES NOT CLAIM. "Newest file that defines it" is a repo-side PROXY for
// "what runs in production". It is wrong in one direction: a committed migration
// that was never applied would make a correct pin look stale. That case is an
// ALLOWLIST entry below, and the allowlist is TWO-WAY — an entry that stops
// violating fails too, so it cannot rot silently. It is currently EMPTY, which is
// the state to keep it in.
//
// ⚠ THE PIN REGEX IS COPIED FROM scripts/check-db-pin-staleness.mjs DELIBERATELY,
// non-greedy `[\s\S]*?` and all. An adjacency-only pattern SILENTLY drops pins
// carrying a comment between their fields — that bug hid two pins from the live
// check for an unknown period (found 2026-08-08), and it bit again in the first
// draft of THIS file, which parsed 179 of 202 and would have published a false
// zero. The count is asserted below so it can never happen quietly.
//
// ⚠ FUNCTION *AND* PROCEDURE. A FUNCTION-only needle "made every PROCEDURE in this
// database UNPINNABLE" when the sibling parser had it (fixed 2026-08-16). Same
// mistake was in this file's first draft.

// ⚠ KNOWN LIMIT, MEASURED RATHER THAN ASSUMED (2026-09-13). The definition scan
// strips `--` comments but NOT dollar-quoted blocks, so a `CREATE OR REPLACE
// FUNCTION` emitted as DYNAMIC SQL inside a `$$ ... $$` body counts as a
// definition here. Swept all migrations: exactly TWO such sites exist
// (`get_pipeline_alerts_core` in 20260905163444, `check_edge_fn_http_failures` in
// 20260911041900) and NEITHER function is pinned, so this cannot mis-point a pin
// today. It becomes live only if one of those is pinned later, or if a pinned
// function's definition is wrapped in dynamic SQL — at which point the fix is to
// exclude dollar-quoted spans from the scan, not to allowlist the function.
// Recorded so a future false positive reads as a known shape rather than a
// mystery.

const ROOT = join(__dirname, "..")
const GUARD = "__tests__/db-invariants-drift-guard.test.ts"
const MIGRATIONS = "supabase/migrations"

// Pins that deliberately do NOT name the newest defining migration, with the
// reason. Two-way: an entry that no longer violates is stale and fails.
const NOT_NEWEST_ALLOWED: Record<string, string> = {}

type Pin = { fn: string; test: string; migration: string }

function readPins(): Pin[] {
  const src = readFileSync(join(ROOT, GUARD), "utf-8")
  const re = /fn:\s*"([^"]+)",[\s\S]*?test:\s*"([^"]+)",[\s\S]*?migration:\s*"([^"]+)",/g
  return [...src.matchAll(re)].map((m) => ({ fn: m[1], test: m[2], migration: m[3] }))
}

/** fn name -> defining migration basenames, oldest first. */
function definitionsByFunction(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const files = readdirSync(join(ROOT, MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort()
  for (const f of files) {
    // Strip `--` comments: migrations routinely quote a prior version in a note,
    // and a commented-out definition is not a definition.
    const code = readFileSync(join(ROOT, MIGRATIONS, f), "utf-8").replace(/--[^\n]*/g, "")
    const re = /CREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/g
    for (const m of code.matchAll(re)) {
      const list = out.get(m[1]) ?? []
      if (list[list.length - 1] !== f) list.push(f)
      out.set(m[1], list)
    }
  }
  return out
}

describe("every DB-invariant pin names the newest migration that defines its function", () => {
  const pins = readPins()
  const defs = definitionsByFunction()

  // ⚠ ASSERT THE POPULATION. A parser that quietly matches a subset reads as
  // coverage while inspecting less than it claims — which is exactly how the
  // first draft of this file produced a clean-looking 179.
  it("parses every pin the drift guard defines", () => {
    expect(pins.length).toBeGreaterThan(150)
    const fnFields = readFileSync(join(ROOT, GUARD), "utf-8").match(/^\s*fn:\s*"/gm) ?? []
    expect(pins.length).toBe(fnFields.length)
  })

  it("finds migration definitions to compare against", () => {
    expect(defs.size).toBeGreaterThan(0)
  })

  it("has no pin pointing at a superseded migration", () => {
    const stale: string[] = []
    for (const p of pins) {
      const list = defs.get(p.fn)
      if (!list || list.length === 0) continue // covered by its own case below
      const newest = list[list.length - 1]
      const named = p.migration.split("/").pop()
      if (newest === named) continue
      if (p.fn in NOT_NEWEST_ALLOWED) continue
      // The message carries the REMEDY, not just the diagnosis: this guard fires
      // on the push that redefines a pinned function, which is very often a
      // different session's push, and re-pinning is a THREE-file change that is
      // not guessable from "stale pin".
      stale.push(
        `${p.fn}: pin names ${named}, but ${newest} also defines it. ` +
          `Re-pin, in ONE push: (1) copy the new DDL verbatim into ${p.test} between its ` +
          `">>> BEGIN verbatim"/"<<< END verbatim" markers, (2) repoint this entry's ` +
          `migration: field to ${newest}, (3) RE-CHECK THAT FILE'S ASSERTIONS — a stale pin ` +
          `usually means they describe the old behaviour, and its fixtures may not even run ` +
          `against the new body.`,
      )
    }
    expect(stale).toEqual([])
  })

  it("every pinned function is defined by at least one committed migration", () => {
    const missing = pins.filter((p) => !(defs.get(p.fn)?.length)).map((p) => p.fn)
    expect(missing).toEqual([])
  })

  // Two-way, so the allowlist cannot rot into permission.
  it("every allowlisted exception still actually violates", () => {
    const notViolating = Object.keys(NOT_NEWEST_ALLOWED).filter((fn) => {
      const pin = pins.find((p) => p.fn === fn)
      if (!pin) return true
      const list = defs.get(fn)
      if (!list?.length) return true
      return list[list.length - 1] === pin.migration.split("/").pop()
    })
    expect(notViolating).toEqual([])
  })
})
