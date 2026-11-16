// __tests__/topshot-wallet-routes-key-parallels-by-subedition.test.ts
//
// 2026-11-15. Two Top Shot wallet routes read moments straight from the chain and write
// `wallet_moments_cache` WITHOUT going through upsert_wmc_batch (whose re-key from
// topshot_moment_subeditions is what keeps the 6-hourly walks right):
//   - /api/wallet-search  (upsert via PostgREST)
//   - /api/cache-refresh  (.update() per moment)
// Both keyed every moment `set:play`, so a parallel was cached, priced and sized as its
// base; wallet search showed the chain's numMomentsInEdition — the WHOLE family (a /500
// parallel read 16,000) — as "#/N"; and cache-refresh's "prefer the non-int key" rule
// promoted a parallel over the base (the rule wallet search fixed on 09-11). Its Top Shot
// script also never type-checked (`momentTierString`), and its All Day scripts read a path
// nothing publishes — the live type-check guard for that class is
// scripts/cadence/check-inline-scripts.mjs (.github/workflows/cadence-inline-scripts.yml).
//
// This file pins the source-level properties those fixes rest on.

import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

const WALLET_SEARCH = readFileSync("app/api/wallet-search/route.ts", "utf8")
const CACHE_REFRESH = readFileSync("app/api/cache-refresh/route.ts", "utf8")

/** Template literals that hold a Cadence script (`fun main(`). */
function cadenceScripts(src: string): string[] {
  return [...src.matchAll(/`([^`]*?fun\s+main\s*\([^`]*)`/g)].map((m) => m[1])
}

describe("Top Shot wallet routes read the subedition and never the family count", () => {
  for (const [name, src] of [["wallet-search", WALLET_SEARCH], ["cache-refresh", CACHE_REFRESH]] as const) {
    it(`${name}: its Top Shot metadata script reads TopShot.getMomentsSubedition`, () => {
      const ts = cadenceScripts(src).filter((s) => s.includes("TopShot.TopShotMomentMetadataView"))
      expect(ts.length).toBeGreaterThan(0)
      for (const s of ts) expect(s).toMatch(/TopShot\.getMomentsSubedition\(nftID: id\)/)
    })

    it(`${name}: no Cadence script returns numMomentsInEdition (it counts the whole family)`, () => {
      for (const s of cadenceScripts(src)) expect(s).not.toMatch(/numMomentsInEdition/)
    })
  }

  it("cache-refresh builds set:play::N for a parallel and set:play for the base", () => {
    const m = CACHE_REFRESH.match(/buildEditionKey: function\(meta\) \{([\s\S]*?)\n    \},/)
    expect(m).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const build = new Function("meta", m![1]) as (meta: Record<string, string>) => string
    expect(build({ setID: "90", playID: "3550", sub: "1" })).toBe("90:3550::1")
    expect(build({ setID: "90", playID: "3550", sub: "0" })).toBe("90:3550")
    expect(build({ setID: "90", playID: "3550", sub: "" })).toBe("90:3550")
  })

  it("cache-refresh never lets an int-family key (base OR parallel) displace the computed key", () => {
    expect(CACHE_REFRESH).toMatch(/const isIntFamily = \/\^\\d\+:\\d\+\(::\\d\+\)\?\$\/\.test\(/)
    expect(CACHE_REFRESH).toMatch(/if \(isIntFamily\) continue/)
    // The old tie-break, whose `/^\d+:\d+$/` is false for `90:3550::1`.
    expect(CACHE_REFRESH).not.toMatch(/!isInt && /)
  })

  it("cache-refresh's scripts use members and paths that exist", () => {
    const scripts = cadenceScripts(CACHE_REFRESH)
    expect(scripts.length).toBeGreaterThanOrEqual(4)
    for (const s of scripts) {
      expect(s).not.toMatch(/momentTierString/)
      expect(s).not.toMatch(/AllDayMomentNFTCollection/)
      expect(s).not.toMatch(/&\{AllDay\.MomentNFTCollectionPublic\}/)
    }
  })
})
