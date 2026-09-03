import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"

// BAN AT ZERO — no server page may stamp a board "Updated <now>" from the render
// clock without first checking that the read SUCCEEDED.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// `initialFetchedAt={new Date().toISOString()}` is a claim about the DATA's
// freshness manufactured from OUR clock. On a successful read it is true and
// useful. On a FAILED read it told the reader our numbers were current at the
// very moment the board had none — the fabricated-number family, applied to a
// timestamp instead of a count.
//
// Found 2026-09-02 on SEVEN public /insights boards at once, every one of which
// ALREADY passed a degraded flag beside it. That is the point: each page carried
// an honest `initialDegraded`/`loadError` and an unconditional freshness stamp in
// the same JSX block, so the board rendered "Updated just now" directly above
// "we couldn't load this". ⭐ **A page with one honest error branch is not an
// honest page — fix per PANEL.**
//
// The fix is `ok ? new Date().toISOString() : null`. `FreshnessStamp` already
// renders null as "—" and its own doc fixes that as meaning "no timestamp was
// supplied", which is the true statement when the read failed.
//
// ⚠ ASSERTS THE PROPERTY, NOT THE SPELLING: any conditional is accepted, so a
// rewrite that carries the read's real `computed_at` keeps passing. What is
// banned is the UNGUARDED clock.

const ROOT = "app"
/** `initialFetchedAt={new Date()…}` with nothing between `=` and `new`. */
const UNGUARDED = /initialFetchedAt=\{\s*new Date\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

function pagesWithAStamp(): string[] {
  return walk(path.join(process.cwd(), ROOT))
    .filter((f) => readFileSync(f, "utf8").includes("initialFetchedAt="))
    .map((f) => path.relative(process.cwd(), f))
}

describe("a freshness stamp is not minted from a failed read", () => {
  it("inspects the pages it claims to — a walk that found nothing would pass vacuously", () => {
    // ⚠ The count is the assertion that this guard RAN. A bad root or extension
    // filter returns [] and the ban below passes over an empty set.
    const pages = pagesWithAStamp()
    expect(pages.length).toBeGreaterThanOrEqual(7)
  })

  it("no page stamps the render clock unconditionally", () => {
    const offenders = pagesWithAStamp().filter((f) => UNGUARDED.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })

  it("POSITIVE CONTROL: the matcher catches the shape that shipped, and clears the fix", () => {
    // Quoted from the code as it stood before 2026-09-02.
    expect(UNGUARDED.test(`initialFetchedAt={new Date().toISOString()}`)).toBe(true)
    // …and accepts a guarded stamp, so the ban is not simply always-true.
    expect(UNGUARDED.test(`initialFetchedAt={ok ? new Date().toISOString() : null}`)).toBe(false)
    expect(UNGUARDED.test(`initialFetchedAt={!loadError ? new Date().toISOString() : null}`)).toBe(false)
    // …and a real data timestamp, the better fix, is not flagged either.
    expect(UNGUARDED.test(`initialFetchedAt={row?.computed_at ?? null}`)).toBe(false)
  })
})
