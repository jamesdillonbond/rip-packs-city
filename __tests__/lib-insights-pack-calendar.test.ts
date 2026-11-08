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

const RSS = `<rss><channel>
<item><title><![CDATA[Meet the Award Winners: The Players Behind Today's Final Gold Series Drop]]></title><link>https://blog.candy.io/final-gold-drop/</link><pubDate>Fri, 06 Nov 2026 20:10:49 GMT</pubDate></item>
<item><title><![CDATA[How to Connect Your Candy Wallet to OpenSea and Magic Eden]]></title><link>https://blog.candy.io/wallet/</link><pubDate>Fri, 06 Nov 2026 21:31:47 GMT</pubDate></item>
<item><title><![CDATA[2026 MLB Base Series ICONs Return for Drop 2]]></title><link>https://blog.candy.io/old/</link><pubDate>Mon, 05 Oct 2026 20:00:00 GMT</pubDate></item>
</channel></rss>`
const candyOk = (async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch
const candyDown = (async () => { throw new Error("ENOTFOUND") }) as unknown as typeof fetch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cal = (sb: any, now: Date, f: typeof fetch = candyOk) => fetchPackCalendar(sb, now, f)
const freshPanini = [
  { pack_id: "1060", name: "2026 Panini NFT Prizm The Rolling Stones Packs", price_usd: 25, cards_per_pack: 5, start_at: "2026-11-06T16:00:00Z", end_at: null, in_stock: true, is_available: true, last_seen_at: "2026-11-08T19:00:00Z" },
]

describe("fetchPackCalendar", () => {
  const state = [
    { product: "nba", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:50:00Z" },
    { product: "nfl", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:49:00Z" },
  ]

  it("returns the week from the complete pass", async () => {
    const r = await cal(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: [row({})] }, panini_pack_drops: { data: freshPanini } }), NOW)
    expect(r.complete).toBe(true)
    expect(r.complete_at.nba).toBe("2026-11-08T19:50:00Z")
    expect(r.drops.length).toBeGreaterThan(0)
  })

  it("with no complete pass says so and publishes nothing — never an empty week", async () => {
    const r = await cal(
      fakeSb({ atlas_pack_market_state: { data: [{ product: "nba", last_complete_pass_started_at: null }] }, atlas_pack_market: { data: [row({})] } }),
      NOW,
    )
    expect(r.complete).toBe(false)
    expect(r.drops).toEqual([])
    // All Day has no state row at all: it is still named, as unread
    expect(r.complete_at).toMatchObject({ nba: null, nfl: null })
  })

  it("walks every product the book has a state row for, and names a half-walked one as unread", async () => {
    const r = await cal(
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
    const r = await cal(
      fakeSb({ atlas_pack_market_state: { data: [...state, { product: "ufc", last_complete_pass_started_at: null }] }, atlas_pack_market: { data: [] }, panini_pack_drops: { data: freshPanini } }),
      NOW,
    )
    expect(r.complete).toBe(true)
    expect(Object.keys(r.complete_at).sort()).toEqual(["candy", "nba", "nfl", "panini"])
  })

  it("a failed read throws (the route turns it into a 503), never an empty list", async () => {
    await expect(
      cal(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { error: { message: "timeout" } } }), NOW),
    ).rejects.toThrow(/timeout/)
    await expect(cal(fakeSb({ atlas_pack_market_state: { error: { message: "denied" } } }), NOW)).rejects.toThrow(/denied/)
  })

  it("a full 1000-row page is a cut list, not the week", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => row({ dist_id: String(i + 1) }))
    await expect(
      cal(fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: many } }), NOW),
    ).rejects.toThrow(/page full/)
  })
})

describe("fetchPackCalendar — Panini and Candy MLB", () => {
  const state = [
    { product: "nba", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:50:00Z" },
    { product: "nfl", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:49:00Z" },
  ]
  const base = { atlas_pack_market_state: { data: state }, atlas_pack_market: { data: [] } }

  it("lists a fresh Panini drop with Panini's own date and links RPC's Panini packs page", async () => {
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: freshPanini } }), NOW)
    expect(r.complete_at.panini).toBe("2026-11-08T19:00:00Z")
    expect(r.drops).toEqual([expect.objectContaining({ collection: "panini_blockchain", dist_id: "1060", title: "Prizm The Rolling Stones Packs", retail_usd: 25, status: "open", detail_href: "/panini-blockchain/packs" })])
  })

  it("a Panini table the runner has not refreshed is UNREAD — its drops are left out, never posted stale", async () => {
    const stale = freshPanini.map((p) => ({ ...p, last_seen_at: "2026-11-06T00:00:00Z" }))
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: stale } }), NOW)
    expect(r.complete).toBe(false)
    expect(r.complete_at.panini).toBeNull()
    expect(r.drops).toEqual([])
  })

  it("a sold-out Panini pack has ENDED; one older than the week and still on sale is not this week's drop", async () => {
    const rows = [
      { ...freshPanini[0], pack_id: "1058", name: "2026 Panini NFT Prizm FIFA World Cup Sticker Packs", start_at: "2026-11-03T15:00:00Z", in_stock: false },
      { ...freshPanini[0], pack_id: "1056", name: "2026 Panini NFT Prizm WNBA Packs", start_at: "2026-09-30T15:00:00Z", in_stock: true },
    ]
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: rows } }), NOW)
    expect(r.drops.map((d) => [d.dist_id, d.status])).toEqual([["1058", "ended"]])
  })

  it("Candy: only drop-titled posts from the last 7 days, linked — wallet notices and older posts left out", async () => {
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: freshPanini } }), NOW)
    expect(r.announcements).toEqual([
      { collection: "candy_mlb", title: "Meet the Award Winners: The Players Behind Today's Final Gold Series Drop", url: "https://blog.candy.io/final-gold-drop/", published_at: "2026-11-06T20:10:49.000Z" },
    ])
  })

  it("Candy's feed unreachable is UNREAD, not 'no Candy drops'", async () => {
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: freshPanini } }), NOW, candyDown)
    expect(r.complete).toBe(false)
    expect(r.complete_at.candy).toBeNull()
    expect(r.announcements).toEqual([])
  })

  it("a failed Panini read throws (the route turns it into a 503), never an empty list", async () => {
    await expect(cal(fakeSb({ ...base, panini_pack_drops: { error: { message: "denied" } } }), NOW)).rejects.toThrow(/panini_pack_drops: denied/)
  })
})
