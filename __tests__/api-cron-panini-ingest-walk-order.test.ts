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
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      if (table === "panini_products" || table === "panini_pack_pages") {
        const res = table === "panini_products" ? st.products : st.pages
        const r: any = { select: () => r, eq: () => r, order: () => r, then: (f: any, g: any) => Promise.resolve(res).then(f, g) }
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
              last_seen_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
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

  it("a pack-pages read failure is pack_urls:null (runner keeps its built-in list), not []", async () => {
    st.pages = { data: null, error: { message: "nope" } }
    const j = await (await GET(req())).json()
    expect(j.pack_urls).toBeNull()
    expect(j.pack_urls_error).toBe("nope")
  })
})
