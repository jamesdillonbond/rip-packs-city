import { describe, it, expect, beforeEach, vi } from "vitest"

// The CUMULATIVE half of the insights-cache warm cron.
//
// The per-tick rule (`ok` when at least one board warmed) is deliberate and
// correct: a board timing out under disk-IO saturation is the condition this
// cache exists to survive. Measurement showed it is not SUFFICIENT — over 869
// ticks / 3.2 days `deals` failed 59.5% of ticks and once went 34 consecutive
// ticks (~2h50m) unrefreshed, while every one of those runs logged `ok: true`
// because candy-mlb (95.6% success) satisfied `okCount > 0` on its own.
//
// So these pin the property a tick cannot express: how long a board has actually
// gone without a refresh.

const rows: { data: unknown; error: unknown } = { data: [], error: null }
const selects: string[] = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: (cols: string) => {
        selects.push(cols)
        return Promise.resolve({ data: rows.data, error: rows.error })
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  },
  supabase: {},
}))

const {
  readBoardSnapshotAges,
  stalestBoards,
  BOARD_SNAPSHOT_STALE_CEILING_MS,
  WARM_BOARDS,
} = await import("@/lib/insights/board-cache")

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

beforeEach(() => {
  selects.length = 0
  rows.data = []
  rows.error = null
})

describe("readBoardSnapshotAges", () => {
  it("returns one entry per warmed board, keyed to WARM_BOARDS", async () => {
    rows.data = WARM_BOARDS.map(({ key }) => ({ board_key: key, refreshed_at: ago(2 * MIN) }))
    const ages = await readBoardSnapshotAges()
    expect(ages.map((a) => a.key)).toEqual(WARM_BOARDS.map((b) => b.key))
    for (const a of ages) expect(a.ageMs).toBeGreaterThanOrEqual(2 * MIN - 5_000)
  })

  it("never selects the payload column", async () => {
    // panini-squeeze's payload is multi-MB; an age check must not drag it back.
    rows.data = []
    await readBoardSnapshotAges()
    expect(selects).toHaveLength(1)
    expect(selects[0]).not.toContain("payload")
    expect(selects[0]).toContain("refreshed_at")
  })

  it("reports an absent board as UNKNOWN age, not as fresh", async () => {
    rows.data = [{ board_key: "candy-mlb", refreshed_at: ago(1 * MIN) }]
    const ages = await readBoardSnapshotAges()
    const missing = ages.filter((a) => a.key !== "candy-mlb")
    expect(missing.length).toBeGreaterThan(0)
    for (const a of missing) expect(a.ageMs).toBeNull()
  })

  it("reports UNKNOWN on a failed read rather than an age it did not measure", async () => {
    rows.data = null
    rows.error = { message: "canceling statement due to statement timeout" }
    const ages = await readBoardSnapshotAges()
    expect(ages).toHaveLength(WARM_BOARDS.length)
    for (const a of ages) expect(a.ageMs).toBeNull()
  })

  it("treats an unparseable timestamp as UNKNOWN", async () => {
    rows.data = [{ board_key: "deals", refreshed_at: "not-a-date" }]
    const ages = await readBoardSnapshotAges()
    expect(ages.find((a) => a.key === "deals")?.ageMs).toBeNull()
  })
})

describe("stalestBoards", () => {
  it("flags a board past the ceiling and orders worst-first", async () => {
    rows.data = [
      { board_key: "deals", refreshed_at: ago(170 * MIN) }, // the measured worst case
      { board_key: "first-mint", refreshed_at: ago(140 * MIN) },
      { board_key: "candy-mlb", refreshed_at: ago(2 * MIN) },
    ]
    const stale = stalestBoards(await readBoardSnapshotAges())
    expect(stale.map((s) => s.key)).toEqual(["deals", "first-mint"])
  })

  it("stays QUIET through ordinary rotation — the whole point of the 2h ceiling", async () => {
    // 59.5% of ticks fail for `deals`, so a threshold near one tick would be red
    // most of the time. An hour unrefreshed is common (34 streaks in 3.2 days)
    // and must not report.
    rows.data = WARM_BOARDS.map(({ key }) => ({ board_key: key, refreshed_at: ago(59 * MIN) }))
    expect(stalestBoards(await readBoardSnapshotAges())).toEqual([])
  })

  it("does NOT report an unknown age as stale", async () => {
    // ⚠ Manufacturing the finding out of our own missing data is the failure
    // this repo keeps paying for. A board with no snapshot row is a real absence,
    // counted separately by the caller — it is not evidence of staleness.
    rows.data = []
    const ages = await readBoardSnapshotAges()
    expect(ages.every((a) => a.ageMs === null)).toBe(true)
    expect(stalestBoards(ages)).toEqual([])
  })

  it("uses a ceiling far above the 10-minute reader freshness window", () => {
    // The two thresholds answer different questions: BOARD_CACHE_FRESH_MS decides
    // what the READER serves, this decides what the WRITER admits to. Collapsing
    // them would report every ordinary dropped tick.
    expect(BOARD_SNAPSHOT_STALE_CEILING_MS).toBe(2 * 60 * MIN)
  })

  it("honours an explicit ceiling override", async () => {
    rows.data = [{ board_key: "deals", refreshed_at: ago(20 * MIN) }]
    expect(stalestBoards(await readBoardSnapshotAges(), 10 * MIN).map((s) => s.key)).toEqual(["deals"])
    expect(stalestBoards(await readBoardSnapshotAges(), 30 * MIN)).toEqual([])
  })
})
