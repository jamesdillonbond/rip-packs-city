import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import {
  installOgCapture,
  resetOgCapture,
  ogText,
  usesColor,
  ogImageSrcs,
  type OgCapture,
} from "./helpers/og-capture"

// Per-card DATA-BRANCH test for /api/og/moment/[id] — the worst-covered file in
// the whole primary coverage gate at 21.4% branch (44 of 56 branches uncovered).
//
// The existing sweep (api-og-cards-render-sweep) drives this route but stubs its
// upstream generically, so it only ever exercises the DefaultCard fallback and
// asserts PNG bytes. That is the right floor for the 0-byte regression and says
// nothing about what the card claims. Everything below is about what it CLAIMS —
// which matters more here than on most surfaces, because an OG card is consumed
// by people who never load the page, and a wrong number on an unfurl is silent:
// no status code moves, nothing reaches Sentry.
//
// The load-bearing case is the closed-market FMV suppression. UFC Strike's market
// closed in May 2026 and its stored FMV is a value frozen at the last trading day;
// printing it under the label "Current FMV" is exactly the overclaim the moment
// page itself already dropped. If that branch regresses, this card starts telling
// social feeds a dead market has a live price.

const capture: { c: OgCapture | null } = { c: null }

interface Detail {
  ok?: boolean
  resolved?: { serial_number?: number | null } | null
  edition?: Record<string, unknown> | null
  fmv?: Record<string, unknown> | null
}

function mockDetail(payload: { data?: Detail | null; error?: unknown } | { throws: true }) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async () => {
        if ("throws" in payload) throw new Error("connection reset")
        return { data: payload.data ?? null, error: payload.error ?? null }
      },
    },
  }))
  // The card pre-fetches art to a data URI; keep it deterministic and offline.
  vi.doMock("@/lib/og/img-data", () => ({
    ogImageDataUri: async (u: string | null | undefined) => (u ? `data:image/png;base64,AAAA` : null),
  }))
}

