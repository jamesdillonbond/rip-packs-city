import { describe, it, expect } from "vitest"
import { buildPackCalendar, fetchPackCalendar, type PackCalendarSourceRow } from "@/lib/insights/pack-calendar"

// 2026-11-08 12:00 PT
const NOW = new Date("2026-11-08T20:00:00Z")

function row(over: Partial<PackCalendarSourceRow>): PackCalendarSourceRow {
  return {
    product: "nba",
    dist_id: "8916",
    title: "Rookie Debut Case",
    tier: "legendary",
    pack_type: "case",
    dist_type: "RSVP",
    slots: 12,
    retail_usd: "2500",
    start_time: "2026-11-05T20:00:00Z",
    end_time: "2026-11-11T20:00:00Z",
    image_url: null,
    ...over,
  }
}

describe("buildPackCalendar", () => {
  it("classifies upcoming, open and ended drops in the week, oldest first", () => {
    const drops = buildPackCalendar(
      [
        row({ dist_id: "8918", title: "Rookie Debut Trade Ticket Pack", dist_type: null, retail_usd: null, start_time: "2026-11-11T20:30:00Z", end_time: null }),
        row({}),
        row({ dist_id: "8920", title: "Tip-Off Pack", retail_usd: "10", start_time: "2026-11-05T20:00:00Z", end_time: "2026-11-06T20:00:00Z" }),
      ],
      NOW,
    )
    expect(drops.map((d) => [d.dist_id, d.status, d.kind])).toEqual([
      ["8916", "open", "rsvp"],
      ["8920", "ended", "rsvp"],
      ["8918", "upcoming", "sale"],
    ])
    expect(drops[0]).toMatchObject({ collection: "nba_top_shot", retail_usd: 2500, detail_href: "/nba-top-shot/pack/dist/8916" })
    // an unpriced drop is null, never $0
    expect(drops[2].retail_usd).toBeNull()
  })

  it("leaves out what cannot be dated or is outside the week", () => {
    const drops = buildPackCalendar(
      [
        row({ dist_id: "1", start_time: "2000-12-01T00:00:00Z", end_time: null }), // Atlas placeholder
        row({ dist_id: "2", start_time: null }),
        row({ dist_id: "3", start_time: "2026-10-01T00:00:00Z", end_time: "2026-10-02T00:00:00Z" }), // long ended
        row({ dist_id: "4", start_time: "2026-11-20T00:00:00Z", end_time: null }), // beyond next 7 days
        row({ dist_id: "5", start_time: "2026-10-01T00:00:00Z", end_time: null }), // no close: not "open this week"
        row({ dist_id: "abc" }),
        row({ product: "pinnacle", dist_id: "6" }),
      ],
      NOW,
    )
    expect(drops).toEqual([])
  })

  it("keeps an earlier drop whose window is still open", () => {
    const drops = buildPackCalendar([row({ dist_id: "7", start_time: "2026-10-25T00:00:00Z", end_time: "2026-11-12T00:00:00Z" })], NOW)
    expect(drops.map((d) => d.status)).toEqual(["open"])
  })
})

// A minimal supabase double: from(table) → chainable builder resolving to the table's result.
function fakeSb(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  return {
    from(table: string) {
      const res = tables[table] ?? { data: [], error: null }
      const b: Record<string, unknown> = {}
      for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = () => b
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(ok)
      return b
    },
  }
}

describe("fetchPackCalendar", () => {
  const state = [
    { product: "nba", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:50:00Z" },
    { product: "nfl", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:49:00Z" },
  ]

  it("returns the week from the complete pass", async () => {
    const r = await fetchPackCalendar(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: [row({})] } }), NOW)
    expect(r.complete).toBe(true)
    expect(r.complete_at.nba).toBe("2026-11-08T19:50:00Z")
    expect(r.drops.length).toBeGreaterThan(0)
  })

  it("with no complete pass says so and publishes nothing — never an empty week", async () => {
    const r = await fetchPackCalendar(
      fakeSb({ atlas_pack_market_state: { data: [{ product: "nba", last_complete_pass_started_at: null }] }, atlas_pack_market: { data: [row({})] } }),
      NOW,
    )
    expect(r.complete).toBe(false)
    expect(r.drops).toEqual([])
    // All Day has no state row at all: it is still named, as unread
    expect(r.complete_at).toEqual({ nba: null, nfl: null })
  })

  it("walks every product the book has a state row for, and names a half-walked one as unread", async () => {
    const r = await fetchPackCalendar(
      fakeSb({
        atlas_pack_market_state: {
          data: [...state, { product: "disney", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:46:00Z" }, { product: "laliga", last_complete_pass_started_at: null }],
        },
        atlas_pack_market: { data: [row({ product: "disney", dist_id: "8913", title: "A Disney Villains Halloween Vol.2" })] },
      }),
      NOW,
    )
    expect(r.complete).toBe(false)
    expect(r.complete_at).toMatchObject({ disney: "2026-11-08T19:46:00Z", laliga: null })
    const pin = r.drops.find((d) => d.dist_id === "8913")
    expect(pin).toMatchObject({ collection: "disney_pinnacle", detail_href: "/disney-pinnacle/pack/dist/8913" })
  })

  it("ignores a state row for a product it cannot place", async () => {
    const r = await fetchPackCalendar(
      fakeSb({ atlas_pack_market_state: { data: [...state, { product: "ufc", last_complete_pass_started_at: null }] }, atlas_pack_market: { data: [] } }),
      NOW,
    )
    expect(r.complete).toBe(true)
    expect(Object.keys(r.complete_at).sort()).toEqual(["nba", "nfl"])
  })

  it("a failed read throws (the route turns it into a 503), never an empty list", async () => {
    await expect(
      fetchPackCalendar(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { error: { message: "timeout" } } }), NOW),
    ).rejects.toThrow(/timeout/)
    await expect(fetchPackCalendar(fakeSb({ atlas_pack_market_state: { error: { message: "denied" } } }), NOW)).rejects.toThrow(/denied/)
  })

  it("a full 1000-row page is a cut list, not the week", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => row({ dist_id: String(i + 1) }))
    await expect(
      fetchPackCalendar(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: many } }), NOW),
    ).rejects.toThrow(/page full/)
  })
})
