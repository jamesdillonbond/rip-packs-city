import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  computeDepletionPct,
  supplyWeightPool,
  weightedMeanEv,
  weightedMedianFmv,
  classifySupplyDist,
  nextCursorFromRun,
  clampEv,
  round2,
  round3,
} from "@/supabase/functions/_shared/pack-ev-supply-weighted"

// Unit tests for the supply-weighted pack-EV math shared by the three Dapper
// collections without published packOdds (AllDay, Golazos, Pinnacle). This is a
// core intelligence + FMV-adjacent surface with three inline copies; pinning the
// arithmetic here means a formula edit is a test-visible change, not a silent
// mispricing. See the source-drift guard at the bottom.

describe("computeDepletionPct — sold fraction, null when supply unknown", () => {
  it("returns the rounded sold percentage", () => {
    expect(computeDepletionPct(100, 40)).toBe(60) // 60 sold of 100
    expect(computeDepletionPct(3, 1)).toBe(67) // round(66.6)
  })
  it("is null when total supply is 0 or unknown (never a false 0%)", () => {
    expect(computeDepletionPct(0, 0)).toBeNull()
  })
  it("clamps at 100 and does not floor a negative (mirrors the inline copies)", () => {
    expect(computeDepletionPct(100, -50)).toBe(100) // 150% sold → clamped
    // available > total (upstream noise) → negative, intentionally not floored
    expect(computeDepletionPct(100, 130)).toBe(-30)
  })
  it("fully-sold pack reads 100", () => {
    expect(computeDepletionPct(500, 0)).toBe(100)
  })
})

describe("supplyWeightPool — AllDay/Golazos normalized (0,1] drop_weight", () => {
  it("normalizes each circulation to the pool max, 6dp", () => {
    const w = supplyWeightPool([250, 100, 500])
    expect(w).toEqual([0.5, 0.2, 1]) // /500
  })
  it("floors a missing/<=0/NaN circulation to weight of 1/maxCirc", () => {
    const w = supplyWeightPool([null, 0, 1000])
    // both the null and the 0 floor to circ=1 → 1/1000 = 0.001
    expect(w).toEqual([0.001, 0.001, 1])
  })
  it("rounds to 6 decimal places", () => {
    const w = supplyWeightPool([1, 3]) // 1/3 = 0.3333...
    expect(w[0]).toBeCloseTo(0.333333, 6)
    expect(w[1]).toBe(1)
  })
  it("a single-edition pool weights to 1", () => {
    expect(supplyWeightPool([77])).toEqual([1])
  })
  it("an all-equal pool weights everything to 1", () => {
    expect(supplyWeightPool([50, 50, 50])).toEqual([1, 1, 1])
  })
  it("empty pool → empty weights", () => {
    expect(supplyWeightPool([])).toEqual([])
  })
})

describe("weightedMeanEv — Pinnacle inline supply-weighted mean", () => {
  it("computes the supply-weighted mean FMV × slots, minus pack price", () => {
    // two renders: circ 100 @ $2, circ 300 @ $10 → mean = (100*2+300*10)/400 = 8
    const r = weightedMeanEv([{ circ: 100, fmv: 2 }, { circ: 300, fmv: 10 }], 5, 12)
    expect(r.ok).toBe(true)
    expect(r.grossEv).toBe(40) // 8 * 5
    expect(r.packEv).toBe(28) // 40 - 12
    expect(r.valueRatio).toBeCloseTo(3.333, 3)
    expect(r.isPositiveEv).toBe(true)
    expect(r.fmvCoveragePct).toBe(100)
    expect(r.editionCount).toBe(2)
    expect(r.editionsWithFmv).toBe(2)
  })
  it("counts a null-FMV edition toward coverage denominator but not the mean", () => {
    const r = weightedMeanEv([{ circ: 100, fmv: 10 }, { circ: 100, fmv: null }], 1, 0)
    expect(r.ok).toBe(true)
    expect(r.grossEv).toBe(10) // only the fmv edition contributes
    expect(r.editionCount).toBe(2)
    expect(r.editionsWithFmv).toBe(1)
    expect(r.fmvCoveragePct).toBe(50)
    expect(r.valueRatio).toBeNull() // packPrice 0 → no ratio
  })
  it("ok=false with no editions", () => {
    const r = weightedMeanEv([], 3, 5)
    expect(r.ok).toBe(false)
    expect(r.editionCount).toBe(0)
    expect(r.fmvCoveragePct).toBe(0)
  })
  it("ok=false when no edition carries FMV (no coverage)", () => {
    const r = weightedMeanEv([{ circ: 100, fmv: null }, { circ: 5, fmv: null }], 3, 5)
    expect(r.ok).toBe(false)
    expect(r.editionsWithFmv).toBe(0)
    expect(r.fmvCoveragePct).toBe(0)
  })
  it("floors a missing/<=0 circulation weight to 1", () => {
    // circ null → weight 1, circ 3 → weight 3; mean = (1*10 + 3*10)/4 = 10
    const r = weightedMeanEv([{ circ: null, fmv: 10 }, { circ: 3, fmv: 10 }], 1, 0)
    expect(r.grossEv).toBe(10)
  })
  it("negative-EV pack reports is_positive_ev false", () => {
    const r = weightedMeanEv([{ circ: 1, fmv: 1 }], 1, 100)
    expect(r.grossEv).toBe(1)
    expect(r.packEv).toBe(-99)
    expect(r.isPositiveEv).toBe(false)
  })
  it("clamps a runaway EV to the RPC bounds", () => {
    const r = weightedMeanEv([{ circ: 1, fmv: 5_000_000 }], 1, 0)
    expect(r.grossEv).toBe(1_000_000) // clampEv upper bound
  })
})

