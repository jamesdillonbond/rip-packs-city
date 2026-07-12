import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for /api/public/pinnacle-image/[renderId]. Dynamic route:
// 2nd arg is { params: Promise<{ renderId }> }. render_id regex is the SSRF guard
// (400 pre-fetch). Otherwise it resolves a fresh signed media URL from the studio
// GraphQL and 302-redirects. We stub global fetch to pin: 400 on a bad render_id,
// 302 + Location on a resolved media, and 404 when no media resolves.

import { GET } from "@/app/api/public/pinnacle-image/[renderId]/route"

const ctx = (renderId: string) => ({ params: Promise.resolve({ renderId }) })
const req = (url = "https://t/api/public/pinnacle-image/x") => ({ nextUrl: new URL(url) }) as any

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/public/pinnacle-image/[renderId]", () => {
  it("400s on a render_id that fails the SSRF regex", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    const res = await GET(req(), ctx("bad id!!"))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
    expect((await res.json()).error).toBe("invalid render_id")
  })

  it("302-redirects to the resolved signed media url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            searchPinnacleEditions: {
              edges: [{ node: { medias: [{ name: "Front_Transparent", url: "https://cdn.example.com/front.png" }] } }],
            },
          },
        }),
      })),
    )
    const res = await GET(req(), ctx("OEV1-SOUL-JGAR-S2"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://cdn.example.com/front.png")
  })

  it("404s when no media resolves for the render_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { searchPinnacleEditions: { edges: [] } } }),
      })),
    )
    const res = await GET(req(), ctx("OEV1-SOUL-JGAR-S2"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("not found")
  })
})
