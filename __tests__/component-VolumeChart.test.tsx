// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import VolumeChart, {
  pivot,
  fmtUsd,
  fmtDateShort,
  colorFor,
} from "@/components/analytics/VolumeChart"
import type { AnalyticsTimeseriesRow } from "@/lib/analytics-types"

// Pins the loans VolumeChart's data shaper + formatters. The `pivot` is the
// load-bearing bit — it sums principal per (date, collection) into the stacked
// series and the daily total; a bug there mis-plots every point. fmtUsd/
// fmtDateShort feed the axis + tooltip (the silent-$0 / wrong-date class), and
// colorFor keeps each collection's series a stable color. These are only
// reachable through recharts internals otherwise, so they're exported + pinned.

afterEach(cleanup)

const r = (bucket: string, collection: string, principal_usd: number): AnalyticsTimeseriesRow => ({
  bucket, collection, principal_usd, loan_count: 1, repayment_usd: 0,
})

describe("VolumeChart.pivot", () => {
  it("sums principal per (date, collection) and per-day total, sorted by date", () => {
    const { points, collections } = pivot([
      r("2026-07-02", "topshot", 100),
      r("2026-07-01", "topshot", 30),
      r("2026-07-01", "allday", 20),
      r("2026-07-02", "topshot", 50), // same date+collection accumulates
    ])
    expect(collections).toEqual(["allday", "topshot"]) // sorted
    expect(points.map((p) => p.date)).toEqual(["2026-07-01", "2026-07-02"]) // date-sorted
    expect(points[0]).toMatchObject({ date: "2026-07-01", topshot: 30, allday: 20, total: 50 })
    expect(points[1]).toMatchObject({ date: "2026-07-02", topshot: 150, total: 150 })
  })

  it("skips a row with no date and lowercases the collection", () => {
    const { points, collections } = pivot([
      r("", "topshot", 999), // no date -> skipped
      r("2026-07-01", "TopShot", 10),
    ])
    expect(points).toHaveLength(1)
    expect(collections).toEqual(["topshot"])
  })

  it("returns empty for no rows", () => {
    expect(pivot([])).toEqual({ points: [], collections: [] })
  })
})

describe("VolumeChart.fmtUsd", () => {
  it("returns $0 for non-positive / non-finite (never $NaN)", () => {
    expect(fmtUsd(0)).toBe("$0")
    expect(fmtUsd(-5)).toBe("$0")
    expect(fmtUsd(Number.NaN)).toBe("$0")
  })
  it("bands $M / $k / $", () => {
    expect(fmtUsd(2_500_000)).toBe("$2.50M")
    expect(fmtUsd(2500)).toBe("$2.5k")
    expect(fmtUsd(150)).toBe("$150")
  })
})

describe("VolumeChart.fmtDateShort", () => {
  it("renders 'Mon D' and adds a 2-digit year when asked", () => {
    expect(fmtDateShort("2026-07-04")).toBe("Jul 4")
    expect(fmtDateShort("2026-07-04", true)).toMatch(/Jul 4.*26/)
  })
  it("returns the raw input on a malformed date", () => {
    expect(fmtDateShort("nope")).toBe("nope")
  })
})

describe("VolumeChart.colorFor", () => {
  it("uses the fixed collection color when known", () => {
    expect(colorFor("topshot", 3)).toBe("#10b981")
    expect(colorFor("ufc", 0)).toBe("#fb7185")
  })
  it("cycles the fallback palette by index for an unknown collection", () => {
    expect(colorFor("mystery", 0)).toBe("#10b981")
    expect(colorFor("mystery", 1)).toBe("#38bdf8")
  })
})

describe("VolumeChart render", () => {
  it("shows the backfill empty-state when there are no rows", () => {
    render(<VolumeChart rows={[]} activeCollections={[]} />)
    expect(screen.getByText(/Backfill in progress/i)).toBeTruthy()
  })
  it("renders the chart (not the empty-state) when rows exist", () => {
    render(<VolumeChart rows={[r("2026-07-01", "topshot", 100)]} activeCollections={[]} />)
    expect(screen.queryByText(/Backfill in progress/i)).toBeNull()
  })
})