describe("weightedMedianFmv — the RPC's Typical Pull median semantics", () => {
  // The canonical SQL is:
  //   med AS (SELECT min(fmv_usd) FROM cum WHERE cw >= 0.5 * tw)
  // i.e. sort by fmv ascending, take the first fmv where the running weight
  // reaches half the total. Verified against the live definition of
  // compute_pack_ev_per_edition_weighted on 2026-07-25.
  it("returns the weight-median FMV, not the unweighted middle", () => {
    // 90 units of $1 + 10 units of $500: the median pull is a $1 common.
    expect(weightedMedianFmv([{ fmv: 500, w: 10 }, { fmv: 1, w: 90 }])).toBe(1)
  })

  it("is the grail-shape signal: median stays low while the mean is dragged up", () => {
    const pairs = [{ fmv: 2, w: 4000 }, { fmv: 5, w: 500 }, { fmv: 900, w: 25 }]
    expect(weightedMedianFmv(pairs)).toBe(2)
    // ...whereas the weighted MEAN over the same pool is far higher.
    const mean = weightedMeanEv(
      pairs.map((p) => ({ circ: p.w, fmv: p.fmv })),
      1,
      0,
    )
    expect(mean.grossEv).toBeGreaterThan(6)
    expect(mean.typicalEv).toBe(2)
  })

  it("crosses at exactly half the weight (>= boundary, inclusive)", () => {
    // equal weights: cumulative hits 0.5*tw exactly on the 2nd of 4
    expect(weightedMedianFmv([
      { fmv: 1, w: 1 }, { fmv: 2, w: 1 }, { fmv: 3, w: 1 }, { fmv: 4, w: 1 },
    ])).toBe(2)
  })

  it("a single edition is its own median", () => {
    expect(weightedMedianFmv([{ fmv: 42.5, w: 7 }])).toBe(42.5)
  })

  it("sorts by fmv regardless of input order", () => {
    const a = weightedMedianFmv([{ fmv: 9, w: 1 }, { fmv: 3, w: 1 }, { fmv: 6, w: 1 }])
    const b = weightedMedianFmv([{ fmv: 3, w: 1 }, { fmv: 6, w: 1 }, { fmv: 9, w: 1 }])
    expect(a).toBe(b)
    expect(a).toBe(6)
  })

  it("empty pool → null", () => {
    expect(weightedMedianFmv([])).toBeNull()
  })
})

