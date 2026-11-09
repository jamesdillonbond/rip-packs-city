import { describe, it, expect } from "vitest"
import { fetchDropsBoard, orderDrops, dropStatusLine, type DropsBoardItem } from "@/lib/insights/drops-board"

const NOW = new Date("2026-11-08T23:00:00Z") // Sun 3 PM PT

const state = [
  { product: "nba", last_complete_pass_started_at: "2026-11-08T22:45:00Z", last_complete_at: "2026-11-08T22:50:00Z" },
  { product: "nfl", last_complete_pass_started_at: "2026-11-08T22:45:00Z", last_complete_at: "2026-11-08T22:49:00Z" },
]
const atlas = [
  { product: "nba", dist_id: "8916", title: "Rookie Debut Case", tier: "legendary", pack_type: "case", dist_type: "RSVP", slots: 12, retail_usd: "2500", start_time: "2026-11-05T20:00:00Z", end_time: "2026-11-11T20:00:00Z", image_url: null },
  { product: "nba", dist_id: "8918", title: "Rookie Debut Trade Ticket Pack", tier: null, pack_type: "pack", dist_type: null, slots: 3, retail_usd: null, start_time: "2026-11-11T20:30:00Z", end_time: null, image_url: null },
]
const panini = [{ pack_id: "1060", name: "2026 Panini NFT Prizm The Rolling Stones Packs", price_usd: 25, cards_per_pack: 5, start_at: "2026-11-06T16:00:00Z", end_at: null, in_stock: true, is_available: true, last_seen_at: "2026-11-08T22:05:00Z" }]

function fakeSb(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  return {
    async rpc() {
      return { data: { lane_as_of: "2026-11-08T22:56:00Z", sets: [] }, error: null }
    },
    from(table: string) {
      const res = tables[table] ?? { data: [], error: null }
      const b: Record<string, unknown> = {}
      for (const m of ["select", "eq", "gte", "order", "limit", "in"]) b[m] = () => b
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(ok)
      return b
    },
  }
}
const candyOk = (async () => new Response("<rss><channel><item><title>x</title><link>https://blog.candy.io/x/</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>", { status: 200 })) as unknown as typeof fetch

describe("fetchDropsBoard", () => {
  it("links only drops that already have an RPC pack page", async () => {
    const b = await fetchDropsBoard(
      fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: atlas }, panini_pack_drops: { data: panini }, pack_distributions: { data: [{ dist_id: "8916" }] } }),
      NOW,
      candyOk,
    )
    const by = Object.fromEntries(b.drops.map((d) => [d.dist_id, d.page_live]))
    expect(by).toEqual({ "8916": true, "8918": false, "1060": false })
    expect(b.complete).toBe(true)
  })

  it("a failed pack-page read throws (the page shows its degraded notice), never an unlinked list", async () => {
    await expect(
      fetchDropsBoard(
        fakeSb({ atlas_pack_market_state: { data: state }, atlas_pack_market: { data: atlas }, panini_pack_drops: { data: panini }, pack_distributions: { error: { message: "timeout" } } }),
        NOW,
        candyOk,
      ),
    ).rejects.toThrow(/pack_distributions: timeout/)
  })
})

describe("orderDrops / dropStatusLine", () => {
  const base = { tier: null, pack_type: null, slots: null, detail_href: "/x", page_live: false } as const
  const d = (o: Partial<DropsBoardItem>): DropsBoardItem => ({ ...base, collection: "nba_top_shot", dist_id: "1", title: "t", kind: "sale", retail_usd: null, start_time: "2026-11-08T00:00:00Z", end_time: null, status: "open", ...o }) as DropsBoardItem

  it("priciest first among live drops; ended ones apart", () => {
    const { live, ended } = orderDrops([d({ dist_id: "a", retail_usd: 10 }), d({ dist_id: "b", retail_usd: 2500 }), d({ dist_id: "c", status: "ended", end_time: "2026-11-06T17:00:00Z" })])
    expect(live.map((x) => x.dist_id)).toEqual(["b", "a"])
    expect(ended.map((x) => x.dist_id)).toEqual(["c"])
  })

  it("speaks each app's words, in PT, and never says RSVP", () => {
    expect(dropStatusLine(d({ kind: "rsvp", end_time: "2026-11-11T20:00:00Z" }))).toBe("Pre-orders close Wed 12 PM PT")
    expect(dropStatusLine(d({ collection: "disney_pinnacle", kind: "rsvp", status: "ended" }))).toBe("Draw requests closed")
    expect(dropStatusLine(d({ status: "upcoming", start_time: "2026-11-11T20:30:00Z" }))).toBe("Drops Wed 12:30 PM PT")
    expect(dropStatusLine(d({ kind: "open_edition" }))).toBe("Minting now")
    expect(dropStatusLine(d({}))).toBe("On sale now")
  })
})
