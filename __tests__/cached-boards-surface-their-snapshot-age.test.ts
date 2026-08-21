import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

// `degradedFromSource` deliberately returns NO notice for `source: "stale-cache"`,
// and the reason it gives is a claim about OTHER files:
//
//   "`stale-cache` is deliberately NOT degraded: it serves COMPLETE last-good data
//    carrying its own `fetchedAt`/`cache_stale` meta, which the clients already
//    surface as an age."
//
// That claim was FALSE for two of the five boards when it was written. /insights/rookies
// and /insights/first-mint both built `meta.fetched_at` into their payload and neither
// rendered it, so a snapshot served by the stale-cache leg reached the reader with no
// banner AND no timestamp — indistinguishable from live data. Measured 2026-08-21 over
// 509 warm ticks / 48h: `deals` failed 78.2% of refreshes (worst snapshot 15.1h old),
// `first-mint` 63.7% (worst 5.6h). The stale leg is the NORMAL path on this estate,
// not an edge case.
//
// So the suppression is only honest while every board on that ladder shows its age.
// This guard makes that a checked property instead of a comment. The population is
// DERIVED — every app/insights/<board>/page.tsx that calls readBoardOrLive — so a new
// cached board is enrolled by existing, not by someone remembering to edit a list.
//
// What this does NOT prove: that the rendered timestamp is CORRECT, or that the reader
// understands 6h-old data is a problem. It proves only that the age is on screen. The
// "should a 15h snapshot also carry a banner?" question is a product decision and is
// filed, not decided here.

const INSIGHTS_DIR = path.resolve(__dirname, "../app/insights")

function boardDirs(): string[] {
  return readdirSync(INSIGHTS_DIR).filter((d) =>
    statSync(path.join(INSIGHTS_DIR, d)).isDirectory()
  )
}

/** Boards served through the snapshot ladder — derived, never curated. */
function cachedBoards(): string[] {
  return boardDirs().filter((d) => {
    const page = path.join(INSIGHTS_DIR, d, "page.tsx")
    try {
      return readFileSync(page, "utf8").includes("readBoardOrLive")
    } catch {
      return false
    }
  })
}

/** Every .tsx under a board dir, one level deep (clients live beside the page). */
function boardSources(dir: string): string[] {
  return readdirSync(path.join(INSIGHTS_DIR, dir))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(path.join(INSIGHTS_DIR, dir, f), "utf8"))
}

const CACHED = cachedBoards()

describe("the population is real (the guard is not vacuous)", () => {
  it("finds the readBoardOrLive boards, and they are a strict subset of /insights", () => {
    // A ban that passes because it matched nothing is worthless. Pin a floor:
    // five boards used the ladder on 2026-08-21 (candy-mlb, deals, first-mint,
    // panini-squeeze, rookies). Adding one must not silently shrink this.
    expect(CACHED.length).toBeGreaterThanOrEqual(5)
    expect(CACHED.length).toBeLessThan(boardDirs().length)
    expect(CACHED).toContain("deals")
    expect(CACHED).toContain("first-mint")
    expect(CACHED).toContain("rookies")
  })

  it("the detector can tell a board that renders the stamp from one that does not", () => {
    // Positive + negative control on the matcher itself, independent of the tree.
    const renders = `<span>Updated <FreshnessStamp iso={data?.meta?.fetched_at ?? null} /></span>`
    const typeOnly = `export type ApiResponse = { meta: { fetched_at: string } }`
    expect(/<FreshnessStamp\b/.test(renders)).toBe(true)
    expect(/<FreshnessStamp\b/.test(typeOnly)).toBe(false)
  })
})

describe("every snapshot-cached board shows the age of what it is serving", () => {
  for (const board of CACHED) {
    it(`${board} renders a <FreshnessStamp>`, () => {
      const rendered = boardSources(board).some((src) => /<FreshnessStamp\b/.test(src))
      expect(
        rendered,
        `/insights/${board} is served by readBoardOrLive, whose stale-cache leg returns a ` +
          `snapshot of ANY age with no degraded notice. Without a rendered <FreshnessStamp> ` +
          `the reader has no way to tell a 6-hour-old board from a live one.`
      ).toBe(true)
    })

    it(`${board} does not coalesce a missing timestamp into the render clock`, () => {
      // `iso={x ?? new Date()...}` stamps NOW onto a stale snapshot — the fabricated-
      // value shape, applied to a freshness claim. "—" (what FreshnessStamp renders
      // for null) is the honest output for a timestamp that never arrived.
      for (const src of boardSources(board)) {
        for (const m of src.matchAll(/<FreshnessStamp[^>]*\/>/g)) {
          expect(
            /new Date\(\)/.test(m[0]),
            `/insights/${board}: ${m[0]} defaults a missing timestamp to the render clock`
          ).toBe(false)
        }
      }
    })
  }
})