describe("weightedMeanEv typicalEv — slots multiplier + RPC clamp [0, 1e6]", () => {
  it("multiplies the median by slots", () => {
    const ev = weightedMeanEv([{ circ: 100, fmv: 3 }], 5, 10)
    expect(ev.typicalEv).toBe(15)
  })

  it("rounds to 2dp like the RPC", () => {
    // 2.3456 x 1 -> 2.35
    expect(weightedMeanEv([{ circ: 1, fmv: 2.3456 }], 1, 0).typicalEv).toBe(2.35)
    // 1.111 x 3 = 3.333 -> 3.33
    expect(weightedMeanEv([{ circ: 1, fmv: 1.111 }], 3, 0).typicalEv).toBe(3.33)
  })

  it("clamps the top at 1e6 (RPC bound)", () => {
    const ev = weightedMeanEv([{ circ: 1, fmv: 9e9 }], 1, 0)
    expect(ev.typicalEv).toBe(1000000)
  })

  it("null-FMV editions are excluded from the median, as from the mean", () => {
    const ev = weightedMeanEv(
      [{ circ: 1000, fmv: null }, { circ: 10, fmv: 4 }, { circ: 10, fmv: 8 }],
      1,
      0,
    )
    expect(ev.typicalEv).toBe(4)
    expect(ev.editionsWithFmv).toBe(2)
    expect(ev.editionCount).toBe(3)
  })

  it("typicalEv is null exactly when ok=false (no FMV coverage / no editions)", () => {
    expect(weightedMeanEv([], 1, 0).typicalEv).toBeNull()
    expect(weightedMeanEv([{ circ: 5, fmv: null }], 1, 0).typicalEv).toBeNull()
  })
})

describe("clamp/round helpers match the RPC + edge inline copies", () => {
  it("clampEv bounds to [-10000, 1000000]", () => {
    expect(clampEv(2_000_000)).toBe(1_000_000)
    expect(clampEv(-50_000)).toBe(-10_000)
    expect(clampEv(42)).toBe(42)
  })
  it("round2/round3 round to 2/3 dp", () => {
    expect(round2(1.239)).toBe(1.24)
    expect(round3(1.23449)).toBe(1.234)
  })
})

describe("classifySupplyDist — the shared per-dist skip verdict", () => {
  it("no resolvable editions → no_editions", () => {
    expect(classifySupplyDist(0, 0)).toBe("no_editions")
  })
  it("editions but none with FMV → no_fmv_coverage", () => {
    expect(classifySupplyDist(5, 0)).toBe("no_fmv_coverage")
  })
  it("at least one edition with FMV → ok", () => {
    expect(classifySupplyDist(5, 1)).toBe("ok")
  })
})

describe("nextCursorFromRun — resume-cursor decision", () => {
  it("'reset' → null (start over)", () => {
    expect(nextCursorFromRun("reset", { cursor_after: "c1", extra: { has_next_page: true } })).toBeNull()
  })
  it("an explicit cursor override wins", () => {
    expect(nextCursorFromRun("mycursor", { cursor_after: "c1", extra: { has_next_page: true } })).toBe("mycursor")
  })
  it("no override + last run had a next page → its cursor_after", () => {
    expect(nextCursorFromRun(null, { cursor_after: "c9", extra: { has_next_page: true } })).toBe("c9")
    expect(nextCursorFromRun("", { cursor_after: "c9", extra: { has_next_page: true } })).toBe("c9")
  })
  it("no override + last sweep completed (no next page) → null (restart from top)", () => {
    expect(nextCursorFromRun(null, { cursor_after: "c9", extra: { has_next_page: false } })).toBeNull()
    expect(nextCursorFromRun(null, { cursor_after: "c9", extra: {} })).toBeNull()
  })
  it("no prior run → null", () => {
    expect(nextCursorFromRun(null, null)).toBeNull()
  })
})

