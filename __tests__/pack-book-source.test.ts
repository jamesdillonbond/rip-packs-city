import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: vi.fn() } }))

import {
  ATLAS_BOOK_MAX_AGE_MS,
  STUDIO_LAG_MS,
  atlasRowToListing,
  chooseBookSource,
  type AtlasBook,
  type AtlasBookRow,
} from "@/lib/packs/pack-book-source"

// #218 (2026-10-31): Studio's pack index froze 10-29 ~8 AM PT; Atlas kept listing live.
const NOW = Date.parse("2026-11-01T03:00:00Z")
const row = (over: Partial<AtlasBookRow> = {}): AtlasBookRow => ({
  dist_id: "8905", dist_uuid: "u-8905", title: "Darryn Peterson Tip-Off Pack", tier: "common",
  image_url: "https://img", pack_type: "pack", dist_type: "RSVP", slots: 3, retail_usd: 10,
  start_time: "2026-10-30T19:00:00Z", low_ask_usd: 10.27, num_listed: 80,
  latest_listed_at: "2026-10-31T22:54:03Z", observed_at: "2026-11-01T02:40:00Z", ...over,
})
const book = (over: Partial<AtlasBook> = {}): AtlasBook => ({
  product: "nba", complete_at: "2026-11-01T02:45:00Z", complete_pass_started_at: "2026-11-01T02:30:00Z",
  dists_in_book: 5347, atlas_newest_listing_at: "2026-10-31T22:54:03Z",
  studio_newest_listing_at: "2026-10-29T14:50:30Z", rows: [row()], ...over,
})

describe("chooseBookSource", () => {
  it("uses Atlas when Studio's newest listing is days behind Atlas's (the 10-31 live shape)", () => {
    expect(chooseBookSource(book(), NOW)).toEqual({ source: "atlas", reason: "studio_behind" })
  })

  it("keeps Studio when Studio is current (within the lag bar)", () => {
    const d = chooseBookSource(book({ studio_newest_listing_at: new Date(Date.parse("2026-10-31T22:54:03Z") - STUDIO_LAG_MS + 60_000).toISOString() }), NOW)
    expect(d.source).toBe("studio")
    expect(d.reason).toBe("studio_current")
  })

  it("never uses an INCOMPLETE Atlas pass — a partial walk is not the market", () => {
    expect(chooseBookSource(book({ complete_at: null }), NOW)).toEqual({ source: "studio", reason: "atlas_incomplete" })
  })

  it("never uses a STALE Atlas book", () => {
    const old = new Date(NOW - ATLAS_BOOK_MAX_AGE_MS - 60_000).toISOString()
    expect(chooseBookSource(book({ complete_at: old }), NOW).source).toBe("studio")
  })

  it("keeps Studio when the Atlas read failed or is empty (fail toward Studio, never toward empty)", () => {
    expect(chooseBookSource(null, NOW).source).toBe("studio")
    expect(chooseBookSource(book({ rows: [] }), NOW).source).toBe("studio")
    expect(chooseBookSource(book({ atlas_newest_listing_at: null }), NOW).source).toBe("studio")
  })

  it("uses a complete, recent Atlas book when Studio has no listing time at all", () => {
    expect(chooseBookSource(book({ studio_newest_listing_at: null }), NOW).source).toBe("atlas")
  })
})

describe("atlasRowToListing", () => {
  it("maps an Atlas dist to the PackListing shape with its real listing count", () => {
    const l = atlasRowToListing(row())!
    expect(l.distId).toBe("8905")
    expect(l.packListingId).toBe("u-8905")
    expect(l.lowestAsk).toBe(10.27)
    expect(l.momentsPerPack).toBe(3)
    expect(l.listingCount).toBe(80)
    expect(l.retailPrice).toBe(10)
    expect(l.liveFields).toEqual({ title: true, tier: true, image: true, slots: true })
  })

  it("drops a dist with no real ask instead of publishing a $0 pack", () => {
    expect(atlasRowToListing(row({ low_ask_usd: 0 }))).toBeNull()
    expect(atlasRowToListing(row({ low_ask_usd: null }))).toBeNull()
  })

  it("marks placeholder fields as NOT live so callers prefer their stored row", () => {
    const l = atlasRowToListing(row({ title: null, tier: null, image_url: null, slots: null }))!
    expect(l.title).toBe("Pack #8905")
    expect(l.liveFields).toEqual({ title: false, tier: false, image: false, slots: false })
  })
})

// #218 (2026-11-18): Studio HTTP 530 since 11-17. Golazos had no Atlas mapping although the
// walker has carried 'laliga' since 11-08, so its book threw on every snapshot tick.
describe("Golazos reads the laliga Atlas book", () => {
  it("maps every listing collection to its Atlas product", async () => {
    const { atlasProductFor } = await import("@/lib/packs/pack-book-source")
    expect(atlasProductFor("nba-top-shot")).toBe("nba")
    expect(atlasProductFor("nfl-all-day")).toBe("nfl")
    expect(atlasProductFor("laliga-golazos")).toBe("laliga")
  })

  it("serves the Atlas book when Studio answers 530 (the 11-18 live shape)", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    const rpc = supabaseAdmin.rpc as unknown as ReturnType<typeof vi.fn>
    rpc.mockReset()
    rpc.mockResolvedValue({
      data: book({
        product: "laliga",
        complete_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        atlas_newest_listing_at: "2026-07-15T13:00:33Z",
        studio_newest_listing_at: "2026-09-23T00:00:00Z",
        rows: [row({ dist_id: "400", title: "Joaquin Farewell", low_ask_usd: 1, num_listed: 1 })],
      }),
      error: null,
    })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 530, json: async () => ({}) })))
    const { fetchPackBook } = await import("@/lib/packs/pack-book-source")
    const out = await fetchPackBook("laliga-golazos", { force: true })
    expect(rpc).toHaveBeenCalledWith("atlas_pack_book", { p_product: "laliga" })
    expect(out.source).toBe("atlas")
    expect(out.reason).toBe("studio_read_failed")
    expect(out.listings.map((l) => [l.distId, l.lowestAsk])).toEqual([["400", 1]])
    vi.unstubAllGlobals()
  })

  it("still THROWS when Studio fails and the Atlas book is unusable — never an empty book", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    const rpc = supabaseAdmin.rpc as unknown as ReturnType<typeof vi.fn>
    rpc.mockReset()
    rpc.mockResolvedValue({ data: book({ product: "laliga", complete_at: null }), error: null })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 530, json: async () => ({}) })))
    const { fetchPackBook } = await import("@/lib/packs/pack-book-source")
    await expect(fetchPackBook("laliga-golazos", { force: true })).rejects.toThrow(/530/)
    vi.unstubAllGlobals()
  })
})
