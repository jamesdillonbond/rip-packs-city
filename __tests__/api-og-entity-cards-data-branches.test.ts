import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import {
  installOgCapture,
  resetOgCapture,
  ogText,
  ogImageSrcs,
  type OgCapture,
} from "./helpers/og-capture"

// DATA-BRANCH tests for the three sibling entity OG cards — /api/og/{set,team,series}.
//
// After og/moment, og/edition and og/pack were covered, these became the three
// worst-covered files in the primary gate (45.8% / 46.0% / 48.0% branch). They
// share one shape almost line for line: resolve the collection, fan out a detail
// RPC plus a 4-thumbnail montage query, and hand the result to `renderEntityOg`.
// So they get ONE parameterised suite rather than three near-identical files —
// which also means a fourth entity card can be covered by adding a row.
//
// What is worth pinning here is not the layout but the claims:
//
//  • the montage survives a failed DETAIL read (the two queries are independent,
//    and a card with art and a generic title beats a blank one),
//  • the aggregate-FMV stat is suppressed unless the figure is real and positive
//    — a "$0 Aggregate FMV" on a share card is a claim about a set's worth
//    manufactured from an unpriced catalogue,
//  • and the guard path fires BEFORE any query, so a bad slug can never render
//    another entity's data.
//
// ⚠ NOT asserted, deliberately: closed-market FMV suppression. og/moment and
// og/edition suppress the figure on UFC because a frozen last-trading-day price
// read as current is an overclaim — but these three cards show an AGGREGATE, and
// their own pages (/[collection]/{set,series}/[slug]) do not suppress it either.
// So the cards are consistent with the surfaces they represent, and changing that
// is a product decision about aggregate FMV on a dead market, not a test fix.

const capture: { c: OgCapture | null } = { c: null }

type Card = {
  name: string
  path: string
  detailRpc: string
  imagesRpc: string
  /** A detail row shaped the way the card reads it. */
  detail: Record<string, unknown>
  /** The title that row should produce. */
  title: string
  /** The eyebrow segment identifying the entity kind. */
  eyebrow: string
  /** The title rendered when the detail read comes back empty. */
  fallbackTitle: string
}

const CARDS: Card[] = [
  {
    name: "set",
    path: "@/app/api/og/set/route",
    detailRpc: "get_set_detail",
    imagesRpc: "get_set_editions",
    detail: { set_name: "Base Set", edition_count: 1234, fmv_total_usd: 98765 },
    title: "Base Set",
    eyebrow: "SET",
    fallbackTitle: "Set",
  },
  {
    name: "team",
    path: "@/app/api/og/team/route",
    detailRpc: "get_team_detail",
    imagesRpc: "get_team_top_editions",
    detail: { team_name: "Portland Trail Blazers", edition_count: 1234, fmv_total_usd: 98765 },
    title: "Portland Trail Blazers",
    eyebrow: "TEAM",
    fallbackTitle: "Team",
  },
  {
    name: "series",
    path: "@/app/api/og/series/route",
    detailRpc: "get_series_detail",
    imagesRpc: "get_series_editions",
    detail: { display_label: "Series 4", edition_count: 1234, fmv_total_usd: 98765 },
    title: "Series 4",
    eyebrow: "SERIES",
    fallbackTitle: "Series",
  },
]

function mockRpc(handler: (name: string) => { data?: unknown; error?: unknown }) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async (name: string) => handler(name),
    },
  }))
  vi.doMock("@/lib/og/img-data", () => ({
    ogImageDataUri: async (u: string | null | undefined) => (u ? "data:image/png;base64,AAAA" : null),
    ogImageDataUris: async (us: string[]) => us.map(() => "data:image/png;base64,AAAA"),
  }))
}