describe("edge-fn source-drift guard — the copies cannot silently diverge", () => {
  // The three edge functions were rewired to IMPORT these helpers from _shared
  // (2026-07-20), so there is a single source of truth. This guard enforces
  // "keep in sync" mechanically: each edge fn must EITHER import from
  // _shared/pack-ev-supply-weighted (drift impossible) OR still carry the inline
  // formula verbatim (whitespace-normalized). Either way, an un-mirrored edit to
  // one copy — or dropping the import while re-inlining a diverged formula —
  // reddens CI here. Deploying these functions (supabase functions deploy) is the
  // operator step that makes the imports live in prod.
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const read = (name: string) => norm(readFileSync(path.join(root, `supabase/functions/${name}/index.ts`), "utf8"))

  const allday = read("compute-allday-pack-ev")
  const golazos = read("compute-golazos-pack-ev")
  const pinnacle = read("compute-pinnacle-pack-ev")

  const importsShared = (src: string) => /from\s+["'][^"']*_shared\/pack-ev-supply-weighted/.test(src)

  const DEPLETION = norm("Math.min(100, Math.round(((total - available) / total) * 100))")
  const SUPPLY_WEIGHT = norm("Math.round((c / maxCirc) * 1e6) / 1e6")
  const CLAMP = norm("Math.max(Math.min(v, 1000000), -10000)")

  it("AllDay imports the shared helpers, or carries the inline depletion + supply-weight formulas", () => {
    expect(importsShared(allday) || (allday.includes(DEPLETION) && allday.includes(SUPPLY_WEIGHT))).toBe(true)
  })
  it("Golazos imports the shared helpers, or carries the inline depletion + supply-weight formulas", () => {
    expect(importsShared(golazos) || (golazos.includes(DEPLETION) && golazos.includes(SUPPLY_WEIGHT))).toBe(true)
  })
  it("Pinnacle imports the shared helpers, or carries the inline depletion + EV-clamp formulas", () => {
    expect(importsShared(pinnacle) || (pinnacle.includes(DEPLETION) && pinnacle.includes(CLAMP))).toBe(true)
  })
  it("the shared depletion still computes the pinned value", () => {
    expect(computeDepletionPct(100, 40)).toBe(60)
  })
})

describe("every pack-EV writer persists typical_ev (Typical Pull EV)", () => {
  // WHY THIS EXISTS (2026-07-25). The 2026-07-18 deploys added typical_ev to the
  // AllDay/Golazos/Pinnacle writers via the Supabase MCP; the repo copies were
  // never updated, and the 2026-07-20 _shared rewire then refactored the OLDER
  // (pre-typical_ev) bodies. The repo was therefore simultaneously ahead of prod
  // (shared module) and behind it (no typical_ev), so the next `deploy` of those
  // files would have silently dropped a shipped display — "Typical Pull EV" on the
  // pack page and the /packs board, which reads pack_ev_history.typical_ev via
  // mv_pack_ev_latest / pack_table_rows.
  //
  // The pre-existing drift guard above could not catch this because it only
  // compares repo-to-repo (edge fn vs _shared). This one asserts an absolute
  // property of each writer's INSERT payload, so dropping the field reddens CI
  // regardless of what the shared module says.
  //
  // It is directory-driven, not a hardcoded list: a new compute-<collection>-pack-ev
  // writer is covered the moment it exists.
  const root = process.cwd()
  const fnDir = path.join(root, "supabase/functions")
  const writers = readdirSync(fnDir)
    .filter((d) => /^compute-.+-pack-ev$/.test(d))
    .sort()

  it("finds all four known pack-EV writers (guard is not silently empty)", () => {
    expect(writers).toEqual([
      "compute-allday-pack-ev",
      "compute-golazos-pack-ev",
      "compute-pinnacle-pack-ev",
      "compute-topshot-pack-ev",
    ])
  })

  for (const w of writers) {
    it(`${w} writes typical_ev into its pack_ev_history row`, () => {
      const src = readFileSync(path.join(fnDir, w, "index.ts"), "utf8")
      // Must appear as an object KEY in the row payload, not merely in a comment.
      const assignments = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .filter((l) => /(^|[\s{,])typical_ev\s*:/.test(l))
      expect(
        assignments.length,
        `${w} no longer persists typical_ev — the Typical Pull EV display would go NULL. ` +
          `Deployed prod behaviour writes it; do not drop it.`,
      ).toBeGreaterThan(0)
      // ...and it must be fed from a typical/median source, not hardcoded null.
      expect(
        assignments.some((l) => /typical_pull_ev|typicalEv|typicalPerSlot/.test(l)),
        `${w} persists typical_ev but not from the weighted-median source ` +
          `(RPC typical_pull_ev / _shared typicalEv).`,
      ).toBe(true)
    })

    it(`${w} still writes gross_ev and pack_ev alongside it`, () => {
      const src = readFileSync(path.join(fnDir, w, "index.ts"), "utf8")
      expect(/(^|[\s{,])gross_ev\s*:/m.test(src)).toBe(true)
      expect(/(^|[\s{,])pack_ev\s*:/m.test(src)).toBe(true)
    })
  }
})
