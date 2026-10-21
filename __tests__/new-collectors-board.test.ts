import { describe, it, expect } from "vitest"
import { EMPTY_BOARD, COVERAGE_NOTE, fetchNewCollectorsBoard } from "@/lib/new-collectors-board"

// The New Collectors insights board. fetchNewCollectorsBoard reads four MVs
// (DB), so only the pure shared constants are unit-tested: the empty-board
// sentinel (all four sections empty, computed_at null) and the coverage-honesty
// note explaining why new-collector counts are directional.

describe("EMPTY_BOARD", () => {
  it("has every section empty and computed_at null", () => {
    expect(EMPTY_BOARD).toEqual({
      summary: [],
      spend: [],
      gateway: {},
      cohorts: [],
      computed_at: null,
    })
  })

  it("gateway is an empty object, not an array", () => {
    expect(Array.isArray(EMPTY_BOARD.gateway)).toBe(false)
    expect(Object.keys(EMPTY_BOARD.gateway)).toHaveLength(0)
  })
})

describe("COVERAGE_NOTE", () => {
  it("flags new-collector counts as lower-confidence/directional", () => {
    expect(COVERAGE_NOTE).toMatch(/directional/)
    expect(COVERAGE_NOTE).toMatch(/debiased/)
    // RE-PINNED 2026-09-26: this asserted the literal "92%" — a buyer-resolution
    // coverage figure that moves as backfill runs (Top Shot re-measured 95.2% on
    // 09-20), i.e. it pinned a decaying snapshot. The property is that the note
    // DISCLOSES partial coverage without freezing a percentage.
    expect(COVERAGE_NOTE).toMatch(/most active buyers/)
    expect(COVERAGE_NOTE).not.toMatch(/\d+\s*%/)
  })
})

// fetchNewCollectorsBoard fans out to four MVs via supabase.from(name).select(...)
// (cohorts also chains .order()). Each read is awaited in a Promise.all, so a
// per-table thenable builder fakes the client with no vi.mock. `errors` lets a
// single section fail to test error propagation.
const NAME_TO_KEY: Record<string, string> = {
  mv_insights_new_collectors_summary: "summary",
  mv_insights_new_collectors_spend: "spend",
  mv_insights_new_collectors_gateway: "gateway",
  mv_insights_new_collectors_cohorts: "cohorts",
}
const ncClient = (
  tables: Record<string, any[] | null>,
  errors: Record<string, { message: string }> = {},
) => ({
  from(name: string) {
    const key = NAME_TO_KEY[name]
    const result = { data: tables[key] ?? null, error: errors[key] ?? null }
    const builder: any = {
      select: () => builder,
      order: () => builder,
      then: (res: (r: any) => any) => res(result),
    }
    return builder
  },
})

