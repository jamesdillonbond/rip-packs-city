import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import {
  installOgCapture,
  resetOgCapture,
  ogText,
  ogImageSrcs,
  type OgCapture,
} from "./helpers/og-capture"

// Per-card DATA-BRANCH test for /api/og/edition — 25.5% branch coverage before
// this landed (35 of 47 branches uncovered), the second-worst file in the primary
// coverage gate.
//
// This card is reached from every `/[collection]/edition/[slug]` unfurl, so it is
// the most-shared social artefact the platform produces. Like its sibling
// og/moment it carries the closed-market FMV suppression — the constraint that a
// frozen UFC price must never be published under a "Current FMV" label — and that
// branch had no test at all.
//
// The existing sweep drives this route with a generic stub and therefore only ever
// sees the "Edition" fallback card. See helpers/og-capture.ts for why the two
// harnesses are complementary rather than redundant.

const capture: { c: OgCapture | null } = { c: null }

function mockDetail(payload: { data?: unknown } | { throws: true }) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async () => {
        if ("throws" in payload) throw new Error("connection reset")
        return { data: payload.data ?? null, error: null }
      },
    },
  }))
  vi.doMock("@/lib/og/img-data", () => ({
    ogImageDataUri: async (u: string | null | undefined) => (u ? `data:image/png;base64,AAAA` : null),
    ogImageDataUris: async (us: string[]) => us.map(() => `data:image/png;base64,AAAA`),
  }))
}

async function render(query: string) {
  const { GET } = await import("@/app/api/og/edition/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/edition${query}`))
  return capture.c!.element()
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

const EDITION = {
  player_name: "Damian Lillard",
  set_name: "Base Set",
  tier: "legendary",
  thumbnail_url: "https://example.test/art.png",
  fmv: { fmv_usd: 1234.5 },
}

const TS = "?collection=nba-top-shot&slug=1-2"

describe("/api/og/edition — the data branch", () => {
  it("prints the player, set, tier eyebrow and FMV", async () => {
    mockDetail({ data: EDITION })
    const text = ogText(await render(TS))

    expect(text).toContain("Damian Lillard")
    expect(text).toContain("Base Set")
    expect(text).toContain("NBA TOP SHOT")
    // The tier is upper-cased into the eyebrow beside the collection name.
    expect(text).toContain("LEGENDARY")
    expect(text).toContain("Current FMV")
    expect(text).toContain("$1,235")
  })

  it("unwraps a single-element array payload the same as a bare object", async () => {
    // get_edition_detail returns either shape depending on call site; reading
    // only one of them would blank the card for half the callers.
    mockDetail({ data: [EDITION] })
    expect(ogText(await render(TS))).toContain("Damian Lillard")
  })

  it("embeds the art as a data URI", async () => {
    mockDetail({ data: EDITION })
    expect(ogImageSrcs(await render(TS))).toContain("data:image/png;base64,AAAA")
  })

  it("renders the brand placeholder rather than an <img> with no source", async () => {
    mockDetail({ data: { ...EDITION, thumbnail_url: null } })
    const el = await render(TS)
    expect(ogImageSrcs(el)).toEqual([])
    expect(ogText(el)).toContain("Rip Packs City")
  })

  // ── The honesty constraint ────────────────────────────────────────────────

  it("SUPPRESSES the FMV on a closed market (UFC Strike)", async () => {
    mockDetail({ data: { ...EDITION, player_name: "A Fighter", fmv: { fmv_usd: 999 } } })
    const text = ogText(await render("?collection=ufc-strike&slug=1-2"))

    expect(text).toContain("A Fighter")
    expect(text).not.toContain("Current FMV")
    expect(text).not.toContain("$999")
  })

  it("still prints FMV for an open market with the same shape", async () => {
    // Positive mirror: without it, a blanket suppression would satisfy the test
    // above while deleting the price from every card on the site.
    mockDetail({ data: { ...EDITION, fmv: { fmv_usd: 42 } } })
    const text = ogText(await render("?collection=nfl-all-day&slug=1-2"))
    expect(text).toContain("Current FMV")
    expect(text).toContain("$42.00")
  })

  // ── The FMV gate ──────────────────────────────────────────────────────────

  it.each([
    ["a zero FMV", { fmv_usd: 0 }],
    ["a negative FMV", { fmv_usd: -5 }],
    ["a null FMV", { fmv_usd: null }],
    ["a non-numeric FMV", { fmv_usd: "not a number" }],
  ])("omits the stat block for %s rather than printing a meaningless figure", async (_l, fmv) => {
    mockDetail({ data: { ...EDITION, fmv } })
    const text = ogText(await render(TS))
    expect(text).toContain("Damian Lillard") // the card still renders
    expect(text).not.toContain("Current FMV")
  })

  it("omits the stat block when the detail carries no fmv object at all", async () => {
    mockDetail({ data: { ...EDITION, fmv: null } })
    expect(ogText(await render(TS))).not.toContain("Current FMV")
  })

  // ── Title / subtitle fallbacks ────────────────────────────────────────────

  it("falls back to `name` when there is no player_name", async () => {
    mockDetail({ data: { ...EDITION, player_name: null, name: "Mickey Mouse — Disney 100" } })
    expect(ogText(await render("?collection=disney-pinnacle&slug=x"))).toContain("Mickey Mouse")
  })

  it("renders without a tier segment when tier is absent", async () => {
    mockDetail({ data: { ...EDITION, tier: null } })
    const text = ogText(await render(TS))
    expect(text).toContain("NBA TOP SHOT")
    expect(text).not.toContain("LEGENDARY")
    // No dangling separator left behind by the omitted segment.
    expect(text).not.toContain("NBA TOP SHOT ·")
  })

  // ── Guard / failure branches ──────────────────────────────────────────────

  it.each([
    ["an unknown collection", "?collection=not-a-collection&slug=1-2"],
    ["a missing collection param", "?slug=1-2"],
    ["a missing slug param", "?collection=nba-top-shot"],
    ["no params at all", ""],
  ])("renders the generic brand card for %s", async (_l, query) => {
    mockDetail({ data: EDITION })
    const text = ogText(await render(query))
    // The guard fires BEFORE the RPC, so none of the edition data may appear
    // even though the stub would happily have returned it.
    expect(text).not.toContain("Damian Lillard")
    expect(text).toContain("RIP PACKS CITY")
  })

  it.each([
    ["a null payload", { data: null }],
    ["an empty array", { data: [] }],
    ["a thrown client", { throws: true as const }],
  ])("renders the 'Edition' fallback on %s", async (_l, payload) => {
    mockDetail(payload as never)
    const text = ogText(await render(TS))
    expect(text).toContain("Edition")
    expect(text).not.toContain("Damian Lillard")
    expect(text).not.toContain("Current FMV")
  })
})
