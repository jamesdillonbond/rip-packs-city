import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// RATCHET: an `after()` route with a `maxDuration` must not make an UNBOUNDED
// `fetch()`. Down only.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `fetch()` has NO default timeout. In an ordinary request handler an upstream
// that accepts the connection and holds it open is merely slow. In an `after()`
// route with a `maxDuration` it is INVISIBLE:
//
//   the lambda is killed at maxDuration -> neither the success path nor the
//   catch runs -> NO terminal `pipeline_runs` row is written at all
//
// so the outage is indistinguishable from "the cron never fired". Measured on
// /api/candy-listings-indexer 2026-08-27: 15 invocation heartbeats against ONE
// terminal row in 48h, a Vercel `Task timed out after 300 seconds`, and the
// PUBLIC /insights/candy-mlb board serving asks 44 HOURS stale.
//
// ⭐ The fix already existed one file away and had never spread — `solUsd()` in
// lib/chains/solana/das.ts carries an 8s cap and a comment naming this exact
// failure mode. This repo's rule is "when you find one, grep for the EXPRESSION,
// not the file"; this guard is that grep, made permanent, because the thing that
// failed to spread was the FIX.
//
// ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
// A ban is not satisfiable today: the population was 29 sites when first
// measured. A ban would have to be paired with a 29-site scripted edit, and the
// correct timeout is NOT a constant — some calls are internal, some sit inside
// an already-bounded caller, some upstreams are legitimately slow and a short
// cap would convert working behaviour into failure. So: no NEW instances, and
// the number only goes down. Full triage table:
// docs/overnight/inbox/2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-carry-the-shape-whose-failure-is-invisible.md
//
// ⚠ LOWER THIS when you bound a call. A ratchet that never falls is measuring
// something else — this repo has been bitten by exactly that.
// ─────────────────────────────────────────────────────────────────────────────

const API_DIR = join(process.cwd(), "app", "api")

/**
 * Current count of unbounded `fetch(` sites in `after()` + `maxDuration` routes.
 *
 * **21** as of 2026-08-27, after that evening bounded candy-listings,
 * candy-sales (+ the shared `dasCall`), sales-indexer, alerts-send,
 * check-alerts, and all FOUR `*-listing-cache` routes.
 *
 * ⚠ Do NOT compare this to the "29" quoted in the inbox filing. That figure came
 * from the ad-hoc regex sweep this file replaced, which required `;` or a
 * newline after the call and therefore MISSED some formatting variants entirely
 * (`support-chat`, `smoke-test` and `golazos-listing-cache` were invisible to
 * it). The two numbers count different things; only this one is
 * detector-verified. **A count is only as trustworthy as the detector that
 * produced it, and the ad-hoc one was never shown a known offender.**
 *
 * ⛔ DOWN ONLY. If this needs to go UP, the change is adding a new invisible
 * failure mode — bound the call instead.
 */
const RATCHET = 21

// ⚠ `stripComments` is IMPORTED from scripts/lib/strip-comments.mjs, never re-implemented.
// It is load-bearing here twice over: without it the comment ABOVE a bounded
// fetch explaining its AbortSignal would make an UNBOUNDED sibling look bounded,
// and a comment merely mentioning `fetch(` would be counted as a call site.
// A local copy is also banned outright by
// __tests__/guards-use-the-shared-comment-stripper.test.ts (MAX_LOCAL_STRIPPERS,
// down only) — a hand-rolled stripper once blanked 100k+ chars of real source
// and hid a live P0. That guard caught this file writing its own.

/** Every route file under app/api, at any depth, forward-slashed. */
function allRoutes(dir: string = API_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) allRoutes(full, out)
    // ⚠ Normalised to forward slashes: every consumer matches on "/api/..."
    // literals, and join() yields backslashes on Windows — which has previously
    // made a guard's not-vacuous check unsatisfiable there, i.e. green in CI and
    // structurally dead on the primary dev machine.
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full.split(sep).join("/"))
  }
  return out
}

