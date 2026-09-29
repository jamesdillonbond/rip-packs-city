import { describe, it, expect, vi, beforeEach } from "vitest"
import sharp from "sharp"
import { NextRequest } from "next/server"

// ── /api/public/team-logo/[league]/[id] (2026-09-29) ────────────────────────
// Chrome fails cdn.nba.com / cdn.wnba.com directly (ERR_HTTP2_PROTOCOL_ERROR, reproduced in installed
// Chrome from a residential connection), so team pages never painted their logo. The route fetches
// the SVG server-side and returns a PNG: an SVG served from our origin would be a stored-XSS surface
// (lib/media/avatar-proxy.ts refuses SVG for that reason). Pinned: it rasterizes, never passes SVG
// through, builds the upstream URL only from the allowlist, and fails to an uncached 404.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script><circle cx="50" cy="50" r="40" fill="#98002e"/></svg>`

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)
const { GET } = await import("@/app/api/public/team-logo/[league]/[id]/route")
const call = (league: string, id: string) =>
  GET(new NextRequest(`https://www.rippackscity.com/api/public/team-logo/${league}/${id}`), { params: Promise.resolve({ league, id }) })

describe("GET /api/public/team-logo/[league]/[id]", () => {
  beforeEach(() => fetchMock.mockReset())

  it("returns a 256x256 PNG rendered from the official SVG, immutably cached", async () => {
    fetchMock.mockResolvedValue(new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } }))
    const res = await call("nba", "1610612748")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("immutable")
    const body = Buffer.from(await res.arrayBuffer())
    const meta = await sharp(body).metadata()
    expect(meta.format).toBe("png")
    expect(meta.width).toBe(256)
    // Never the SVG bytes (and so never its <script>) from our origin.
    expect(body.toString("latin1")).not.toContain("<script")
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.nba.com/logos/nba/1610612748/global/L/logo.svg")
  })

  it("maps WNBA to its own CDN", async () => {
    fetchMock.mockResolvedValue(new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } }))
    await call("wnba", "1611661320")
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.wnba.com/logos/wnba/1611661320/global/L/logo.svg")
  })

  it("refuses an unknown league or a non-numeric id without fetching", async () => {
    expect((await call("nfl", "1610612748")).status).toBe(404)
    expect((await call("nba", "../evil")).status).toBe(404)
    expect((await call("nba", "12")).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails to an UNCACHED 404 when the upstream is not an SVG or errors", async () => {
    fetchMock.mockResolvedValue(new Response("<Error/>", { status: 403, headers: { "content-type": "application/xml" } }))
    const res = await call("nba", "1610612748")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    fetchMock.mockResolvedValue(new Response("not svg", { status: 200, headers: { "content-type": "text/html" } }))
    expect((await call("nba", "1610612748")).status).toBe(404)
  })

  it("fails to a 404 when the fetch throws", async () => {
    let threw = 0
    vi.stubGlobal("fetch", async () => { threw++; throw new Error("ERR_HTTP2_PROTOCOL_ERROR") })
    try {
      expect((await call("nba", "1610612748")).status).toBe(404)
      expect(threw).toBe(1)
    } finally {
      vi.stubGlobal("fetch", fetchMock)
    }
  })
})
