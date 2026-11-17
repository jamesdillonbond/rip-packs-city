import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isPublicPath } from "@/proxy"

// COMPLETENESS: every anonymously-public /insights board must appear in the
// rendered-DOM monitor's page list.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// e2e/smoke.spec.ts is the ONLY detector this repo has for two classes:
//   • the 200-but-broken-DOM streaming shell (the API smoke gate reads JSON
//     from a route, never a rendered page), and
//   • React #418 hydration mismatch, which is unreachable in vitest BY
//     CONSTRUCTION — the whole toolchain runs on Node in UTC, so SSR and the
//     "client" render happen in the same zone and cannot disagree.
//
// Measured 2026-08-17: the list held **5 of 30** boards. Both recorded #418
// incidents (`/insights/first-mint`, `/insights/top-sales`) were on boards, and
// `first-mint` was NOT in the list when it shipped the defect. A monitor with a
// hand-maintained page list drifts silently, because nothing connects adding a
// board to adding a line here — the same curated-list failure this repo has
// paid for in the component gate's `include` and the R10 SEO guard.
//
// ── WHAT THIS DERIVES, AND WHAT IT DELIBERATELY DOES NOT DEMAND ────────────
// The population comes from walking `app/insights/*/page.tsx` and asking the
// REAL `isPublicPath` — not from a list restated here, so a new board is in
// scope the moment it exists.
//
// ⚠ IT IS BIDIRECTIONAL, DELIBERATELY, AND THAT IS WHAT MAKES A LAUNCH FLAG
// SAFE. `isPublicPath` consults PANINI_PUBLIC / CANDY_MLB_PUBLIC at import time,
// so the public set MOVES when a flag moves. A one-way "every public board is
// listed" check would go red in the slowest, least legible place — the 6-hourly
// live monitor, on a board that now 302s to /login and renders 0 chars, which is
// precisely the cry-wolf entry e2e/smoke.spec.ts already carries a long warning
// about. Asserting SET EQUALITY instead means flipping a flag either way fails
// HERE, in a blocking sub-second test that names the file to edit.
//
// ⚠ This also found that the stale half of the problem was real: the spec's
// comment claimed panini/candy were "deliberately omitted... until its flag
// stays flipped", and both flags had been `true` for weeks — so two live public
// boards sat outside the only monitor that can see them, protected by a comment
// that read like a decision.

const INSIGHTS_DIR = join(process.cwd(), "app", "insights")
const SMOKE_SPEC = join(process.cwd(), "e2e", "smoke.spec.ts")

export function boardSlugs(): string[] {
  return readdirSync(INSIGHTS_DIR)
    .filter((e) => statSync(join(INSIGHTS_DIR, e)).isDirectory())
    .filter((e) => {
      try {
        return statSync(join(INSIGHTS_DIR, e, "page.tsx")).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

export function smokePaths(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/path:\s*"([^"]+)"/g)) out.add(m[1])
  return out
}

describe("the rendered-DOM smoke covers every public /insights board", () => {
  it("the enumerator still finds the boards and the spec (not vacuously passing)", () => {
    // ⚠ Asserts on the two ENUMERATORS, never on how many boards are missing —
    // a not-vacuous check must be satisfiable at a population of ZERO missing,
    // which is where this now sits. A guard whose walk silently returned []
    // would otherwise pass forever over nothing.
    expect(boardSlugs().length).toBeGreaterThan(20)
    expect(smokePaths(readFileSync(SMOKE_SPEC, "utf8")).size).toBeGreaterThan(30)
  })

  it("every anon-public board is in the monitor's list", () => {
    const listed = smokePaths(readFileSync(SMOKE_SPEC, "utf8"))
    const missing = boardSlugs()
      .map((slug) => "/insights/" + slug)
      .filter((p) => isPublicPath(p, "GET"))
      .filter((p) => !listed.has(p))
    expect(
      missing.join("\n"),
      "public /insights boards outside the rendered-DOM monitor — add them to " +
        "e2e/smoke.spec.ts (this is the only detector for #418 and the blank-shell class):\n" +
        missing.join("\n"),
    ).toBe("")
  })

  it("and no GATED board is listed, so flipping a launch flag fails HERE and not on the live monitor", () => {
    const listed = smokePaths(readFileSync(SMOKE_SPEC, "utf8"))
    const gatedButListed = boardSlugs()
      .map((slug) => "/insights/" + slug)
      .filter((p) => !isPublicPath(p, "GET"))
      .filter((p) => listed.has(p))
    expect(
      gatedButListed.join("\n"),
      "these boards are gated by a launch flag but are still in the live monitor — " +
        "anonymously they 302 to /login and render 0 chars, which reds the monitor on every " +
        "run. Remove them from e2e/smoke.spec.ts in the same commit that flips the flag:\n" +
        gatedButListed.join("\n"),
    ).toBe("")
  })

  it("the hub itself is covered", () => {
    expect(smokePaths(readFileSync(SMOKE_SPEC, "utf8")).has("/insights")).toBe(true)
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────

  it("the path extractor reads the spec's real shape, and only paths", () => {
    const sample = [
      '  { path: "/insights/squeeze", name: "insights · squeeze" },',
      '  { path: "/", name: "marketing home", expectText: /x/i },',
      "  // { path: \"/insights/commented-out\", name: \"x\" },",
    ].join("\n")
    const got = smokePaths(sample)
    expect(got.has("/insights/squeeze")).toBe(true)
    expect(got.has("/")).toBe(true)
    // ⚠ A commented-out entry still parses as listed. Recorded rather than
    // fixed: this guard's job is to notice a board that was never added, and a
    // deliberately commented-out line is a decision someone made in the file.
    // Do not "harden" this into a comment-stripping pass without deciding what
    // a commented entry should MEAN.
    expect(got.has("/insights/commented-out")).toBe(true)
  })

  it("uses the real isPublicPath, which discriminates", () => {
    // Without this, a stubbed/always-true predicate would leave the demand
    // vacuous in one direction and the guard would still read green.
    expect(isPublicPath("/insights/squeeze", "GET")).toBe(true)
    expect(isPublicPath("/dashboard", "GET")).toBe(false)
  })
})
