import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// The GET arm of /api/cron/panini-ingest: the walk ORDER the residential Panini runner uses.
//
// WHY THIS FILE EXISTS, AND WHY THE `complete` FLAG IS THE THING IT PINS.
// The runner classifies an enumerated psku as a BRAND-NEW discovery when it is absent from this
// response, and walks brand-new discoveries FIRST (a card with no row has no price at all). That
// test is only sound when the response is the COMPLETE catalogue. The first version of this route
// returned the stalest 1,000 — under which every RECENTLY WALKED edition is also absent, so it
// reads as "brand new" and gets promoted to the front of the queue. The grid surfaces the most
// actively listed cards, i.e. the ones walked most recently, so that would have put hundreds of
// already-fresh editions ahead of the stale backlog the whole change exists to drain.
//
// ⭐ The durable shape: an "absent from the list" test is only as good as the list's COMPLETENESS,
// and a bound chosen for the reader's convenience silently redefines what absence means. So the
// route must never claim `complete` when it paged off or trimmed anything, and these cases fail
// if it ever does.

const st = vi.hoisted(() => ({
  total: 1003 as number,
  pageCalls: [] as Array<[number, number]>,
  // Multi-product (2026-09-28): the registry reads the GET now makes beside the catalogue.
  products: { data: [{ set_id: 2332, name: "WC", walk_cards: true }] as unknown[] | null, error: null as null | { message: string } },
  pages: { data: [{ url: "https://nft.paniniamerica.net/marketplace-details/subpack-5270763-1038.html" }] as unknown[] | null, error: null as null | { message: string } },
  // Set ids of the catalogue rows by index, so a test can put another product in the catalogue.
  setIdAt: ((): number => 2332) as (i: number) => number,
  // panini_user_holdings (the collector walk) — held pskus, 2026-09-29.
  holdings: [] as Array<{ psku: string | null }>,
  holdingsError: null as null | { message: string },
  // Epoch ms of catalogue row 0's last_seen_at (rows ascend 1 s apart). Recent by default, so the
  // aged-priority rule (2026-10-03) stays out of tests about something else.
  baseMs: 0,
  pageOrder: [] as Array<[string, unknown]>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      if (table === "panini_user_holdings") {
        const h: any = {
          select: () => h, order: () => h,
          range: async (from: number, to: number) =>
            st.holdingsError ? { data: null, error: st.holdingsError } : { data: st.holdings.slice(from, to + 1), error: null },
        }
        return h
      }
      if (table === "panini_products" || table === "panini_pack_pages") {
        const res = table === "panini_products" ? st.products : st.pages
        const r: any = { select: () => r, eq: () => r, order: (col: string, o: unknown) => { if (table === "panini_pack_pages") st.pageOrder.push([col, o]); return r }, then: (f: any, g: any) => Promise.resolve(res).then(f, g) }
        return r
      }
      const b: any = {
        select: () => b,
        order: () => b,
        range: async (from: number, to: number) => {
          st.pageCalls.push([from, to])
          const size = to - from + 1
          const rows = []
          for (let i = from; i < Math.min(from + size, st.total); i++) {
            rows.push({
              external_id: `packcard-${st.setIdAt(i)}_1_${i}_1`,
              // Ascending age index doubles as the stalest-first assertion below.
              last_seen_at: new Date(st.baseMs + i * 1000).toISOString(),
            })
          }
          return { data: rows, error: null }
        },
      }
      return b
    },
  },
}))

let GET: any
beforeEach(async () => {
  vi.resetModules()
  st.total = 1003
  st.pageCalls = []
  st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }], error: null }
  st.pages = { data: [{ url: "https://nft.paniniamerica.net/marketplace-details/subpack-5270763-1038.html" }], error: null }
  st.setIdAt = () => 2332
  st.holdings = []
  st.holdingsError = null
  st.baseMs = Date.now() - 3_600_000
  st.pageOrder = []
  process.env.INGEST_SECRET_TOKEN = "tok"
  ;({ GET } = await import("@/app/api/cron/panini-ingest/route"))
})

const req = (qs = "", auth: string | null = "Bearer tok") =>
  makeReq({ url: `https://t/api/cron/panini-ingest${qs}`, method: "GET", ...(auth ? { auth } : {}) })

