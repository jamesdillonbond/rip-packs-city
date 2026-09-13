import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogImageSrcs, type OgCapture } from "./helpers/og-capture"
import { OG_CACHE_HEADERS, OG_DEGRADED_CACHE_HEADERS, ogCacheHeaders } from "@/lib/og/brand-fonts"

// ─────────────────────────────────────────────────────────────────────────────
// A BLANK CARD MUST NOT OUTLIVE THE OUTAGE THAT CAUSED IT.
//
// Every OG card ships `s-maxage=3600, stale-while-revalidate=86400`, which is
// right for a card that rendered and a trap for one that did not: a single
// transient upstream failure at render time publishes an art-less card for up
// to 25 hours, and the card most likely to be fetched cold is the one somebody
// just shared. That is CLAUDE.md's "ISR caches a failed read for the whole
// revalidate window" rule, met where the failed read is a picture.
//
// ⚠ MEASURED, not imagined (2026-09-13, from the database's egress because this
// sandbox has none): three fresh UFC Strike CIDs through /api/public/ipfs-media/
// answered 200, 200 and 429. All 518 of that collection's editions resolve
// through one public gateway; when it rate-limits there is no art for that
// render, and nothing about the render says so.
//
// ⭐ THE DISTINCTION THAT MAKES THIS SAFE: "asked for art and got none" is the
// degraded state. "Has no art to draw" is a stable, correct state and keeps the
// long cache — otherwise every legitimately art-less card would re-render every
// minute forever, which is the permanently-red-instrument failure wearing a
// cache header.
// ─────────────────────────────────────────────────────────────────────────────

const capture: { c: OgCapture | null } = { c: null }

const LIVE = "https://assets.nbatopshot.com/media/2/image?width=512"
const DEAD = "https://assets.nbatopshot.com/media/1/image?width=512"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4])

function stubFetch(live: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) =>
      live.includes(String(u))
        ? ({
            ok: true,
            status: 200,
            headers: { get: () => "image/png" },
            arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
          } as never)
        : ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as never),
    ),
  )
}

function mockSupabase(thumbs: Array<string | null>) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      rpc: async (name: string) => {
        if (name === "get_player_detail")
          return { data: [{ name: "LeBron James", edition_count: 412, headshot_url: null }], error: null }
        if (name === "get_player_editions")
          return { data: thumbs.map((t) => ({ thumbnail_url: t })), error: null }
        return { data: null, error: null }
      },
    },
  }))
}

async function renderPlayer() {
  const { GET } = await import("@/app/api/og/player/route")
  await GET(new NextRequest("https://www.rippackscity.com/api/og/player?collection=nba-top-shot&slug=lebron-james"))
  return capture.c!
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

const ccOf = (c: OgCapture) =>
  (c.options()?.headers as Record<string, string> | undefined)?.["Cache-Control"]

describe("the two policies are actually different", () => {
  it("the degraded one is shorter and carries no stale-while-revalidate", () => {
    // ⛔ SWR's whole job is to keep serving the OLD body, which here is the
    // defect — so its ABSENCE is the property, not a shorter number alone.
    const long = OG_CACHE_HEADERS["Cache-Control"]
    const short = OG_DEGRADED_CACHE_HEADERS["Cache-Control"]
    expect(short).not.toBe(long)
    expect(long).toContain("stale-while-revalidate")
    expect(short).not.toContain("stale-while-revalidate")
    const secs = (s: string) => Number(/s-maxage=(\d+)/.exec(s)![1])
    expect(secs(short)).toBeLessThan(secs(long))
  })

  it("defaults to the long policy — a caller that says nothing gets today's behaviour", () => {
    expect(ogCacheHeaders()).toBe(OG_CACHE_HEADERS)
    expect(ogCacheHeaders(false)).toBe(OG_CACHE_HEADERS)
    expect(ogCacheHeaders(true)).toBe(OG_DEGRADED_CACHE_HEADERS)
  })
})

describe("/api/og/player — the card's cache reflects whether it got its art", () => {
  it("⭐ a card whose every art candidate died is cached for a MINUTE, not a day", async () => {
    mockSupabase([DEAD, DEAD])
    stubFetch([])
    const c = await renderPlayer()
    expect(ogImageSrcs(c.element())).toEqual([])
    expect(ccOf(c)).toBe(OG_DEGRADED_CACHE_HEADERS["Cache-Control"])
  })

  it("NO-CHANGE CONTROL: the same card WITH art keeps the long cache", async () => {
    // Without this the case above would pass against a route that had simply
    // stopped using the long policy at all.
    mockSupabase([DEAD, LIVE])
    stubFetch([LIVE])
    const c = await renderPlayer()
    expect(ogImageSrcs(c.element())).toHaveLength(1)
    expect(ccOf(c)).toBe(OG_CACHE_HEADERS["Cache-Control"])
  })

  it("a player with NO art candidates at all is not degraded — it is just art-less", async () => {
    // The distinction the whole change turns on. This card is correct and
    // stable; re-rendering it every minute would punish its own success.
    mockSupabase([])
    stubFetch([])
    const c = await renderPlayer()
    expect(ogImageSrcs(c.element())).toEqual([])
    expect(ccOf(c)).toBe(OG_CACHE_HEADERS["Cache-Control"])
  })

  it("the guard card (bad slug) keeps the long cache — it never asked for art", async () => {
    mockSupabase([LIVE])
    stubFetch([LIVE])
    const { GET } = await import("@/app/api/og/player/route")
    await GET(new NextRequest("https://www.rippackscity.com/api/og/player?collection=nope"))
    expect(ccOf(capture.c!)).toBe(OG_CACHE_HEADERS["Cache-Control"])
  })
})
