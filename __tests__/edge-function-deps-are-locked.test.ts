import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE-DENO JOB MUST NOT DEPEND ON THE WALL CLOCK.
//
// `Edge functions (deno check + lint)` failed once in its last 60 runs, at
// 2026-09-03T06:04:15Z, and passed on a re-run minutes later with no code
// change. That shape reads as a flake and is not one — it is a resolution race
// with a known, dated mechanism:
//
//   `supabase/functions/deno.json` maps `@supabase/supabase-js` to
//   `jsr:@supabase/supabase-js@2` — a FLOATING major. With no lockfile the job
//   re-resolved that graph from scratch on every run. Deno refuses any version
//   published inside its minimum-dependency-age window (DEFAULT 24 h) and, once
//   it has chosen the newest aged-in parent, it does NOT backtrack to an older
//   one when a required sub-dependency is still too young. supabase-js 2.113.0
//   aged in at 06:04:34Z; its own auth-js 2.113.0 aged in at 06:05:01Z. For
//   those 27 seconds there was no resolvable graph at all, and the job that ran
//   inside them was a hard error.
//
// ⚠ SO THE WINDOW IS NOT REMOVABLE BY TUNING THE THRESHOLD. Any non-zero age
// has a boundary, and the sub-package skew straddles it wherever it sits. Only
// two things remove it: disabling the policy (a real supply-chain downgrade,
// and it would apply to `supabase functions deploy` too), or not re-resolving.
// The lockfile is the second.
//
// ⭐ MEASURED, BOTH DIRECTIONS, with Deno 2.9.6 — this is the control, and it is
// re-runnable against any package that has published inside the last 24 h:
//
//   no lock, version 11 h old, required exactly  →  hard error, and the hint
//     names the policy ("blocked by the minimum dependency age policy").
//   lock pinning that same 11-h-old version, via
//     a FLOATING `^3` range, default policy      →  resolves, exit 0.
//
// The second half is the one that matters: the lock holds a floating specifier
// against re-resolution, which is exactly this repo's shape.
//
// ⚠ AND THE DECISION THIS OVERTURNED WAS A FILED ONE. `.gitignore` carried
// "Deliberately NOT committed: … adding it introduces a lock-mismatch failure
// mode on remote-dep drift for a gate that is now blocking." That cost is
// stated with no number in it, and it does not materialise: the job does not
// run `--frozen`, so a drifted lock is REWRITTEN, not rejected. This file
// exists so the lock cannot quietly go back to being ignored.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const LOCK = path.join(ROOT, "supabase", "functions", "deno.lock")
const CONFIG = path.join(ROOT, "supabase", "functions", "deno.json")
const CI = path.join(ROOT, ".github", "workflows", "ci.yml")

describe("the edge-function dependency graph is locked, not re-resolved every run", () => {
  it("the lockfile is committed and parses", () => {
    expect(existsSync(LOCK), "supabase/functions/deno.lock is missing — the job is wall-clock dependent again").toBe(true)
    expect(() => JSON.parse(readFileSync(LOCK, "utf8"))).not.toThrow()
  })

  it("is not gitignored", () => {
    // The ignore rule stood for months and is the single change that would
    // silently restore the defect: the file would still exist on every machine
    // that ran `deno check`, so nothing else here would notice.
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8")
    const active = ignore
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
    expect(active, "deno.lock is ignored again — see this file's header for why it is committed").not.toContain(
      "supabase/functions/deno.lock",
    )
  })

  it("PINS THE TRANSITIVE DEPENDENCY THAT ACTUALLY BROKE, not just the top-level one", () => {
    // The top-level specifier was never the problem — supabase-js had already
    // aged in. A lock that covered only what deno.json names would leave the
    // exact failure in place, so assert the sub-dependency by name.
    const lock = JSON.parse(readFileSync(LOCK, "utf8"))
    const packages = Object.keys(lock.npm ?? {})
    expect(packages.some((p) => p.startsWith("@supabase/auth-js@"))).toBe(true)
    expect(Object.keys(lock.specifiers ?? {})).toContain("jsr:@supabase/supabase-js@2")
  })

  it("is not vacuous — every specifier deno.json declares is resolved in the lock", () => {
    // A one-line lock would satisfy every assertion above. Tie the lock to the
    // config: each bare-specifier target must appear as a resolved specifier or
    // as a remote URL, so dropping a package from the lock fails here.
    const config = JSON.parse(readFileSync(CONFIG, "utf8"))
    const lock = JSON.parse(readFileSync(LOCK, "utf8"))
    const resolved = new Set([...Object.keys(lock.specifiers ?? {}), ...Object.keys(lock.remote ?? {})])
    const targets: string[] = Object.values(config.imports ?? {})
    expect(targets.length, "deno.json declares no imports — re-derive this test").toBeGreaterThan(0)
    for (const t of targets) {
      const hit = [...resolved].some((r) => r === t || t.startsWith(r) || r.startsWith(t))
      expect(hit, `${t} is declared in deno.json but absent from deno.lock — re-run deno cache`).toBe(true)
    }
  })

  it("CI does not paper over the policy instead of locking", () => {
    // The one-line alternative was `--min-dep-age=0` / "minimumDependencyAge",
    // which would fix the red and remove a supply-chain protection that also
    // covers `supabase functions deploy`. If someone reaches for it later, this
    // says why it was not the answer.
    const ci = readFileSync(CI, "utf8")
    const cfg = readFileSync(CONFIG, "utf8")
    expect(ci).not.toMatch(/--min(imum)?-dep(endency)?-age/)
    expect(cfg).not.toMatch(/minimumDependencyAge/)
  })

  it("CI does not run the check --frozen", () => {
    // NO-CHANGE CONTROL for the concern the old .gitignore rule raised: the
    // committed lock must stay a floor, not a gate. `--frozen` would turn
    // ordinary dep drift into a red blocking job, which is the failure mode
    // that argued against committing a lock in the first place.
    const ci = readFileSync(CI, "utf8")
    expect(ci).not.toMatch(/deno (check|cache)[^\n]*--frozen/)
  })
})