/** Is this route the dangerous shape — deferred work under a hard ceiling? */
export function isAfterRouteWithCeiling(code: string): boolean {
  return /\bafter\s*\(/.test(code) && /\bmaxDuration\s*=\s*\d+/.test(code)
}

/**
 * Count `await fetch(...)` calls whose init carries no abort signal.
 *
 * ⚠ Matches the INIT OBJECT, not the surrounding file: a route with one bounded
 * and one unbounded call must count exactly one. That is not hypothetical —
 * app/api/topshot-listing-cache has two fetches with different upstreams.
 */
export function countUnboundedFetches(code: string): number {
  let n = 0
  const start = /\bfetch\s*\(/g
  let m: RegExpExecArray | null
  while ((m = start.exec(code))) {
    // ⚠ BALANCE THE PARENS — do not regex the call's extent.
    //
    // 🚨 The first version of this used `/await\s+fetch\s*\(([\s\S]{0,400}?)\)\s*(?:;|\n)/`,
    // requiring a `;` or newline after the closing paren. That matched every
    // real file (they are formatted that way) and MISSED `await fetch(u, {...}) })`
    // — i.e. the detector's accuracy depended on downstream formatting. The
    // synthetic fixture below caught it; no amount of running it against the
    // repo would have, because the repo happens to be formatted agreeably.
    // **A detector validated only against the population it measures cannot
    // report its own blind spot.**
    let depth = 0
    let i = m.index + m[0].length - 1 // at the '('
    for (; i < code.length; i++) {
      const c = code[i]
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0) break
      }
    }
    const args = code.slice(m.index, i + 1)
    // ⚠ A zero-argument `fetch()` is never a real call site — a real one always
    // carries a URL. Skipping it is not a cosmetic filter: it makes this count
    // independent of whether comment-stripping succeeded.
    //
    // 🚨 That independence is load-bearing, because stripping is NOT reliable
    // here. The SHARED stripper (scripts/lib/strip-comments.mjs, mandatory per
    // guards-use-the-shared-comment-stripper) leaves the `//` line
    //     // `fetch()` has no default timeout ...
    // INTACT in app/api/check-alerts/route.ts, while blanking the identical line
    // in isolation and in every other file here. So a comment DOCUMENTING this
    // very fix was being counted as an unbounded call site — the trap this repo
    // has hit at least six times, arriving through the shared helper rather than
    // around it. Filed separately; this guard is made immune instead of relying
    // on the fix.
    if (/^fetch\s*\(\s*\)$/.test(args.trim())) {
      start.lastIndex = i + 1
      continue
    }
    if (!/AbortSignal|signal\s*:/.test(args)) n++
    start.lastIndex = i + 1
  }
  return n
}

function offenders(): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = []
  for (const p of allRoutes()) {
    const code = stripComments(readFileSync(p, "utf8"))
    if (!isAfterRouteWithCeiling(code)) continue
    const n = countUnboundedFetches(code)
    if (n > 0) out.push({ file: p.replace(process.cwd().split(sep).join("/") + "/", ""), count: n })
  }
  return out.sort((a, b) => b.count - a.count)
}