async function render(id = "abc") {
  const { GET } = await import("@/app/api/og/moment/[id]/route")
  await GET({} as never, { params: Promise.resolve({ id }) })
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

const TOPSHOT_MOMENT: Detail = {
  ok: true,
  resolved: { serial_number: 12 },
  edition: {
    player_name: "Damian Lillard",
    set_name: "Base Set",
    tier: "LEGENDARY",
    thumbnail_url: "https://example.test/art.png",
    circulation_count: 500,
    collection_slug: "nba_top_shot",
  },
  fmv: { fmv_usd: 1234.5 },
}

describe("/api/og/moment/[id] — the data branch", () => {
  it("prints the player, set, serial/circulation and FMV", async () => {
    mockDetail({ data: TOPSHOT_MOMENT })
    const text = ogText(await render())

    expect(text).toContain("Damian Lillard")
    expect(text).toContain("Base Set")
    expect(text).toContain("NBA TOP SHOT")
    expect(text).toContain("LEGENDARY")
    expect(text).toContain("#12/500")
    expect(text).toContain("Current FMV")
    // >= 1000 formats as a rounded, thousands-separated figure.
    expect(text).toContain("$1,235")
  })

  it("uses the tier accent colour, not the fallback red", async () => {
    mockDetail({ data: TOPSHOT_MOMENT })
    const el = await render()
    expect(usesColor(el, "#F59E0B")).toBe(true) // LEGENDARY
    expect(usesColor(el, "#EF4444")).toBe(false) // ULTIMATE — must not leak in
  })

  it("falls back to the red accent for a tier outside the map", async () => {
    mockDetail({
      data: { ...TOPSHOT_MOMENT, edition: { ...TOPSHOT_MOMENT.edition, tier: "MYTHIC" } },
    })
    expect(usesColor(await render(), "#E03A2F")).toBe(true)
  })

  // ── The honesty constraint ────────────────────────────────────────────────

  it("SUPPRESSES the FMV on a closed market (UFC Strike)", async () => {
    // The value is present in the payload and must still not be published: UFC's
    // market closed 2026-05-13, so the stored figure is frozen, not current.
    mockDetail({
      data: {
        ...TOPSHOT_MOMENT,
        edition: {
          player_name: "A Fighter",
          set_name: "Set",
          tier: "CHALLENGER",
          collection_slug: "ufc_strike",
          circulation_count: 100,
        },
        fmv: { fmv_usd: 999 },
      },
    })
    const text = ogText(await render())

    expect(text).toContain("UFC STRIKE")
    expect(text).not.toContain("Current FMV")
    expect(text).not.toContain("$999")
    // The card still renders — it degrades to the brand line, not to nothing.
    expect(text).toContain("RIP PACKS CITY")
  })

  it("still prints FMV for an open market with the same shape", async () => {
    // The positive mirror. Without it, "always suppress" would pass the test
    // above and silently blank FMV on every card.
    mockDetail({
      data: {
        ...TOPSHOT_MOMENT,
        edition: { ...TOPSHOT_MOMENT.edition, collection_slug: "nfl_all_day" },
        fmv: { fmv_usd: 42 },
      },
    })
    const text = ogText(await render())
    expect(text).toContain("NFL ALL DAY")
    expect(text).toContain("Current FMV")
    expect(text).toContain("$42.00")
  })

  // ── FMV source ladder ─────────────────────────────────────────────────────

  it("falls back through floor_price_usd then floor_usd when fmv_usd is absent", async () => {
    mockDetail({
      data: { ...TOPSHOT_MOMENT, fmv: { fmv_usd: null, floor_price_usd: 77 } },
    })
    expect(ogText(await render())).toContain("$77.00")

    vi.resetModules()
    resetOgCapture()
    capture.c = installOgCapture()
    mockDetail({
      data: { ...TOPSHOT_MOMENT, fmv: { fmv_usd: null, floor_price_usd: null, floor_usd: 5.5 } },
    })
    expect(ogText(await render())).toContain("$5.50")
  })

  it("omits the FMV block entirely when no price exists", async () => {
    mockDetail({ data: { ...TOPSHOT_MOMENT, fmv: {} } })
    const text = ogText(await render())
    expect(text).not.toContain("Current FMV")
    expect(text).toContain("Damian Lillard")
  })

  // ── Naming / label fallbacks ──────────────────────────────────────────────

  it("uses character_name and franchise for a Pinnacle pin", async () => {
    mockDetail({
      data: {
        ok: true,
        resolved: { serial_number: null },
        edition: {
          player_name: null,
          character_name: "Mickey Mouse",
          set_name: null,
          franchise: "Disney 100",
          edition_type: "RARE",
          collection_slug: "disney_pinnacle",
          circulation_count: 250,
        },
        fmv: { fmv_usd: 10 },
      },
    })
    const text = ogText(await render())
    expect(text).toContain("Mickey Mouse")
    expect(text).toContain("Disney 100")
    expect(text).toContain("DISNEY PINNACLE")
    // No serial known → falls back to the circulation phrasing.
    expect(text).toContain("250 circulation")
    expect(text).not.toContain("#null")
  })

  it("degrades to a generic label when the collection slug is unknown", async () => {
    mockDetail({
      data: {
        ok: true,
        edition: { player_name: "X", tier: "RARE", collection_slug: "brand_new_chain" },
        fmv: { fmv_usd: 1 },
      },
    })
    expect(ogText(await render())).toContain("RIP PACKS CITY")
  })

  it("prints neither serial nor circulation when both are absent", async () => {
    mockDetail({
      data: {
        ok: true,
        resolved: { serial_number: null },
        edition: { player_name: "X", tier: "RARE", collection_slug: "nba_top_shot" },
        fmv: {},
      },
    })
    const text = ogText(await render())
    expect(text).not.toContain("circulation")
    expect(text).not.toContain("#")
  })

  // ── Media ─────────────────────────────────────────────────────────────────

  it("embeds the art as a data URI when one resolves", async () => {
    mockDetail({ data: TOPSHOT_MOMENT })
    const el = await render()
    expect(ogImageSrcs(el)).toEqual(["data:image/png;base64,AAAA"])
    expect(ogText(el)).not.toContain("No media")
  })

  it("renders the No-media placeholder rather than a broken <img>", async () => {
    // ogImageDataUri returns null for a dead/slow upstream; the card must not
    // emit an <img> with a null src, which is how an unfurl ends up blank.
    mockDetail({
      data: { ...TOPSHOT_MOMENT, edition: { ...TOPSHOT_MOMENT.edition, thumbnail_url: null } },
    })
    const el = await render()
    expect(ogImageSrcs(el)).toEqual([])
    expect(ogText(el)).toContain("No media")
  })

  // ── Failure branches ──────────────────────────────────────────────────────

  it.each([
    ["an RPC error", { data: null, error: { message: "statement timeout" } }],
    ["a thrown client", { throws: true as const }],
    ["ok:false from the RPC", { data: { ok: false } }],
    ["a payload with no edition", { data: { ok: true, edition: null } }],
    ["a null payload", { data: null }],
  ])("renders the default card on %s — never a half-built one", async (_label, payload) => {
    mockDetail(payload as never)
    const text = ogText(await render())
    // Whatever went wrong upstream, the card must not print a moment's worth of
    // partial data (a name with no price, a price with no name).
    expect(text).not.toContain("Damian Lillard")
    expect(text).not.toContain("Current FMV")
    expect(text.length).toBeGreaterThan(0)
  })

  it("always renders at 1200x630", async () => {
    mockDetail({ data: TOPSHOT_MOMENT })
    await render()
    expect(capture.c!.options()).toMatchObject({ width: 1200, height: 630 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BADGES — Trevor, 2026-09-12: the share image "needs to also include
// edition-wide badges (debut, rookie, championship, etc) along with special
// serial badges, for each moment displayed."
//
// This card is the one a collector posts about a SINGLE Moment, so unlike the
// trophy tiles each mark is labelled. The assertions read those labels, which
// is sharper than asserting bytes changed: it catches a badge row that renders
// the wrong badge as well as one that renders none.
//
// ⚠ The labels are asserted in TITLE CASE even though the card renders them in
// caps: the caps are `textTransform: uppercase`, a style, and `ogText` walks the
// element tree rather than laying it out. Asserting "Jersey Match" passes only
// by accident of how the harness works, and would red the day the style moved.
// ─────────────────────────────────────────────────────────────────────────────

/** Like mockDetail, plus the two reads the badge row makes. */
function mockDetailWithBadges(opts: {
  detail: Detail
  badges?: Array<{ title: string }> | null
  badgesError?: boolean
  jersey?: number | null
  jerseyError?: boolean
}) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async (fn: string) => {
        if (fn === "get_edition_badges_unified") {
          if (opts.badgesError) return { data: null, error: { message: "down" } }
          return { data: opts.badges ?? [], error: null }
        }
        return { data: opts.detail, error: null }
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              opts.jerseyError
                ? { data: null, error: { message: "down" } }
                : { data: { jersey_number: opts.jersey ?? null }, error: null },
          }),
        }),
      }),
    },
  }))
  vi.doMock("@/lib/og/img-data", () => ({
    ogImageDataUri: async (u: string | null | undefined) => (u ? `data:image/png;base64,AAAA` : null),
  }))
}