describe("fetchNewCollectorsBoard", () => {
  it("throws when any section returns an error", async () => {
    await expect(
      fetchNewCollectorsBoard(
        ncClient({ summary: [], spend: [], gateway: [], cohorts: [] }, { gateway: { message: "gw boom" } }),
      ),
    ).rejects.toThrow("gw boom")
  })

  it("returns an all-empty board (shape of EMPTY_BOARD) for null data", async () => {
    const board = await fetchNewCollectorsBoard(
      ncClient({ summary: null, spend: null, gateway: null, cohorts: null }),
    )
    expect(board).toEqual(EMPTY_BOARD)
  })

  it("coerces numerics, sorts summary by days ascending, and takes computed_at from the smallest-days row", async () => {
    const board = await fetchNewCollectorsBoard(
      ncClient({
        summary: [
          { window_label: "90d", days: "90", new_first_seen: "5", active_buyers: "10", computed_at: "2026-07-12T00:00:00Z" },
          { window_label: "7d", days: "7", new_first_seen: "1", active_buyers: "3", computed_at: "2026-07-12T00:00:01Z" },
          { window_label: "30d", days: "30", new_first_seen: "abc", active_buyers: "", computed_at: null },
        ],
        spend: null,
        gateway: null,
        cohorts: null,
      }),
    )
    expect(board.summary.map((r) => r.window_label)).toEqual(["7d", "30d", "90d"])
    // numeric coercion: valid strings → numbers; invalid/empty → 0 via numOr0
    expect(board.summary[0].new_first_seen).toBe(1)
    expect(board.summary[1].new_first_seen).toBe(0)
    expect(board.summary[1].active_buyers).toBe(0)
    // computed_at taken from summaryRows[0] after the ascending sort (the 7d row)
    expect(board.computed_at).toBe("2026-07-12T00:00:01Z")
  })

  it("coerces the spend histogram row numerics", async () => {
    const board = await fetchNewCollectorsBoard(
      ncClient({
        summary: null,
        spend: [{ window_label: "30d", b_lt5: "4", b_5_25: "", b_500plus: "2", total_new: "10" }],
        gateway: null,
        cohorts: null,
      }),
    )
    expect(board.spend[0]).toMatchObject({ window_label: "30d", b_lt5: 4, b_5_25: 0, b_500plus: 2, total_new: 10 })
  })

  it("groups gateway rows by window_label + kind, each sorted by rnk", async () => {
    const board = await fetchNewCollectorsBoard(
      ncClient({
        summary: null,
        spend: null,
        gateway: [
          { window_label: "30d", kind: "set", name: "Base", series: "8", buyers: "50", rnk: "2" },
          { window_label: "30d", kind: "set", name: "Metallic", series: null, buyers: "80", rnk: "1" },
          { window_label: "30d", kind: "player", name: "Flagg", buyers: "30", rnk: "1" },
          { window_label: "90d", kind: "other", name: "Fallback", buyers: "5", rnk: "1" },
        ],
        cohorts: null,
      }),
    )
    // 30d sets sorted by rnk ascending: Metallic(1) before Base(2)
    expect(board.gateway["30d"].sets.map((r) => r.name)).toEqual(["Metallic", "Base"])
    expect(board.gateway["30d"].players.map((r) => r.name)).toEqual(["Flagg"])
    // unknown kind coerces to "player"
    expect(board.gateway["90d"].players[0].kind).toBe("player")
    // null series → null; numeric series coerced
    expect(board.gateway["30d"].sets.find((r) => r.name === "Base")!.series).toBe(8)
    expect(board.gateway["30d"].sets.find((r) => r.name === "Metallic")!.series).toBeNull()
  })

  it("normalizes cohort rows, preserving nullable rate/ltv fields", async () => {
    const board = await fetchNewCollectorsBoard(
      ncClient({
        summary: null,
        spend: null,
        gateway: null,
        cohorts: [
          { cohort_month: "2026-06", cohort_size: "100", repeat_30d_pct: "12.5", ltv_median: "", whales: "3", median_days_to_10th: null },
        ],
      }),
    )
    expect(board.cohorts[0]).toMatchObject({ cohort_month: "2026-06", cohort_size: 100, repeat_30d_pct: 12.5, whales: 3 })
    expect(board.cohorts[0].ltv_median).toBeNull()
    expect(board.cohorts[0].median_days_to_10th).toBeNull()
  })
})

// 2026-10-20 live sweep: the Oct 2026 cohort (under 3 weeks old) read
// "Repeat 30d / 60d / 90d 40.9% / 40.9% / 40.9%" — a partial window is a lower
// bound, not a rate.
describe("repeatWindowClosed — a cohort rate only once every member had the window", () => {
  const at = (iso: string) => Date.parse(iso)
  it("a 3-week-old cohort has no closed window", async () => {
    const { repeatWindowClosed } = await import("@/lib/new-collectors-board")
    for (const d of [30, 60, 90]) expect(repeatWindowClosed("2026-10-01", d, at("2026-10-21T03:00:00Z")), `${d}d`).toBe(false)
  })
  it("September closes 30d on Oct 31 and 90d on Dec 30 (its last member joined Sep 30)", async () => {
    const { repeatWindowClosed } = await import("@/lib/new-collectors-board")
    expect(repeatWindowClosed("2026-09-01", 30, at("2026-10-21T03:00:00Z"))).toBe(false)
    expect(repeatWindowClosed("2026-09-01", 30, at("2026-10-31T00:00:00Z"))).toBe(true)
    expect(repeatWindowClosed("2026-09-01", 90, at("2026-12-29T23:00:00Z"))).toBe(false)
    expect(repeatWindowClosed("2026-09-01", 90, at("2026-12-30T00:00:00Z"))).toBe(true)
    // December rolls the year
    expect(repeatWindowClosed("2025-12-01", 30, at("2026-01-31T00:00:00Z"))).toBe(true)
  })
  it("an unparseable month is never 'closed'", async () => {
    const { repeatWindowClosed } = await import("@/lib/new-collectors-board")
    expect(repeatWindowClosed("garbage", 30, Date.now())).toBe(false)
  })
})
