import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, ogImageSrcs, type OgCapture } from "./helpers/og-capture"

// The /api/og/player ART BRANCH — the one thing this card's data path can get
// wrong that no status code and no byte count can see.
//
// WHAT SHIPPED BEFORE THIS. The route asked `get_player_editions` for ONE row
// and rendered `thumbnail_url` as-is. Measured live 2026-09-13:
//
//   · `players.headshot_url` is null for 0 of 3,869 rows, so that one edition
//     thumbnail is the ONLY art any player card has ever had — the "portrait"
//     column is a column with no values in it.
//   · LeBron James' top-FMV edition art (`…_Hero_2880_2880_Transparent.png`,
//     $8,750) answers 404 from the DB's own egress; his next two candidates
//     answer 206 with real image bytes.
//
// So the most-shared player on the platform published a blank card, and the
// defect is NOT a dead url — 24 of 24 sampled thumbnails were live. It is that a
// single value-ordered candidate had no successor.
//
// ⚠ THIS SUITE USES THE REAL `lib/og/img-data`, deliberately. Mocking it — as
// the sibling entity-card suite does, reasonably, for cards whose art branch is
// not what they test — would make every case here pass on a route that still
// asks for one candidate. `fetch` is stubbed instead, at the layer where the 404
// actually happens.

const capture: { c: OgCapture | null } = { c: null }

const DEAD = "https://assets.nbatopshot.com/media/1/image?width=512"
const LIVE = "https://assets.nbatopshot.com/media/2/image?width=512"
const LIVE_2 = "https://assets.nbatopshot.com/media/3/image?width=512"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4])
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`

const DETAIL = { name: "LeBron James", team: "Los Angeles Lakers", edition_count: 412, headshot_url: null }

function imageRes(bytes: Uint8Array, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function notFound() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => "application/xml" },
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/**
 * Stub `fetch` so only `live` urls answer with image bytes.
 *
 * ⚠ The brand-font fetches fall through to 404 here on purpose. `brandFonts()`
 * validates the bytes and degrades to the generic face, so the card still
 * renders — font coverage is api-og-profile-brand-fonts.test.ts' job, and
 * serving fonts here would only hide which fetch this suite is measuring.
 */
function stubFetch(live: string[]) {
  const mock = vi.fn(async (u: unknown) => (live.includes(String(u)) ? imageRes(PNG_BYTES, "image/png") : notFound()))
  vi.stubGlobal("fetch", mock)
  return mock
}

/** Supabase stub: the detail row plus an art candidate list, in order. */
function mockSupabase(thumbs: Array<string | null>, detail: Record<string, unknown> | null = DETAIL) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        if (name === "get_player_detail") return { data: detail ? [detail] : [], error: null }
        if (name === "get_player_editions") {
          return { data: thumbs.map((t) => ({ thumbnail_url: t })), error: null }
        }
        return { data: null, error: null }
      },
    },
  }))
  return calls
}

async function render(query = "?collection=nba-top-shot&slug=lebron-james") {
  const { GET } = await import("@/app/api/og/player/route")
  await GET(new NextRequest(`https://www.rippackscity.com/api/og/player${query}`))
  return capture.c!.element()
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.unstubAllGlobals()
  resetOgCapture()
})

describe("/api/og/player — a dead top candidate must not blank the card", () => {
  it("⭐ RENDERS THE NEXT CANDIDATE'S ART when the top-FMV thumbnail 404s", async () => {
    mockSupabase([DEAD, LIVE, LIVE_2])
    stubFetch([LIVE, LIVE_2])
    const el = await render()
    expect(ogImageSrcs(el)).toEqual([PNG_DATA_URI])
    expect(ogText(el)).toContain("LeBron James")
  })

  it("NO-CHANGE CONTROL: the same dead candidate with no successor is still art-free", async () => {
    // The behaviour every player card got until 2026-09-13, reproduced so the
    // case above is measuring the fallback and not the stub.
    mockSupabase([DEAD])
    stubFetch([])
    const el = await render()
    expect(ogImageSrcs(el)).toEqual([])
    // ⚠ AND THE CARD IS STILL HONEST ABOUT IT: no art means the brand tile, not
    // a broken <img> and not a claim the player has no editions.
    expect(ogText(el)).toContain("LeBron James")
    expect(ogText(el)).toContain("412")
  })

  it("KEEPS THE SINGLE-HERO LAYOUT — several live candidates are not a montage", async () => {
    // `renderEntityOg` switches to a 2x2 grid at >1 image, so resolving the
    // fallback chain in the route (one image out) rather than handing it four
    // urls is what keeps a player card a portrait.
    mockSupabase([LIVE, LIVE_2, DEAD])
    stubFetch([LIVE, LIVE_2])
    expect(ogImageSrcs(await render())).toHaveLength(1)
  })

  it("costs ONE image fetch when the top candidate is live", async () => {
    // `/_next/image` transformations are the metered leg; the common case must
    // cost what asking for a single candidate cost before the fallback existed.
    mockSupabase([LIVE, LIVE_2, DEAD])
    const fetchMock = stubFetch([LIVE, LIVE_2])
    await render()
    const artCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/media/"))
    expect(artCalls).toHaveLength(1)
    expect(String(artCalls[0][0])).toBe(LIVE)
  })

  it("ASKS FOR MORE THAN ONE CANDIDATE — the property, not the number", async () => {
    // A limit of 1 cannot have a fallback no matter how the art code behaves, so
    // the request shape is pinned separately from the walk. Raising 4 to 6 keeps
    // this green; a refactor that quietly restores `p_limit: 1` does not.
    const calls = mockSupabase([LIVE])
    stubFetch([LIVE])
    await render()
    const eds = calls.find((c) => c.name === "get_player_editions")
    expect(eds).toBeTruthy()
    expect(Number(eds!.args.p_limit)).toBeGreaterThan(1)
  })

  it("prefers a headshot over edition art when one ever exists", async () => {
    // `headshot_url` is empty for all 3,869 players today, so this pins the
    // ORDER for the day it is not — a portrait outranks a Moment.
    const HEAD = "https://assets.nbatopshot.com/media/9/image?width=512"
    mockSupabase([LIVE], { ...DETAIL, headshot_url: HEAD })
    const fetchMock = stubFetch([HEAD, LIVE])
    await render()
    const artCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/media/"))
    expect(String(artCalls[0][0])).toBe(HEAD)
  })

  it("renders the fallback card without art when the detail read comes back empty", async () => {
    mockSupabase([LIVE], null)
    stubFetch([LIVE])
    const el = await render()
    expect(ogText(el)).toContain("Player")
    expect(ogImageSrcs(el)).toEqual([])
  })

  it("survives a thumbnail list full of nulls", async () => {
    mockSupabase([null, null])
    stubFetch([])
    const el = await render()
    expect(ogImageSrcs(el)).toEqual([])
    expect(ogText(el)).toContain("LeBron James")
  })
})