describe("an after() route with a maxDuration must not make an unbounded fetch", () => {
  it("the walk finds routes at all (not vacuously passing)", () => {
    // If the walk returns nothing, the ratchet passes for free forever.
    const all = allRoutes()
    expect(all.length).toBeGreaterThan(100)
    expect(all.some((p) => p.includes("/api/candy-listings-indexer/"))).toBe(true)
  })

  it("the shape filter actually selects a subset (not everything, not nothing)", () => {
    const all = allRoutes()
    const inScope = all.filter((p) => isAfterRouteWithCeiling(stripComments(readFileSync(p, "utf8"))))
    expect(inScope.length).toBeGreaterThan(5)
    expect(inScope.length).toBeLessThan(all.length)
  })

  it("the detector works, proven on synthetic fixtures rather than assumed", () => {
    // ⚠ A counting guard that has never been shown a known offender is a guess.
    const bounded = `export const maxDuration = 60
      after(async () => { const r = await fetch(u, { signal: AbortSignal.timeout(5) }) })`
    const unbounded = `export const maxDuration = 60
      after(async () => { const r = await fetch(u, { method: "POST" }) })`
    const mixed = `export const maxDuration = 60
      after(async () => {
        const a = await fetch(u1, { signal: AbortSignal.timeout(5) })
        const b = await fetch(u2, { method: "POST" })
      })`
    expect(isAfterRouteWithCeiling(bounded)).toBe(true)
    expect(countUnboundedFetches(bounded)).toBe(0)
    expect(countUnboundedFetches(unbounded)).toBe(1)
    // The per-call property, not a per-file one.
    expect(countUnboundedFetches(mixed)).toBe(1)
    // A route without the shape is out of scope even when unbounded.
    expect(isAfterRouteWithCeiling(`const r = await fetch(u)`)).toBe(false)

    // A zero-arg `fetch()` — how the word appears in PROSE — is never a call
    // site. Pinned because comment-stripping is not reliable enough to lean on:
    // the shared stripper leaves exactly this line intact in check-alerts.
    expect(countUnboundedFetches(`// see \`fetch()\` for why`)).toBe(0)
    expect(countUnboundedFetches(`const r = await fetch()`)).toBe(0)
  })

  it("comments cannot mask or manufacture a call site", () => {
    // Both halves have burned this repo: a comment satisfying a guard, and a
    // guard's population being selected from commented text.
    const commentedOut = `export const maxDuration = 60
      after(async () => {
        // const r = await fetch(u, { method: "POST" })
        const r = await fetch(u, { signal: AbortSignal.timeout(5) })
      })`
    expect(countUnboundedFetches(stripComments(commentedOut))).toBe(0)

    const explainedButUnbounded = `export const maxDuration = 60
      after(async () => {
        // We deliberately pass signal: AbortSignal.timeout(5) elsewhere.
        const r = await fetch(u, { method: "POST" })
      })`
    expect(
      countUnboundedFetches(stripComments(explainedButUnbounded)),
      "a comment mentioning AbortSignal must not make an unbounded call look bounded",
    ).toBe(1)
  })

  it(`has no more than ${RATCHET} unbounded fetch sites in after()+maxDuration routes`, () => {
    const found = offenders()
    const total = found.reduce((s, f) => s + f.count, 0)
    expect(
      total,
      `Unbounded fetch sites in after()+maxDuration routes: ${total} (ratchet ${RATCHET}).\n` +
        `An unbounded fetch here is INVISIBLE: a maxDuration kill writes no terminal\n` +
        `pipeline_runs row, so the outage reads as "the cron never fired".\n` +
        `Add \`signal: AbortSignal.timeout(ms)\`, sized for that upstream.\n` +
        `If a paginating loop is involved, a per-request cap is NOT enough on its own —\n` +
        `N pages x the cap can still exceed maxDuration, so it needs a whole-sweep\n` +
        `deadline too, sized off the OBSERVED success band and never off maxDuration.\n\n` +
        found.map((f) => `  ${String(f.count).padStart(2)}  ${f.file}`).join("\n"),
    ).toBeLessThanOrEqual(RATCHET)
  })

  it("the ratchet is not slack — lower it when the count falls", () => {
    // A ratchet parked far above the real count silently stops guarding. If this
    // fails, the fixes already landed: set RATCHET to the reported number.
    const total = offenders().reduce((s, f) => s + f.count, 0)
    expect(
      total,
      `RATCHET is ${RATCHET} but only ${total} sites remain — lower RATCHET to ${total}.`,
    ).toBeGreaterThanOrEqual(RATCHET)
  })
})
