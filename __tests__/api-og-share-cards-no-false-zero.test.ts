import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, ogImageSrcs, type OgCapture } from "./helpers/og-capture"

// The two SHARE cards — /api/og/share (a wallet's collection card) and
// /api/og/profile/[username] (a collector's public profile card).
//
// ── WHY THESE TWO ARE DIFFERENT FROM THE OTHER OG CARDS ─────────────────────
// Every OG card that renders a failed read as data makes a false claim. These
// two make a false claim ABOUT AN IDENTIFIABLE PERSON, and they are the cards a
// collector deliberately POSTS. Before 2026-08-13:
//
//   /api/og/share            fell back to `totalFmv = 0` and rendered "$0.00"
//                            with "0 moments"
//   /api/og/profile/[user]   `fetchJson` returned [] on failure, `totalFmv`
//                            reduced to 0, and the card rendered
//                            "PORTFOLIO FMV  $0"
//
// So during an outage the platform published, on a shareable and edge-cached
// PNG, that a named collector's portfolio was worth nothing. The share route's
// own comment described the zeros as "a branded shell" — but zeros are not a
// shell, they are a NUMBER, and a reader cannot tell one from a real answer.
//
// ⚠ The distinction that had to be preserved: a wallet that genuinely holds
// nothing IS worth $0, and must still say so. Every failure case below is
// paired with the empty-but-successful mirror.

const capture: { c: OgCapture | null } = { c: null }

/**
 * Whitespace-stripped text, for MONEY assertions only.
 *
 * ⚠ The share card's JSX renders the currency symbol and the value as SEPARATE
 * children — `${totalFmv.toLocaleString(...)}` is a literal "$" plus an
 * interpolation — so the tree walker (which joins children with a space) yields
 * "$ 0.00", not "$0.00". That is a harness artefact, not a rendering bug: satori
 * lays the two runs out adjacently. Normalising here rather than changing
 * ogText, which six other suites already depend on.
 */
function compact(text: string): string {
  return text.replace(/\s+/g, "")
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.test")
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetOgCapture()
})

// ── /api/og/share ───────────────────────────────────────────────────────────

