import { describe, it, expect, vi, afterEach } from "vitest"

// The ACCURACY GATE published on /legal/fmv-methodology#accuracy (platform
// review 2026-10-11, M4) — lib/fmv-accuracy/fetchers.ts.
//
// WHAT THIS PINS, and why each assertion is phrased as an ABSENCE:
//   1. A failed READ is `ok:false` — never rows, never a number. The table's
//      failed branch depends on nothing but this flag.
//   2. The precompute's two SENTINELS (999 = the leg threw, -1 = no
//      denominator; migration 20260910230812) are NOT measurements. They must
//      classify to `sharePct: null` and label as "unavailable". A 999 shown as
//      "999%" or a -1 shown as "-1%" is the fabricated-value shape.
//   3. The label is never a bare "0%". A measured 0.0 (UFC's closed market) is
//      "<1%" — true, and not mistakable for a failed read's zero. Whole numbers
//      only; a decimal is never printed.
//   4. The fetcher asks for EXACTLY the share metrics, one per listed collection,
//      so a renamed metric cannot silently drop a collection into "missing".
//
// ⚠ PLANTED-DEFECT PROOF (run 2026-10-11): with `classifyShare` edited to treat
// 999 as a measurement (removing the LEG_FAILED_SENTINEL branch), the sentinel
// test below failed with `expected 'unavailable', received '999%'`, and the
// "never a bare 0%" sweep failed when `shareLabel` was edited to
// `${Math.round(v)}%` without the `<1` branch (received '0%'). Both edits were
// reverted; the assertions are falsifiable.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
    }),
  },
}))

import {
  ACCURACY_METRICS,
  ACCURACY_METRIC_COLLECTIONS,
  LEG_FAILED_SENTINEL,
  NO_DENOMINATOR_SENTINEL,
  buildAccuracyRows,
  classifyShare,
  fetchFmvAccuracyGate,
  isStaleReading,
  shareLabel,
} from "@/lib/fmv-accuracy/fetchers"

afterEach(() => {
  vi.restoreAllMocks()
})

const AT = "2026-10-12T01:48:00.187Z"

function fakeDb(outcome: { data?: unknown; error?: { message: string } | null; throws?: Error; hang?: boolean }) {
  const calls: { table: string; cols: string; col: string; vals: readonly string[] }[] = []
  const db = {
    from: (table: string) => ({
      select: (cols: string) => ({
        in: (col: string, vals: readonly string[]) => {
          calls.push({ table, cols, col, vals })
          if (outcome.throws) return Promise.reject(outcome.throws)
          if (outcome.hang) return new Promise<never>(() => {})
          return Promise.resolve({ data: outcome.data ?? null, error: outcome.error ?? null })
        },
      }),
    }),
  }
  return { db, calls }
}

describe("classifyShare — sentinels are not measurements", () => {
  it("999 (the leg threw) → null / leg_failed", () => {
    expect(classifyShare(LEG_FAILED_SENTINEL)).toEqual({ sharePct: null, basis: "leg_failed" })
    expect(classifyShare("999")).toEqual({ sharePct: null, basis: "leg_failed" })
  })

  it("-1 (no denominator) → null / no_denominator", () => {
    expect(classifyShare(NO_DENOMINATOR_SENTINEL)).toEqual({ sharePct: null, basis: "no_denominator" })
  })

  it("a missing value → null / missing; garbage → null / out_of_range", () => {
    expect(classifyShare(null)).toEqual({ sharePct: null, basis: "missing" })
    expect(classifyShare(undefined)).toEqual({ sharePct: null, basis: "missing" })
    expect(classifyShare("not a number")).toEqual({ sharePct: null, basis: "out_of_range" })
    expect(classifyShare(101)).toEqual({ sharePct: null, basis: "out_of_range" })
    expect(classifyShare(-0.5)).toEqual({ sharePct: null, basis: "out_of_range" })
  })

  it("a real percentage, including a measured 0.0 and 100, is a measurement", () => {
    expect(classifyShare(56.5)).toEqual({ sharePct: 56.5, basis: "measured" })
    expect(classifyShare(0)).toEqual({ sharePct: 0, basis: "measured" })
    expect(classifyShare(100)).toEqual({ sharePct: 100, basis: "measured" })
    expect(classifyShare("26.9")).toEqual({ sharePct: 26.9, basis: "measured" })
  })
})