describe("GET /api/cron/panini-ingest — walk order", () => {
  it("401s without the ingest token", async () => {
    expect((await GET(req("", null))).status).toBe(401)
    expect((await GET(req("", "Bearer wrong"))).status).toBe(401)
  })

  it("returns the WHOLE catalogue, stalest first, and says so", async () => {
    const j = await (await GET(req())).json()
    expect(j.count).toBe(1003)
    expect(j.pskus).toHaveLength(1003)
    expect(j.order).toBe("last_seen_at_asc")
    // Paged past the 1,000-row PostgREST cap rather than being clamped by it (#71).
    expect(st.pageCalls.length).toBeGreaterThan(1)
    expect(j.complete).toBe(true)
    expect(j.truncated).toBe(false)
    // Stalest first: the first psku is the oldest last_seen_at, the last is the newest.
    expect(new Date(j.oldest_last_seen_at).getTime())
      .toBeLessThan(new Date(j.newest_returned_last_seen_at).getTime())
  })

  it("⚠ a TRIMMED list is never `complete` — this is the defect that shipped and was caught", async () => {
    const j = await (await GET(req("?limit=5"))).json()
    expect(j.count).toBe(5)
    expect(j.pskus).toHaveLength(5)
    // The rows themselves are still the stalest — the flag is about COMPLETENESS, not order.
    expect(j.complete).toBe(false)
    // A caller that promotes "absent from pskus" to the front of its queue must not do so here.
    expect(j.complete).not.toBe(true)
  })

  it("a catalogue larger than maxPages reports truncated, not a silent short list", async () => {
    st.total = 25_000 // 20 pages x 1,000 is the helper's ceiling
    const j = await (await GET(req())).json()
    expect(j.count).toBe(20_000)
    expect(j.truncated).toBe(true)
    expect(j.complete).toBe(false)
  })
})