function mockSnapshot(mode: "rows" | "empty" | "notok" | "throws") {
  globalThis.fetch = vi.fn(async () => {
    if (mode === "throws") throw new Error("socket hang up")
    if (mode === "notok") return new Response("upstream down", { status: 503 })
    const body =
      mode === "rows"
        ? {
            totalFmv: 12345.67,
            totalMoments: 42,
            topMoments: [{ playerName: "Damian Lillard" }, { playerName: "Anfernee Simons" }],
          }
        : { totalFmv: 0, totalMoments: 0, topMoments: [] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
}

async function renderShare(wallet = "0xbd94cade097e50ac") {
  const { GET } = await import("@/app/api/og/share/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/share?wallet=${wallet}`))
  return ogText(capture.c!.element())
}

describe("/api/og/share — a failed read must not publish a $0 portfolio", () => {
  it("renders the real figures when the snapshot resolves", async () => {
    mockSnapshot("rows")
    const text = await renderShare()
    expect(text).toContain("COLLECTION FMV")
    expect(compact(text)).toContain("$12,345.67")
    expect(text).toContain("42")
    expect(text).toContain("Damian Lillard")
  })

  it.each([
    ["a non-2xx snapshot", "notok" as const],
    ["a thrown fetch", "throws" as const],
  ])("WITHHOLDS the figures on %s", async (_label, mode) => {
    mockSnapshot(mode)
    const text = await renderShare()

    // The false claim must be gone in both spellings.
    expect(compact(text)).not.toContain("$0.00")
    expect(compact(text)).not.toContain("0moments")
    expect(text).not.toContain("COLLECTION FMV")
    // ...and the card still renders, branded, pointing at the live page.
    expect(text).toContain("RIP PACKS CITY")
    expect(text).toContain("Open the page for this wallet")
  })

  it("STILL renders $0.00 for a wallet that genuinely holds nothing", async () => {
    // The positive mirror. Without it, "always withhold" would satisfy the
    // failure cases while deleting a true statement about an empty wallet.
    mockSnapshot("empty")
    const text = await renderShare()
    expect(text).toContain("COLLECTION FMV")
    expect(compact(text)).toContain("$0.00")
    expect(compact(text)).toContain("0moments")
    expect(text).not.toContain("Open the page for this wallet")
  })

  it("shows the wallet address in both states", async () => {
    mockSnapshot("notok")
    expect(await renderShare()).toContain("0xbd94ca")
  })
})

// ── /api/og/profile/[username] ──────────────────────────────────────────────

/**
 * PostgREST double for the profile card. `fail` names the read that should
 * fail, so a single failing leg can be isolated.
 *
 * ⚠ The trophy leg is an RPC now, not a table read. It moved on 2026-08-14
 * because `trophy_moments` holds PIN-TIME snapshots — 8 of 16 rows carried a
 * NULL tier, so half the tiles on the card drew the default grey instead of
 * their real tier colour. `get_trophy_slab_data_by_username` returns live
 * values, and is the same source the profile PAGE and the trophy-case card use.
 */
function mockPostgrest(opts: {
  fail?: string
  wallets?: unknown[]
  trophies?: unknown[]
  teams?: unknown[]
  /** Rows for the `editions` read the jersey-match glyph needs. */
  jerseys?: unknown[]
  /** `pack_rips` answers with a Content-Range total, not a row array. */
  rips?: number | null
}) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (opts.fail && u.includes(opts.fail)) return new Response("down", { status: 503 })
    // ⚠ The rips leg is a COUNT read: the figure rides in `Content-Range`, and a
    // 200 whose header is missing or unparseable must read as a FAILED read, not
    // as zero packs. `rips: null` is that case.
    if (u.includes("pack_rips")) {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (opts.rips != null) headers["content-range"] = `0-0/${opts.rips}`
      return new Response(JSON.stringify([]), { status: 200, headers })
    }
    const body = u.includes("profile_bio")
      ? [{ user_id: "u1", display_name: "Trevor", tagline: "", accent_color: "#E03A2F" }]
      : u.includes("saved_wallets")
        ? (opts.wallets ?? [{ wallet_addr: "0xbd94cade097e50ac", cached_moment_count: 30 }])
        : u.includes("user_favorite_teams")
          ? (opts.teams ?? [])
          : u.includes("/editions?")
            ? (opts.jerseys ?? [])
            : u.includes("get_trophy_slab_data_by_username")
              ? (opts.trophies ?? [])
              : []
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  vi.doMock("@/lib/og/img-data", () => ({
    // ⚠ Art resolves to a data URI here rather than null, because a slab with
    // no art draws the ART UNAVAILABLE placeholder and NOT its badge strip —
    // a null-art mock would make every badge assertion below vacuously pass.
    ogImageDataUri: async (u: string | null | undefined) => (u ? "data:image/png;base64,AAAA" : null),
    ogImageDataUris: async () => [],
    ogImageDataUriSlots: async (urls: unknown[]) => urls.map(() => "data:image/png;base64,AAAA"),
  }))
}

async function renderProfile(username = "jamesdillonbond") {
  const { GET } = await import("@/app/api/og/profile/[username]/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/profile/${username}`), {
    params: Promise.resolve({ username }),
  })
  return ogText(capture.c!.element())
}

// ⭐ THE PORTFOLIO FIGURE CAME OFF THIS CARD ENTIRELY on 2026-09-12 (Trevor's
// call), so the four cases that used to live here — "renders the real
// portfolio", "holds the stale-priced portion out", "withholds it on failure",
// "still renders $0 for an empty wallet" — no longer have a tile to assert
// against. They are INVERTED rather than deleted: the first case below states
// the opposite property (the figure must NOT appear), and the honesty pairs
// they carried move onto the tiles that replaced it.
//
// Removing it is also a privacy repair. Every share of a profile was
// broadcasting that collector's net worth into a public timeline, which is not
// something most people would opt into if they were asked.
describe("/api/og/profile — the card states no portfolio figure at all", () => {
  it("publishes neither the label nor the number, even when the read succeeds", async () => {
    mockPostgrest({ wallets: [{ wallet_addr: "0xabc123", cached_moment_count: 30 }] })
    const text = await renderProfile()
    expect(text).not.toContain("PORTFOLIO FMV")
    expect(compact(text)).not.toContain("$5.0K")
    // ...and the card is still a card: the tiles that remain are drawn.
    expect(text).toContain("MOMENTS / PINS / CARDS")
    expect(text).toContain("TROPHY CASE")
  })
})

describe("/api/og/profile — a failed read must not publish a zero about a named person", () => {
  it("renders the real counts when every read resolves", async () => {
    mockPostgrest({ rips: 503 })
    const text = await renderProfile()
    expect(text).toContain("MOMENTS / PINS / CARDS")
    expect(text).toContain("30")
    expect(text).toContain("PACKS RIPPED")
    expect(text).toContain("503")
  })

  it("WITHHOLDS the Moments count when the wallets read fails", async () => {
    mockPostgrest({ fail: "saved_wallets", rips: 503 })
    const text = await renderProfile()
    // The label stays — the card's layout is intact — but the VALUE is withheld.
    expect(text).toContain("MOMENTS / PINS / CARDS")
    expect(text).toContain("—")
  })

  it("WITHHOLDS the pack count when the rips read fails", async () => {
    mockPostgrest({ fail: "pack_rips" })
    const text = await renderProfile()
    expect(text).toContain("PACKS RIPPED")
    // Per-leg, not all-or-nothing: the Moments figure survives its neighbour.
    expect(text).toContain("30")
    expect(text).toContain("—")
  })

  it("WITHHOLDS the pack count when the count read 200s with no Content-Range", async () => {
    // ⚠ The failure shape a `?? 0` would have swallowed. A 200 with no total is
    // a read we could not interpret, and "0 PACKS RIPPED" about a named
    // collector is a claim, not a blank.
    mockPostgrest({ rips: null })
    const text = await renderProfile()
    expect(text).toContain("PACKS RIPPED")
    expect(text).toContain("—")
  })

  it("STILL renders 0 for a collector who genuinely has not ripped a pack", async () => {
    // The positive mirror. Without it, "always withhold" would satisfy every
    // failure case above while deleting a true statement about a real collector.
    mockPostgrest({ rips: 0 })
    const text = await renderProfile()
    expect(text).toContain("PACKS RIPPED")
    expect(text).toContain("0")
  })

  it("suppresses the TEAMS tile rather than drawing an empty box", async () => {
    // 21 of 25 accounts have no pick, so this is the DEFAULT rendering, not an
    // edge case — an always-present tile would ship 21 empty boxes.
    mockPostgrest({ teams: [], rips: 12 })
    const text = await renderProfile()
    expect(text).not.toContain("TEAMS")
    expect(text).toContain("PACKS RIPPED")
  })

  it("draws the TEAMS tile from the structured picks, primary first", async () => {
    mockPostgrest({
      teams: [
        { league: "nba", is_primary: true, teams_master: { abbreviation: "POR", team_name: "Portland Trail Blazers" } },
        { league: "nfl", is_primary: false, teams_master: { abbreviation: "DET", team_name: "Detroit Lions" } },
      ],
      rips: 12,
    })
    const text = await renderProfile()
    expect(text).toContain("TEAMS")
    expect(text).toContain("POR · DET")
  })

  it("dedupes an abbreviation two leagues share", async () => {
    // ⚠ Trevor's real picks, 2026-09-12: Blazers (NBA), Portland Fire (WNBA),
    // Lions (NFL). Abbreviations are unique per LEAGUE, not globally, so the
    // undeduped tile reads "POR · POR · DET" on the founder's own card.
    mockPostgrest({
      teams: [
        { league: "NBA", is_primary: true, teams_master: { abbreviation: "POR", team_name: "Portland Trail Blazers" } },
        { league: "WNBA", is_primary: false, teams_master: { abbreviation: "POR", team_name: "Portland Fire" } },
        { league: "NFL", is_primary: false, teams_master: { abbreviation: "DET", team_name: "Detroit Lions" } },
      ],
      rips: 503,
    })
    const text = await renderProfile()
    expect(text).toContain("POR · DET")
    expect(text).not.toContain("POR · POR")
  })

  it("falls back to the legacy free-text team, as the profile page does", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes("pack_rips"))
        return new Response("[]", { status: 200, headers: { "content-range": "0-0/7" } })
      const body = u.includes("profile_bio")
        ? [{ user_id: "u1", display_name: "Trevor", accent_color: "#E03A2F", favorite_team: "Rip City" }]
        : u.includes("saved_wallets")
          ? [{ wallet_addr: "0xabc123", cached_moment_count: 30 }]
          : []
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch
    const text = await renderProfile()
    expect(text).toContain("TEAMS")
    expect(text).toContain("RIP CITY")
  })

  it("withholds the trophy count when only the trophy read fails", async () => {
    // Per-leg, not all-or-nothing: a failed trophy read must not blank the
    // counts beside it, and vice versa.
    mockPostgrest({ fail: "get_trophy_slab_data_by_username", rips: 503 })
    const text = await renderProfile()
    expect(text).toContain("30") // Moments still shown
    expect(text).toContain("503") // packs still shown
    expect(text).not.toContain("0 / 6") // trophy count withheld
  })

  it("renders 0 / 6 for a profile with a genuinely empty trophy case", async () => {
    mockPostgrest({ trophies: [] })
    expect(await renderProfile()).toContain("0 / 6")
  })

  it("reads trophies from the LIVE rpc, never the pin-time table", async () => {
    // The stub above would keep passing if the card went back to
    // `trophy_moments` — it would just read an unstubbed URL and get []. So the
    // source is asserted directly: half the stored rows carry a NULL tier, and
    // a card drawing tier colours from those is wrong on every second tile.
    mockPostgrest({ trophies: [] })
    await renderProfile()
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    )
    expect(urls.some((u) => u.includes("get_trophy_slab_data_by_username"))).toBe(true)
    expect(urls.some((u) => u.includes("trophy_moments"))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BADGES ON THE PROFILE CARD'S TROPHY SLABS — Trevor, 2026-09-12.
//
// The slabs carry no text, so the marks are asserted through `ogImageSrcs`: the
// glyphs are `data:` URIs, and a decoded URI names the geometry it drew. That
// is what lets these tests tell "drew the jersey glyph" from "drew a glyph",
// which byte-inequality cannot.
// ─────────────────────────────────────────────────────────────────────────────

const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

/** Decoded SVG for every mark drawn — the slab art is a PNG data URI, so it
 *  filters out cleanly. */
function drawnGlyphs(): string[] {
  return ogImageSrcs(capture.c!.element())
    .filter((src) => src.startsWith("data:image/svg+xml"))
    .map((src) => decodeURIComponent(src.slice(src.indexOf(",") + 1)))
}

const CLINGAN = {
  slot: 1,
  player_name: "Donovan Clingan",
  tier: "ULTIMATE",
  thumbnail_url: "https://assets.nbatopshot.com/media/1/image?width=180",
  badges: ["Three-Star Rookie"],
  serial_number: 1,
  circulation_count: 1,
  edition_id: "176:7003",
  collection_id: TS_COLLECTION,
}

describe("/api/og/profile — every pinned Moment shows what it has earned", () => {
  it("draws a special-serial glyph AND an edition-badge glyph on the slab", async () => {
    mockPostgrest({ trophies: [CLINGAN], rips: 503 })
    await renderProfile()
    const glyphs = drawnGlyphs()
    // Two marks: the gold #1 medal (serial 1) and the Three-Star Rookie badge.
    expect(glyphs).toHaveLength(2)
    expect(glyphs.filter((g) => g.includes("#F59E0B"))).toHaveLength(1) // the gold one
  })

  it("⚠ draws NO jersey glyph when the edition lookup returns nothing", async () => {
    // Absent beats invented: a jersey match this card has not verified is a
    // false claim about a named collector's Moment.
    mockPostgrest({
      trophies: [{ ...CLINGAN, serial_number: 23, circulation_count: 50, badges: null }],
      jerseys: [],
      rips: 503,
    })
    await renderProfile()
    expect(drawnGlyphs()).toHaveLength(0)
  })

  it("draws the jersey glyph when the edition DOES report that number", async () => {
    // The positive mirror of the case above — without it, "never draw a jersey"
    // would satisfy the failure case while deleting a true badge.
    mockPostgrest({
      trophies: [{ ...CLINGAN, serial_number: 23, circulation_count: 50, badges: null }],
      jerseys: [{ external_id: "176:7003", collection_id: TS_COLLECTION, jersey_number: 23 }],
      rips: 503,
    })
    await renderProfile()
    expect(drawnGlyphs()).toHaveLength(1)
  })

  it("⚠ does NOT take a jersey number from a DIFFERENT collection's edition", async () => {
    // `editions.external_id` is unique per collection, not globally, and the
    // read filters on external_id alone. An unqualified map would give this
    // Top Shot Moment an All Day player's jersey number and draw a badge it
    // has not earned. The map key is what stops it.
    mockPostgrest({
      trophies: [{ ...CLINGAN, serial_number: 23, circulation_count: 50, badges: null }],
      jerseys: [
        { external_id: "176:7003", collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", jersey_number: 23 },
      ],
      rips: 503,
    })
    await renderProfile()
    expect(drawnGlyphs()).toHaveLength(0)
  })

  it("survives a failed edition read without losing the rest of the row", async () => {
    mockPostgrest({ trophies: [CLINGAN], fail: "/editions?", rips: 503 })
    await renderProfile()
    // The #1 medal and the Three-Star Rookie badge are computed from the trophy
    // row; only a jersey match would have been lost, and this Moment has none.
    expect(drawnGlyphs()).toHaveLength(2)
    expect(ogText(capture.c!.element())).toContain("TROPHY CASE")
  })
})
