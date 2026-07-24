import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — PostgREST 1000-row cap regression pins.
//
// PostgREST caps every read at 1000 rows and CLAMPS an explicit `.limit(N>1000)`
// down to 1000; a *bare* unbounded `.select()` clamps at 1000 too. Reading raw
// `fmv_snapshots` ordered `computed_at DESC` and de-duping latest-per-edition in
// JS is the classic trap — ~4,200 TS snapshots/day means the 1000-row window
// only covers a few hundred editions, so editions past the window silently
// vanish. The count-vs-length trap is the sibling: request `{count:"exact"}`
// then read `rows.length` for a total and the "total" silently caps at 1000.
//
// This class bit production at least four times (CLAUDE.md 2026-07-19/20):
//   - rtr/lock-roi whale wmc ranked over only the first 1000 of a wallet's moments
//   - profile/watchlist + watchlist dropped FMV/floor for collectors past the cap
//     (a null floor there also makes `below_target` read false — alerts stop firing)
//   - concierge FMV distribution dropped ~34% of editions from p10/p50/p90
//   - market/loadEditionLookup mapped only 1000 of ~19k TS editions (null links + no badges)
//   - profile/market-pulse `snapshotsToday` reported 4,243 as exactly 1000 (count-vs-length)
//   - sets-db accumulator never called `.set()` → 0 owned / 0% completion for 3 months
//
// Each was fixed by switching to the `fmv_current` view (DISTINCT ON
// (edition_id) latest, <=1 row/edition), `.range()` pagination, or reading the
// returned `count` with `head:true`. This guard reads each fixed route/lib
// source and asserts the safe pattern is still present, so a refactor that
// reintroduces the raw-DESC / length-as-total read fails here instead of in prod.

const REPO = process.cwd()
const read = (...p: string[]) => readFileSync(path.join(REPO, ...p), "utf8")

describe("invariant: PostgREST 1000-row cap fixes stay fixed", () => {
  it("rtr/lock-roi reads current FMV from fmv_current and pages wmc with .range()", () => {
    const src = read("app", "api", "rtr", "lock-roi", "route.ts")
    // latest-per-edition FMV must come from the DISTINCT ON view, not a raw
    // fmv_snapshots DESC scan that clamps at 1000.
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
    // the whale-wmc read must paginate, or a 5,320-moment wallet is ranked over
    // only its first 1000 moments.
    expect(src).toMatch(/\.range\(/)
  })

  it("profile/watchlist reads FMV from fmv_current (no size-cap on a watchlist)", () => {
    const src = read("app", "api", "profile", "watchlist", "route.ts")
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
  })

  it("watchlist reads FMV from fmv_current (no size-cap on a watchlist)", () => {
    const src = read("app", "api", "watchlist", "route.ts")
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
  })

  it("concierge FMV distribution reads the multi-edition set from fmv_current", () => {
    const src = read("lib", "concierge", "fmv-distribution.ts")
    // the distribution (many-edition) path must use fmv_current; the single
    // edition path legitimately keeps a raw fmv_snapshots read with .limit(1).
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
    expect(src).toMatch(/\.limit\(\s*1\s*\)/)
  })

  it("profile/market-pulse counts snapshots via count+head, never rows.length", () => {
    const src = read("app", "api", "profile", "market-pulse", "route.ts")
    // must request an exact head count and assign from `count`, not `.length`.
    expect(src).toMatch(/count:\s*["']exact["']/)
    expect(src).toMatch(/head:\s*true/)
    expect(src).toMatch(/snapshotsToday\s*=\s*count\s*\?\?\s*0/)
    // guard the specific regression: snapshotsToday must never be set from a
    // .length read of a fetched snapshot array.
    expect(src).not.toMatch(/snapshotsToday\s*=\s*\w*[Ss]naps?\w*\.length/)
  })

  it("market/loadEditionLookup pages the full catalog with .range() (not a 1000-row slice)", () => {
    const src = read("app", "api", "market", "route.ts")
    expect(src).toMatch(/function loadEditionLookup/)
    // the lookup builder must paginate; a bare .select() would map only 1000 of ~19k editions.
    expect(src).toMatch(/\.range\(/)
  })

  it("sets-db writes the owned-by-set accumulator back into the Map (.set())", () => {
    const src = read("app", "api", "sets-db", "route.ts")
    // the 3-month 0%-completion bug: the code built `const list = map.get(id) ?? []`
    // and pushed, but never `map.set(id, list)`, so a fresh key was discarded.
    expect(src).toMatch(/ownedBySet\.set\(/)
  })
})
