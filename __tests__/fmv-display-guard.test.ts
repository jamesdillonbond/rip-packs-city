import { describe, it, expect, vi } from "vitest"
import { guardTopshotFmv, loadTopshotFmvGuard, type FmvGuardMap, type FmvGuardEntry } from "@/lib/fmv-display-guard"

// A minimal supabase-shaped stub: .from(table).select(cols) resolves {data,error}.
function sbStub(result: { data: any[] | null; error: { message: string } | null }) {
  const select = vi.fn().mockResolvedValue(result)
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as any, from, select }
}

// Pins the Top Shot FMV display clamp — the guard that stops a stored FMV
// disconnected from active trading (or above the 90d max sale) from rendering a
// fake discount on /api/market + /api/sniper-feed. Regression re-surfaces the
// inflated FMVs the guard exists to suppress.

function guardMap(entries: Record<string, Partial<FmvGuardEntry>>): FmvGuardMap {
  const m: FmvGuardMap = new Map()
  for (const [key, e] of Object.entries(entries)) {
    m.set(key, {
      maxSale90d: e.maxSale90d ?? 0,
      isThin: e.isThin ?? false,
      fmvExceedsMax: e.fmvExceedsMax ?? false,
      fmvDisconnected: e.fmvDisconnected ?? false,
      clampTarget: e.clampTarget ?? 0,
    })
  }
  return m
}

describe("guardTopshotFmv", () => {
  it("passes FMV through unchanged when there is no guard entry", () => {
    const r = guardTopshotFmv(guardMap({}), "73:2785", 500)
    expect(r).toEqual({ effectiveFmv: 500, lowConfidenceFmv: false })
  })

  it("returns the raw value + no caveat for null key or non-positive fmv", () => {
    expect(guardTopshotFmv(guardMap({}), null, 100)).toEqual({ effectiveFmv: 100, lowConfidenceFmv: false })
    expect(guardTopshotFmv(guardMap({ "1:2": { isThin: true } }), "1:2", 0)).toEqual({
      effectiveFmv: 0,
      lowConfidenceFmv: false,
    })
  })

  it("clamps to the 90d max when fmv exceeds it", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 120 } })
    const r = guardTopshotFmv(g, "1:2", 500)
    expect(r.effectiveFmv).toBe(120)
    expect(r.lowConfidenceFmv).toBe(true)
  })

  it("clamps to the p90 target when fmv is disconnected from trading", () => {
    const g = guardMap({ "1:2": { fmvDisconnected: true, clampTarget: 45 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(45)
  })

  it("takes the tightest bound when both clamps apply", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 120, fmvDisconnected: true, clampTarget: 45 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(45)
  })

  it("flags thin data as low-confidence without changing the value", () => {
    const g = guardMap({ "1:2": { isThin: true } })
    expect(guardTopshotFmv(g, "1:2", 500)).toEqual({ effectiveFmv: 500, lowConfidenceFmv: true })
  })

  it("falls back to the base '::' key when the parallel key has no entry", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 90 } })
    // parallel key "1:2::19" not present → falls back to base "1:2"
    expect(guardTopshotFmv(g, "1:2::19", 500).effectiveFmv).toBe(90)
  })

  it("does not clamp when the bound is zero/absent even if the flag is set", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 0 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(500)
  })
})

// Exercises the async loader (the previously-dark half): the 5-min cache, the
// row-coercion branches, and the fail-soft "serve last good, never drop the
// guard" contract on both an error result and a throw. Ordered deliberately —
// the empty-on-first-error case must run before any successful load seeds the
// module-level cache; fake timers bust the TTL between phases.
describe("loadTopshotFmvGuard", () => {
  it("returns an EMPTY map (not undefined) when the first-ever load errors with no cache", async () => {
    const { client } = sbStub({ data: null, error: { message: "boom" } })
    const map = await loadTopshotFmvGuard(client)
    expect(map.size).toBe(0)
  })

  it("maps rows, coerces string/null numerics, and skips rows with no external_id", async () => {
    vi.useFakeTimers()
    try {
      const { client, select } = sbStub({
        data: [
          { external_id: "1:2", max_sale_90d: "12.5", is_thin: 1, fmv_exceeds_max: true, fmv_disconnected: null, clamp_target: null },
          { external_id: "", max_sale_90d: 9, is_thin: false, fmv_exceeds_max: false, fmv_disconnected: false, clamp_target: 3 },
          { external_id: "3:4", max_sale_90d: null, is_thin: null, fmv_exceeds_max: null, fmv_disconnected: true, clamp_target: "45.5" },
        ],
        error: null,
      })
      const map = await loadTopshotFmvGuard(client)
      expect(select).toHaveBeenCalledTimes(1)
      expect(map.size).toBe(2) // empty external_id skipped
      expect(map.get("1:2")).toEqual({ maxSale90d: 12.5, isThin: true, fmvExceedsMax: true, fmvDisconnected: false, clampTarget: 0 })
      expect(map.get("3:4")).toEqual({ maxSale90d: 0, isThin: false, fmvExceedsMax: false, fmvDisconnected: true, clampTarget: 45.5 })

      // cache hit within TTL → does NOT re-query
      const again = await loadTopshotFmvGuard(client)
      expect(select).toHaveBeenCalledTimes(1)
      expect(again.get("1:2")?.maxSale90d).toBe(12.5)

      // past the 5-min TTL, an error result serves the LAST GOOD map, not empty
      vi.advanceTimersByTime(6 * 60_000)
      const errSb = sbStub({ data: null, error: { message: "later boom" } })
      const afterErr = await loadTopshotFmvGuard(errSb.client)
      expect(errSb.select).toHaveBeenCalledTimes(1)
      expect(afterErr.get("1:2")?.maxSale90d).toBe(12.5)

      // and a THROW also serves the last good map
      vi.advanceTimersByTime(6 * 60_000)
      const throwSb = { from: () => ({ select: () => Promise.reject(new Error("network")) }) } as any
      const afterThrow = await loadTopshotFmvGuard(throwSb)
      expect(afterThrow.get("1:2")?.maxSale90d).toBe(12.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns an empty map when data is null but there is no error", async () => {
    vi.useFakeTimers()
    try {
      // advance well past any prior cache so this load actually runs
      vi.setSystemTime(Date.now() + 60 * 60_000)
      const { client } = sbStub({ data: null, error: null })
      const map = await loadTopshotFmvGuard(client)
      // null data → the ?? [] branch → empty map is cached and returned
      expect(map.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