async function render(card: Card, query: string) {
  const { GET } = await import(card.path)
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/${card.name}${query}`))
  return capture.c!.element()
}

const TS = "?collection=nba-top-shot&slug=base-set"

/** A handler serving this card's detail + a 4-thumb montage. */
function healthy(card: Card, detail: Record<string, unknown> = card.detail) {
  return (name: string) => {
    if (name === card.detailRpc) return { data: [detail], error: null }
    if (name === card.imagesRpc) {
      return {
        data: [
          { thumbnail_url: "https://x.test/1.png" },
          { thumbnail_url: "https://x.test/2.png" },
          { thumbnail_url: null }, // filtered — a null must not become an <img>
          { thumbnail_url: "https://x.test/4.png" },
        ],
        error: null,
      }
    }
    return { data: null, error: null }
  }
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.doUnmock("@/lib/og/img-data")
  resetOgCapture()
})

describe.each(CARDS.map((c) => [c.name, c] as const))("/api/og/%s — the data branch", (_n, card) => {
  it("prints the title, edition count and aggregate FMV", async () => {
    mockRpc(healthy(card))
    const text = ogText(await render(card, TS))

    expect(text).toContain(card.title)
    expect(text).toContain("NBA TOP SHOT")
    expect(text).toContain(card.eyebrow)
    expect(text).toContain("1,234 editions")
    expect(text).toContain("Aggregate FMV")
    // >= 1000 formats as rounded, thousands-separated dollars.
    expect(text).toContain("$98,765")
  })

  it("renders the montage, dropping rows with no thumbnail", async () => {
    // A null thumbnail_url must be filtered out rather than becoming an <img>
    // with no source — that is how an unfurl ends up with a broken tile.
    mockRpc(healthy(card))
    expect(ogImageSrcs(await render(card, TS))).toHaveLength(3)
  })

  it("accepts a bare object detail as well as a one-element array", async () => {
    mockRpc((name) => (name === card.detailRpc ? { data: card.detail, error: null } : { data: [], error: null }))
    expect(ogText(await render(card, TS))).toContain(card.title)
  })

  // ── The FMV gate ──────────────────────────────────────────────────────────

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["null", null],
  ])("omits the Aggregate FMV stat when the total is %s", async (_label, fmv) => {
    // "$0 Aggregate FMV" on a share card is a claim about the set's worth
    // manufactured from an unpriced catalogue. Absent beats zero.
    mockRpc(healthy(card, { ...card.detail, fmv_total_usd: fmv }))
    const text = ogText(await render(card, TS))
    expect(text).toContain(card.title) // the card still renders
    expect(text).not.toContain("Aggregate FMV")
    expect(text).not.toContain("$0")
  })

  it("omits the subtitle when the edition count is absent or zero", async () => {
    mockRpc(healthy(card, { ...card.detail, edition_count: 0 }))
    expect(ogText(await render(card, TS))).not.toContain("editions")
  })

  // ── Failure + guard branches ──────────────────────────────────────────────

  it("keeps the montage when the DETAIL read comes back empty", async () => {
    // The two queries are independent, so a card with real art and a generic
    // title is strictly better than a blank one.
    mockRpc((name) => {
      if (name === card.detailRpc) return { data: [], error: null }
      return { data: [{ thumbnail_url: "https://x.test/1.png" }], error: null }
    })
    const el = await render(card, TS)
    expect(ogText(el)).toContain(card.fallbackTitle)
    expect(ogImageSrcs(el)).toHaveLength(1)
  })

  it("renders the fallback card when the whole fan-out throws", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        rpc: async () => {
          throw new Error("connection reset")
        },
      },
    }))
    vi.doMock("@/lib/og/img-data", () => ({
      ogImageDataUri: async () => null,
      ogImageDataUris: async () => [],
    }))
    const text = ogText(await render(card, TS))
    expect(text).toContain(card.fallbackTitle)
    expect(text).not.toContain(card.title)
    expect(text).not.toContain("Aggregate FMV")
  })

  it.each([
    ["an unknown collection", "?collection=not-a-collection&slug=x"],
    ["a missing slug", "?collection=nba-top-shot"],
    ["no params", ""],
  ])("renders the generic brand card for %s, without querying", async (_l, query) => {
    // The guard fires BEFORE the RPCs, so none of the entity data may appear
    // even though the stub would happily have returned it.
    let called = 0
    mockRpc((name) => {
      called++
      return healthy(card)(name)
    })
    const text = ogText(await render(card, query))
    expect(called).toBe(0)
    expect(text).toContain("RIP PACKS CITY")
    expect(text).not.toContain(card.title)
  })

  it("always renders at 1200x630", async () => {
    mockRpc(healthy(card))
    await render(card, TS)
    expect(capture.c!.options()).toMatchObject({ width: 1200, height: 630 })
  })
})

describe("/api/og/team — the franchise distinction", () => {
  const card = CARDS.find((c) => c.name === "team")!

  it("says FRANCHISE when the row is flagged as one", async () => {
    // Golazos/AllDay clubs are franchises, not teams; the eyebrow is the only
    // place the card says which, so a dropped flag mislabels every club card.
    mockRpc(healthy(card, { ...card.detail, is_franchise: true }))
    const text = ogText(await render(card, TS))
    expect(text).toContain("FRANCHISE")
    expect(text).not.toContain("· TEAM")
  })

  it("says TEAM when the flag is absent or false", async () => {
    mockRpc(healthy(card, { ...card.detail, is_franchise: false }))
    expect(ogText(await render(card, TS))).toContain("TEAM")
  })
})

describe("/api/og/series — the season subtitle", () => {
  const card = CARDS.find((c) => c.name === "series")!

  it("prefers the season over the edition count", async () => {
    mockRpc(healthy(card, { ...card.detail, season: "2024-25" }))
    const text = ogText(await render(card, TS))
    expect(text).toContain("2024-25")
    expect(text).not.toContain("1,234 editions")
  })

  it("falls back to the edition count when there is no season", async () => {
    mockRpc(healthy(card, { ...card.detail, season: null }))
    expect(ogText(await render(card, TS))).toContain("1,234 editions")
  })
})