// Multi-product (2026-09-28). The GET is also how the runner learns WHICH products to walk, which
// sports to enumerate for discovery and which pack pages to open — so a registry that cannot be
// read must narrow the walk to the historical WC scope, never widen it or empty it.
describe("GET /api/cron/panini-ingest — multi-product walk scope", () => {
  it("serves only catalogue rows of products with walk_cards, plus the scope it used", async () => {
    st.total = 6
    st.setIdAt = (i) => (i % 2 === 0 ? 2332 : 9999) // 9999 = a product the registry has not admitted
    const j = await (await GET(req())).json()
    expect(j.walk_set_ids).toEqual([2332])
    expect(j.pskus).toHaveLength(3)
    for (const p of j.pskus) expect(p.startsWith("packcard-2332_")).toBe(true)
    expect(j.pack_urls).toEqual(["https://nft.paniniamerica.net/marketplace-details/subpack-5270763-1038.html"])
    expect(Array.isArray(j.discovery_sports) && j.discovery_sports.includes("Soccer")).toBe(true)
  })

  it("a registry READ FAILURE falls back to WC only and says so — never an empty or widened walk", async () => {
    st.total = 4
    st.setIdAt = (i) => (i < 2 ? 2332 : 9999)
    st.products = { data: null, error: { message: "boom" } }
    const j = await (await GET(req())).json()
    expect(j.walk_set_ids).toEqual([2332])
    expect(j.products_error).toBe("boom")
    expect(j.pskus).toHaveLength(2)
  })

  // ── BOOTSTRAP (2026-09-30) ────────────────────────────────────────────────
  // 2420 (2026 Prizm WNBA) was admitted with 0 catalogue rows and 0 cards were written 3 hours
  // later: fresh discoveries queue behind the held list and every other sport's new cards.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  it("narrows the walk to a just-admitted product with NO catalogue rows that the grid lists", async () => {
    st.total = 4
    st.products = { data: [
      { set_id: 2332, name: "WC", walk_cards: true },
      { set_id: 2420, name: "WNBA", walk_cards: true, last_grid_items: 1580, walk_cards_since: hoursAgo(3) },
    ], error: null }
    st.holdings = [{ psku: "packcard-2332_9_9_9" }, { psku: "packcard-2420_1_2_3" }]
    const j = await (await GET(req())).json()
    expect(j.walk_set_ids).toEqual([2420])
    expect(j.bootstrap_set_ids).toEqual([2420])
    // Nothing of the other products is served, so the runner's fresh 2420 discoveries go first.
    expect(j.pskus).toEqual(["packcard-2420_1_2_3"])
    expect(j.priority_pskus).toEqual(["packcard-2420_1_2_3"])
    expect(j.complete).toBe(true)
  })

  it("does NOT bootstrap once the product has a catalogue row, when it is off the grid, or after the age bound", async () => {
    for (const [p2420, setIdAt] of [
      [{ last_grid_items: 1580, walk_cards_since: hoursAgo(3) }, (i: number) => (i === 0 ? 2420 : 2332)], // has a row
      [{ last_grid_items: 0, walk_cards_since: hoursAgo(3) }, () => 2332],                                // not on the grid
      [{ last_grid_items: 1580, walk_cards_since: hoursAgo(13) }, () => 2332],                            // admitted > 12 h ago
      [{ last_grid_items: 1580, walk_cards_since: null }, () => 2332],                                    // no admission stamp
    ] as const) {
      st.total = 4
      st.setIdAt = setIdAt
      st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }, { set_id: 2420, name: "WNBA", walk_cards: true, ...p2420 }], error: null }
      const j = await (await GET(req())).json()
      expect(j.bootstrap_set_ids).toEqual([])
      expect(j.walk_set_ids).toEqual([2332, 2420])
    }
  })

  it("never bootstraps off a TRUNCATED catalogue — it cannot prove a count of zero", async () => {
    st.total = 25_000
    st.products = { data: [
      { set_id: 2332, name: "WC", walk_cards: true },
      { set_id: 2420, name: "WNBA", walk_cards: true, last_grid_items: 1580, walk_cards_since: hoursAgo(1) },
    ], error: null }
    const j = await (await GET(req())).json()
    expect(j.truncated).toBe(true)
    expect(j.bootstrap_set_ids).toEqual([])
    expect(j.walk_set_ids).toEqual([2332, 2420])
  })

  // ── AGED PRIORITY (2026-10-03) ────────────────────────────────────────────
  // A runner that walks every fresh discovery before any known edition stopped refreshing the
  // catalogue after 22 products were admitted (514 editions > 6 days old). Every runner walks
  // priority_pskus first, so editions past the age line are served there, stalest first, capped.
  // RE-PINNED 2026-10-03 ~4:40 PM PT: aged and held now ALTERNATE (aged first). Held-first starved the
  // aged list once the collector walk named 4,164 held pskus against ~300-370 refreshed per run.
  it("serves catalogue editions older than 5 days in priority_pskus, stalest first, alternating with the held", async () => {
    st.total = 6
    st.baseMs = Date.now() - 6 * 86_400_000 // rows 0..5 are ~6 days old
    st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }, { set_id: 1941, name: null, walk_cards: true }], error: null }
    st.holdings = [{ psku: "packcard-1941_377959_9989801_273" }]
    const j = await (await GET(req())).json()
    expect(j.priority_pskus).toEqual([
      "packcard-2332_1_0_1", "packcard-1941_377959_9989801_273",
      ...Array.from({ length: 5 }, (_, i) => `packcard-2332_1_${i + 1}_1`),
    ])
    expect(j.aged_priority).toBe(6)
    expect(j.held_uncatalogued).toBe(1)
    expect(j.complete).toBe(true)
  })

  it("a FLOOD of held cards cannot starve the aged list: half of any run-sized prefix is aged", async () => {
    st.total = 400
    st.baseMs = Date.now() - 10 * 86_400_000
    st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }, { set_id: 1941, name: null, walk_cards: true }], error: null }
    st.holdings = Array.from({ length: 4000 }, (_, i) => ({ psku: `packcard-1941_9_${i}_9` }))
    const j = await (await GET(req())).json()
    const run = (j.priority_pskus as string[]).slice(0, 340) // ~one run's refreshes, measured 10-03
    expect(run.filter((p) => p.startsWith("packcard-2332_")).length).toBe(170)
    expect(run[0]).toBe("packcard-2332_1_0_1") // the stalest edition leads
  })

  it("serves NO aged priority while every edition is fresher than 5 days", async () => {
    st.total = 6
    const j = await (await GET(req())).json()
    expect(j.aged_priority).toBe(0)
    expect(j.priority_pskus).toEqual([])
  })

  it("caps aged priority at 300 per run so discovery keeps most of the run", async () => {
    st.total = 1003
    st.baseMs = Date.now() - 10 * 86_400_000
    const j = await (await GET(req())).json()
    expect(j.aged_priority).toBe(300)
    expect(j.priority_pskus[0]).toBe("packcard-2332_1_0_1") // the stalest
    expect(j.priority_pskus).toHaveLength(300)
  })

  it("serves run_mode (walk-only runs between the full ones), and a bootstrap run is always full", async () => {
    process.env.PANINI_RUN_MODE = "walk"
    try {
      expect((await (await GET(req())).json()).run_mode).toBe("walk")
      // Bootstrap exists to DISCOVER a just-admitted product's cards — only the grids do that.
      st.total = 4
      st.products = { data: [
        { set_id: 2332, name: "WC", walk_cards: true },
        { set_id: 2420, name: "WNBA", walk_cards: true, last_grid_items: 1580, walk_cards_since: new Date(Date.now() - 3 * 3_600_000).toISOString() },
      ], error: null }
      const j = await (await GET(req())).json()
      expect(j.bootstrap_set_ids).toEqual([2420])
      expect(j.run_mode).toBe("full")
    } finally {
      delete process.env.PANINI_RUN_MODE
    }
  })

  it("pack pages are served stalest-walk first, so pages past the runner's per-run cap still rotate in", async () => {
    // 2026-10-03: the secondary-market pack grid can register more pages than PANINI_PACK_PAGES_MAX
    // (40). Ordered by url alone, every page past the cap would never be opened.
    await GET(req())
    expect(st.pageOrder[0]).toEqual(["last_walked_at", { ascending: true, nullsFirst: true }])
  })

  it("a pack-pages read failure is pack_urls:null (runner keeps its built-in list), not []", async () => {
    st.pages = { data: null, error: { message: "nope" } }
    const j = await (await GET(req())).json()
    expect(j.pack_urls).toBeNull()
    expect(j.pack_urls_error).toBe("nope")
  })

  // ── HELD-BUT-UNCATALOGUED (2026-09-29) ────────────────────────────────────
  // A card nobody has listed is on neither the catalogue nor the grid, so a collector's held
  // edition in an admitted product was never walked (135 of 135 measured). The collector walk
  // knows its psku, and the runner walks any psku it is handed — so it goes first.
  it("queues a held, uncatalogued edition of an admitted product FIRST", async () => {
    st.total = 3
    st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }, { set_id: 1941, name: null, walk_cards: true }], error: null }
    st.holdings = [
      { psku: "packcard-1941_377959_9989801_273" },   // admitted, uncatalogued -> queued
      { psku: "packcard-1941_377959_9989801_273" },   // held twice -> once
      { psku: "packcard-2332_1_0_1" },                // already catalogued -> not duplicated
      { psku: "packcard-1783_1_2_3" },                // product NOT admitted -> never widened
      { psku: null },
    ]
    const j = await (await GET(req())).json()
    expect(j.pskus[0]).toBe("packcard-1941_377959_9989801_273")
    expect(j.held_uncatalogued).toBe(1)
    // Served as its own list too: the runner walks grid discoveries before `pskus` and cannot
    // pick the held ones out of it.
    expect(j.priority_pskus).toEqual(["packcard-1941_377959_9989801_273"])
    expect(j.pskus.filter((p: string) => p === "packcard-2332_1_0_1")).toHaveLength(1)
    expect(j.pskus).not.toContain("packcard-1783_1_2_3")
    expect(j.count).toBe(4)
    expect(j.complete).toBe(true)
  })

  it("a failed holdings read serves the catalogue alone, says so, and does not touch `complete`", async () => {
    st.total = 3
    st.holdingsError = { message: "canceling statement due to statement timeout" }
    const j = await (await GET(req())).json()
    expect(j.pskus).toHaveLength(3)
    expect(j.held_uncatalogued).toBe(0)
    expect(j.priority_pskus).toEqual([])
    expect(j.held_error).toBeTruthy()
    expect(j.complete).toBe(true)
  })
})