/** Kevin Durant's real Supernova Moment, 2026-09-12: #35/40, jersey 35. */
const KD: Detail = {
  ok: true,
  resolved: { serial_number: 35, edition_id: "ed-uuid" } as Detail["resolved"],
  edition: {
    id: "ed-uuid",
    player_name: "Kevin Durant",
    set_name: "Supernova",
    tier: "ULTIMATE",
    thumbnail_url: "https://example.test/art.png",
    circulation_count: 40,
    collection_slug: "nba_top_shot",
  },
  fmv: { fmv_usd: 1750 },
}

describe("/api/og/moment/[id] — the badge row", () => {
  it("draws the edition badges and the special serial, specials first", async () => {
    mockDetailWithBadges({
      detail: KD,
      badges: [{ title: "Rookie of the Year" }, { title: "Rookie Premiere" }, { title: "Rookie Year" }],
      jersey: 35,
    })
    const text = ogText(await render())
    expect(text).toContain("Jersey Match")
    expect(text).toContain("Rookie of the Year")
    expect(text).toContain("Rookie Premiere")
    // Gold special first, then the edition badges.
    expect(text.indexOf("Jersey Match")).toBeLessThan(text.indexOf("Rookie of the Year"))
  })

  it("⚠ claims NO jersey match when the jersey read fails", async () => {
    // A badge the Moment has not been shown to earn is a false claim about a
    // named collector's property on a public timeline. Absent beats invented.
    mockDetailWithBadges({ detail: KD, badges: [{ title: "Rookie Year" }], jerseyError: true })
    const text = ogText(await render())
    expect(text).not.toContain("Jersey Match")
    // ...and the edition badges are unaffected: the two reads fail apart.
    expect(text).toContain("Rookie Year")
  })

  it("⚠ claims NO badges when the badge read fails, and still renders the card", async () => {
    mockDetailWithBadges({ detail: KD, badgesError: true, jersey: 35 })
    const text = ogText(await render())
    expect(text).not.toContain("Rookie")
    // The special serial is computed from the row, so it survives.
    expect(text).toContain("Jersey Match")
    expect(text).toContain("Kevin Durant")
    expect(text).toContain("$1,750")
  })

  it("draws no badge row at all for a Moment that has earned nothing", async () => {
    mockDetailWithBadges({
      detail: { ...KD, resolved: { serial_number: 12, edition_id: "ed-uuid" } as Detail["resolved"] },
      badges: [],
      jersey: 35,
    })
    const text = ogText(await render())
    expect(text).not.toContain("Jersey Match")
    expect(text).not.toContain("Perfect Mint")
    expect(text).toContain("Kevin Durant")
  })

  it("names a perfect mint and a first mint by their canonical labels", async () => {
    mockDetailWithBadges({
      detail: { ...KD, resolved: { serial_number: 40, edition_id: "ed-uuid" } as Detail["resolved"] },
      badges: [],
      jersey: null,
    })
    expect(ogText(await render())).toContain("Perfect Mint")

    vi.resetModules()
    mockDetailWithBadges({
      detail: { ...KD, resolved: { serial_number: 1, edition_id: "ed-uuid" } as Detail["resolved"] },
      badges: [],
      jersey: null,
    })
    expect(ogText(await render())).toContain("First Mint")
  })
})