describe("shareLabel — a label, never a decimal, never a bare 0%", () => {
  it("null → 'unavailable'", () => {
    expect(shareLabel(null)).toBe("unavailable")
    expect(shareLabel(Number.NaN)).toBe("unavailable")
  })

  it("under one percent → '<1%' (a measured 0.0 included)", () => {
    expect(shareLabel(0)).toBe("<1%")
    expect(shareLabel(0.2)).toBe("<1%")
    expect(shareLabel(0.99)).toBe("<1%")
  })

  it("otherwise a whole percent", () => {
    expect(shareLabel(1.2)).toBe("1%")
    expect(shareLabel(26.9)).toBe("27%")
    expect(shareLabel(56.5)).toBe("57%")
    expect(shareLabel(100)).toBe("100%")
  })

  it("NEVER prints a bare '0%' or a decimal for any value in [0, 100] or any sentinel", () => {
    const probes: Array<number | null> = [null, LEG_FAILED_SENTINEL, NO_DENOMINATOR_SENTINEL]
    for (let v = 0; v <= 100; v += 0.1) probes.push(Number(v.toFixed(1)))
    for (const v of probes) {
      // Sentinels are classified first in real use; here they go straight in to
      // prove the label function alone cannot be tricked into a number by them.
      const { sharePct } = classifyShare(v)
      const label = shareLabel(sharePct)
      expect(label).not.toBe("0%")
      expect(label).not.toMatch(/\d\.\d/)
      expect(label === "unavailable" || /^(<1|\d{1,3})%$/.test(label)).toBe(true)
    }
  })
})

describe("buildAccuracyRows — one row per listed collection, from the precompute's rows", () => {
  it("maps each metric prefix to its registry collection and classifies the value", () => {
    const rows = buildAccuracyRows([
      { metric: "topshot_fmv_high_med_share_pct", value: 56.5, computed_at: AT },
      { metric: "allday_fmv_high_med_share_pct", value: 26.9, computed_at: AT },
      { metric: "pinnacle_fmv_high_med_share_pct", value: 31.9, computed_at: AT },
      { metric: "golazos_fmv_high_med_share_pct", value: 1.2, computed_at: AT },
      { metric: "ufc_fmv_high_med_share_pct", value: 0.0, computed_at: AT },
      { metric: "candy_fmv_high_med_share_pct", value: LEG_FAILED_SENTINEL, computed_at: AT },
      // noise: a sibling metric family must not be mistaken for the share
      { metric: "topshot_fmv_sweep_pct_24h", value: 3, computed_at: AT },
      // ⚠ The clock is INJECTED (an hour after AT). With the default Date.now()
      // this asserted `stale: false` against the real clock and turned red on its
      // own 48 h after AT was written (CI run 38573637012, 2026-10-14).
    ], Date.parse(AT) + 3_600_000)
    expect(rows.map((r) => r.collectionId)).toEqual(ACCURACY_METRIC_COLLECTIONS.map((m) => m.collectionId))
    const by = Object.fromEntries(rows.map((r) => [r.collectionId, r]))
    expect(by["nba-top-shot"]).toMatchObject({ label: "NBA Top Shot", sharePct: 56.5, basis: "measured", computedAt: AT, stale: false })
    expect(by["ufc"]).toMatchObject({ sharePct: 0, basis: "measured" })
    expect(by["candy-mlb"]).toMatchObject({ sharePct: null, basis: "leg_failed" })
    // every label came from the registry, none fell back to the id
    for (const r of rows) expect(r.label).not.toBe(r.collectionId)
  })

  it("marks a row stale from the injected clock, never from the component", () => {
    const rows = buildAccuracyRows(
      [{ metric: "topshot_fmv_high_med_share_pct", value: 50, computed_at: AT }],
      Date.parse("2026-10-15T00:00:00Z")
    )
    expect(rows.find((r) => r.collectionId === "nba-top-shot")!.stale).toBe(true)
    expect(rows.find((r) => r.collectionId === "nfl-all-day")!.stale).toBe(false)
  })

  it("a collection with no row is 'missing', not 0", () => {
    const rows = buildAccuracyRows([{ metric: "topshot_fmv_high_med_share_pct", value: 50, computed_at: AT }])
    const allday = rows.find((r) => r.collectionId === "nfl-all-day")!
    expect(allday).toMatchObject({ sharePct: null, basis: "missing", computedAt: null })
    expect(shareLabel(allday.sharePct)).toBe("unavailable")
  })

  it("the fetcher's metric list is exactly one share metric per listed collection", () => {
    expect(ACCURACY_METRICS).toEqual(ACCURACY_METRIC_COLLECTIONS.map((m) => `${m.prefix}_fmv_high_med_share_pct`))
    expect(new Set(ACCURACY_METRICS).size).toBe(ACCURACY_METRICS.length)
  })
})

