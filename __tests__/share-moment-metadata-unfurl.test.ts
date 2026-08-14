import { describe, it, expect, vi, beforeEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// The /moment/<id> and /share/<wallet> LINK PREVIEWS.
//
// Neither had any test of its `generateMetadata` output. The profile unfurl got
// one on 2026-08-13, after shipping a false "$0 portfolio" about named
// collectors for two months undetected — the same blind spot, on the two
// siblings, one of which (`/moment/<id>`) is the most-shared URL RPC has: it is
// where every link posted into a Discord or a DM lands.
//
// What is asserted is the CONTRACT, not the copy. Next REPLACES `openGraph` and
// `twitter` wholesale when a route redefines them rather than merging, so any
// field a route wants has to be restated — and a partial object silently drops
// siteName / creator / type from lib/seo.ts, which is invisible locally and
// only shows up in someone else's timeline.
// ─────────────────────────────────────────────────────────────────────────────

// Mock the DATA SEAM rather than Supabase: generateMetadata reads through
// `fetchMomentDetail`, which already returns the `{ data, ok }` envelope the
// failed-read branch keys on. Stubbing the client underneath would have to
// reproduce that envelope correctly to test anything about it.
const state: { detail: any; ok: boolean } = { detail: null, ok: true }

vi.mock("@/lib/moment-detail/fetchers", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchMomentDetail: async () => ({ data: state.detail, ok: state.ok }),
}))

describe("/share/[wallet] unfurl", () => {
  it("carries a complete card contract", async () => {
    const { generateMetadata } = await import("@/app/share/[wallet]/page")
    const m: any = await generateMetadata({
      params: Promise.resolve({ wallet: "0x1234567812345678" }),
    } as never)

    expect(m.twitter.card).toBe("summary_large_image")
    expect(m.openGraph.siteName).toBe("Rip Packs City")
    expect(m.openGraph.type).toBe("website")
    expect(m.openGraph.url).toContain("/share/0x1234567812345678")
    expect(m.twitter.site).toMatch(/^@/)
    expect(m.twitter.creator).toMatch(/^@/)
  })

  it("gives the X card a line of copy under the picture", async () => {
    // `twitter.description` was simply absent, so the card had a title and an
    // image and nothing else — and the root default does not survive, because
    // defining `twitter` replaces it.
    const { generateMetadata } = await import("@/app/share/[wallet]/page")
    const m: any = await generateMetadata({
      params: Promise.resolve({ wallet: "0xabc" }),
    } as never)
    expect(m.twitter.description).toBeTruthy()
  })

  it("ships alt text and explicit dimensions", async () => {
    const { generateMetadata } = await import("@/app/share/[wallet]/page")
    const m: any = await generateMetadata({
      params: Promise.resolve({ wallet: "0xabc" }),
    } as never)
    expect(m.openGraph.images[0]).toMatchObject({ width: 1200, height: 630 })
    expect(m.openGraph.images[0].alt).toBeTruthy()
    expect(m.twitter.images[0].alt).toBeTruthy()
  })

  it("URL-encodes the wallet into the image and canonical", async () => {
    const { generateMetadata } = await import("@/app/share/[wallet]/page")
    const m: any = await generateMetadata({
      params: Promise.resolve({ wallet: "0x ab/cd" }),
    } as never)
    expect(m.openGraph.images[0].url).not.toContain(" ")
    expect(m.openGraph.url).not.toContain(" ")
  })
})

describe("/moment/[id] unfurl", () => {
  beforeEach(() => {
    state.ok = true
    state.detail = {
      ok: true,
      edition: {
        id: "e-1",
        external_id: "1:2",
        collection_slug: "nba_top_shot",
        player_name: "Damian Lillard",
        team_name: "Portland Trail Blazers",
        set_name: "Base Set",
        tier: "RARE",
        circulation_count: 1000,
      },
      resolved: { serial_number: 7 },
      fmv: { sales_count_30d: 3, days_since_sale: 2 },
      renders: [],
    }
  })

  it("ships explicit dimensions on the image", async () => {
    // ⚠ Not decoration on the platform's most-shared URL: without stated
    // dimensions a crawler has to fetch and measure the PNG before committing
    // to a large card, and several fall back to a small thumbnail rather than
    // wait. The image used to be a bare relative string.
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.images[0]).toMatchObject({ width: 1200, height: 630 })
  })

  it("ships alt text on both cards", async () => {
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.images[0].alt).toBeTruthy()
    expect(m.twitter.images[0].alt).toBeTruthy()
  })

  it("does not put a PRICE in the alt text", async () => {
    // The card withholds figures on a failed read, and this string is built
    // before we know whether the card's own reads succeeded — so a price here
    // could contradict the picture it describes.
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.images[0].alt).not.toMatch(/\$/)
  })

  it("restates the root fields Next would otherwise drop", async () => {
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.siteName).toBe("Rip Packs City")
    expect(m.openGraph.type).toBe("website")
    expect(m.twitter.card).toBe("summary_large_image")
    expect(m.twitter.site).toMatch(/^@/)
    expect(m.twitter.creator).toMatch(/^@/)
  })

  it("points the image at this moment's own card", async () => {
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.images[0].url).toContain("/api/og/moment/abc")
  })

  it("keeps openGraph.url and the canonical pointing at the same page", async () => {
    // A card whose og:url disagrees with the canonical splits engagement across
    // two identities for one Moment.
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.openGraph.url).toBe(m.alternates.canonical)
  })

  it("noindexes rather than soft-404s when the moment cannot be read", async () => {
    // Pre-existing behaviour (deep-audit D10) — asserted so a future metadata
    // edit cannot quietly de-index or mis-index a real Moment.
    state.ok = false
    state.detail = null
    const { generateMetadata } = await import("@/app/moment/[id]/page")
    const m: any = await generateMetadata({ params: Promise.resolve({ id: "abc" }) } as never)
    expect(m.robots?.index).toBe(false)
  })
})
