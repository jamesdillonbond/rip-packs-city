import { describe, it, expect } from "vitest"
import { buildPackCalendar, buildPinnacleOpenEditionDrops, fetchPackCalendar, openEditionTitle, type PackCalendarSourceRow } from "@/lib/insights/pack-calendar"

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

  it("leaves out a long-running sale that started before the week (it is not this week's drop)", () => {
    const drops = buildPackCalendar([row({ dist_id: "8891", dist_type: null, start_time: "2026-10-08T16:00:00Z", end_time: "2027-10-16T16:00:00Z" })], NOW)
    expect(drops).toEqual([])
  })

  it("keeps an earlier drop whose window is still open", () => {
    const drops = buildPackCalendar([row({ dist_id: "7", start_time: "2026-10-25T00:00:00Z", end_time: "2026-11-12T00:00:00Z" })], NOW)
    expect(drops.map((d) => d.status)).toEqual(["open"])
  })
})

// The Open Edition read: mint lane at the head, nothing minting this window.
const OE_EMPTY = { data: { lane_as_of: "2026-11-08T19:56:00Z", sets: [] } }

// A minimal supabase double: from(table) → chainable builder resolving to the table's result;
// rpc(name) → tables["rpc:<name>"] (the Open Edition read defaults to OE_EMPTY).
function fakeSb(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  return {
    async rpc(name: string) {
      const res = tables[`rpc:${name}`] ?? (name === "get_pinnacle_open_edition_drops" ? OE_EMPTY : { data: null, error: null })
      return { data: res.data ?? null, error: res.error ?? null }
    },
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
    expect(Object.keys(r.complete_at).sort()).toEqual(["candy", "nba", "nfl", "panini", "pinnacle_oe"])
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

  // Inverted 2026-11-08 (Trevor: "Are there any other drops … live … this week"): a Panini pack
  // released weeks ago that the store still sells IS live this week — 2026 Prizm WNBA (9-30) was
  // missing from the report with 228 of 23,512 left. Legacy stock (2022-23 packs still listed) is not.
  it("a sold-out Panini pack has ENDED; a recent one still on sale is live (and almost sold out); legacy stock is not", async () => {
    const rows = [
      { ...freshPanini[0], pack_id: "1058", name: "2026 Panini NFT Prizm FIFA World Cup Sticker Packs", start_at: "2026-11-03T15:00:00Z", in_stock: false },
      { ...freshPanini[0], pack_id: "1056", name: "2026 Panini NFT Prizm WNBA Packs", start_at: "2026-09-30T15:00:00Z", in_stock: true, remaining_qty: 228, total_qty: 23512 },
      { ...freshPanini[0], pack_id: "777", name: "2022-23 Panini NFT Score LaLiga Packs", price_usd: 0, start_at: "2023-03-17T15:00:00Z", in_stock: true, remaining_qty: 15302, total_qty: 29306 },
    ]
    const r = await cal(fakeSb({ ...base, panini_pack_drops: { data: rows } }), NOW)
    expect(r.drops.map((d) => [d.dist_id, d.status])).toEqual([["1056", "open"], ["1058", "ended"]])
    expect(r.drops.find((d) => d.dist_id === "1056")?.low_stock).toBe(true)
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

describe("Pinnacle Open Editions", () => {
  const sets = [
    // minting now (last pin 2 h ago) — started 10 days ago, still listed
    { set_key: "OEV1-GARG", set_name: "Disney • Gargoyles Vol.1", edition_type: "Open Edition", pins: 7197, first_mint_at: "2026-10-29T00:54:18Z", last_mint_at: "2026-11-08T18:00:00Z" },
    // started this week, stopped minting 2 days ago: ended
    { set_key: "OEEV1-MNFL", set_name: "Walt Disney Animation Studios • Mickey & Friends Vol.1", edition_type: "Open Event Edition", pins: "5667", first_mint_at: "2026-11-03T09:36:01Z", last_mint_at: "2026-11-06T17:00:01Z" },
    // stopped before the week and started before it: not this week's drop
    { set_key: "OEV2-RATA", set_name: "Pixar Animation Studios • Ratatouille Vol.2", edition_type: "Open Edition", pins: 813, first_mint_at: "2026-10-26T00:52:23Z", last_mint_at: "2026-10-27T15:59:34Z" },
  ]

  it("lists what is minting now and what started and stopped this week — no price, no invented end", () => {
    const d = buildPinnacleOpenEditionDrops(sets, NOW)
    expect(d.map((x) => [x.dist_id, x.status, x.kind])).toEqual([
      ["OEV1-GARG", "open", "open_edition"],
      ["OEEV1-MNFL", "ended", "open_edition"],
    ])
    expect(d[0]).toMatchObject({ title: "Gargoyles Vol.1 (Open Edition)", retail_usd: null, end_time: null, collection: "disney_pinnacle" })
    // an ended set's end is its last mint, stated only once it has stopped
    expect(d[1].end_time).toBe("2026-11-06T17:00:01.000Z")
  })

  it("titles fall back to the set key and the edition type", () => {
    expect(openEditionTitle(null, null, "OEV9-XXXX")).toBe("OEV9-XXXX (Open Edition)")
    expect(openEditionTitle("Disney • Trading Event Vol.2", "Open Event Edition", "k")).toBe("Trading Event Vol.2 (Open Event Edition)")
  })

  const state = [
    { product: "nba", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:50:00Z" },
    { product: "nfl", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:49:00Z" },
  ]
  const base = { atlas_pack_market_state: { data: state }, atlas_pack_market: { data: [] }, panini_pack_drops: { data: freshPanini } }

  it("a mint lane behind the chain head is UNREAD — never 'no Open Editions on sale'", async () => {
    const r = await cal(fakeSb({ ...base, "rpc:get_pinnacle_open_edition_drops": { data: { lane_as_of: null, sets } } }), NOW)
    expect(r.complete).toBe(false)
    expect(r.complete_at.pinnacle_oe).toBeNull()
    expect(r.drops.some((d) => d.kind === "open_edition")).toBe(false)
  })

  it("a fresh read adds the minting sets; a failed read throws", async () => {
    const r = await cal(fakeSb({ ...base, "rpc:get_pinnacle_open_edition_drops": { data: { lane_as_of: "2026-11-08T19:56:00Z", sets } } }), NOW)
    expect(r.complete).toBe(true)
    expect(r.drops.filter((d) => d.kind === "open_edition").map((d) => d.dist_id)).toEqual(["OEV1-GARG", "OEEV1-MNFL"])
    await expect(cal(fakeSb({ ...base, "rpc:get_pinnacle_open_edition_drops": { error: { message: "denied" } } }), NOW)).rejects.toThrow(/get_pinnacle_open_edition_drops: denied/)
  })
})

describe("a delivered pre-order or draw is over", () => {
  const state = [
    { product: "nba", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:50:00Z" },
    { product: "nfl", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:49:00Z" },
    { product: "disney", last_complete_pass_started_at: "2026-11-08T19:45:00Z", last_complete_at: "2026-11-08T19:46:00Z" },
  ]
  // Pinnacle "Stitch in Costume Vol.1": draw requests closed 11-06 9 AM PT and it sold out, yet Atlas's
  // end_time is the leftover waiting room's (11-13). Winners opened their packs from 11-06.
  const stitch = row({ product: "disney", dist_id: "8912", title: "Stitch in Costume Vol.1", start_time: "2026-10-30T18:00:00Z", end_time: "2026-11-13T17:00:00Z" })
  const caseRow = row({ dist_id: "8916" })
  const base = { atlas_pack_market_state: { data: state }, atlas_pack_market: { data: [stitch, caseRow] }, panini_pack_drops: { data: freshPanini } }

  it("packs already being opened → ended, Pinnacle's end = first open; none opened → still open", async () => {
    const r = await cal(fakeSb({ ...base, pinnacle_pack_opens: { data: [{ opened_at: "2026-11-06T17:20:00Z" }] } }), NOW)
    expect(r.drops.find((d) => d.dist_id === "8912")).toMatchObject({ status: "ended", end_time: "2026-11-06T17:20:00.000Z" })
    expect(r.drops.find((d) => d.dist_id === "8916")?.status).toBe("open")

    const r2 = await cal(fakeSb(base), NOW)
    expect(r2.drops.find((d) => d.dist_id === "8912")?.status).toBe("open")
  })

  it("pack MINTS do not end a draw — Pinnacle mints a release's whole supply on day one", async () => {
    const r = await cal(fakeSb({ ...base, pack_nft_mints: { data: [{ minted_at: "2026-10-30T18:59:31Z" }] } }), NOW)
    expect(r.drops.find((d) => d.dist_id === "8912")?.status).toBe("open")
  })

  it("a Top Shot pre-order whose packs are being ripped is over, keeping Dapper's close time", async () => {
    const r = await cal(fakeSb({ ...base, pack_rips: { data: [{ dist_id: "8916" }] } }), NOW)
    expect(r.drops.find((d) => d.dist_id === "8916")).toMatchObject({ status: "ended", end_time: "2026-11-11T20:00:00.000Z" })
  })

  it("a failed opens read throws — never posts a possibly-over draw as open", async () => {
    await expect(cal(fakeSb({ ...base, pinnacle_pack_opens: { error: { message: "timeout" } } }), NOW)).rejects.toThrow(/pinnacle_pack_opens\(8912\): timeout/)
  })
})