describe("isStaleReading", () => {
  const now = Date.parse("2026-10-14T02:00:00Z")
  it("older than 48h → stale; younger → not; missing → not (nothing to be stale)", () => {
    expect(isStaleReading("2026-10-12T01:48:00Z", now)).toBe(true)
    expect(isStaleReading("2026-10-13T01:48:00Z", now)).toBe(false)
    expect(isStaleReading(null, now)).toBe(false)
    expect(isStaleReading("garbage", now)).toBe(false)
  })
})

describe("fetchFmvAccuracyGate — the read contract", () => {
  it("reads the precompute by the exact share metrics and returns ok:true rows", async () => {
    const { db, calls } = fakeDb({
      data: [{ metric: "topshot_fmv_high_med_share_pct", value: 56.5, computed_at: AT }],
    })
    const res = await fetchFmvAccuracyGate(db)
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe("rpc_trust_health_precompute")
    expect(calls[0].col).toBe("metric")
    expect([...calls[0].vals]).toEqual([...ACCURACY_METRICS])
    if (res.ok) expect(res.rows.find((r) => r.collectionId === "nba-top-shot")?.sharePct).toBe(56.5)
  })

  it("a driver error → ok:false, rows:null (no number can be rendered from it)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = fakeDb({ error: { message: "canceling statement due to statement timeout" } })
    const res = await fetchFmvAccuracyGate(db)
    expect(res).toEqual({ ok: false, rows: null, error: "canceling statement due to statement timeout" })
  })

  it("a thrown read → ok:false (never propagates into the page render)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = fakeDb({ throws: new Error("socket hang up") })
    await expect(fetchFmvAccuracyGate(db)).resolves.toMatchObject({ ok: false, rows: null })
  })

  it("a non-array payload → ok:false, not an empty table", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { db } = fakeDb({ data: { metric: "x" } })
    await expect(fetchFmvAccuracyGate(db)).resolves.toMatchObject({ ok: false })
  })

  it("an empty but successful read is ok:true with every row 'missing' (the third state)", async () => {
    const { db } = fakeDb({ data: [] })
    const res = await fetchFmvAccuracyGate(db)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.rows).toHaveLength(ACCURACY_METRIC_COLLECTIONS.length)
      for (const r of res.rows) expect(r.basis).toBe("missing")
    }
  })

  it("a hung read is bounded and reported as a failure", async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, "log").mockImplementation(() => {})
      const { db } = fakeDb({ hang: true })
      const p = fetchFmvAccuracyGate(db)
      await vi.advanceTimersByTimeAsync(9_000)
      const res = await p
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/exceeded/)
    } finally {
      vi.useRealTimers()
    }
  })
})
