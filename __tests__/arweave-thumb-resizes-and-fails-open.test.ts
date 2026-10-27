import { describe, it, expect, vi, beforeEach } from "vitest"
import sharp from "sharp"
import { NextRequest } from "next/server"
import { proxyIpfsImageUrl, ARWEAVE_TX_RE } from "@/lib/ipfs-media"
import { ogImageTarget } from "@/lib/og/img-data"
import { heroSrcSet } from "@/lib/hero-srcset"

// 2026-10-26 (Candy parity): every Candy MLB card image is a full-size PNG on arweave.net —
// 3.9 MB for a base ICON, 7.5 MB for a Rainbow (measured) — rendered with a plain <img>, and the
// Rainbow editions' social cards had NO art (the OG 4 MB cap drops the original). Pinned: the
// helpers rewrite ONLY a bare arweave tx url, the OG target asks for a PNG (satori cannot decode
// WebP), the route refuses bad input, FAILS OPEN to the original, and really returns smaller art.

const TX = "aUSdUQfNEzHqfAbm4BIdxz7IQxZEhRU1HVv8SsVSAPw"
const ART = `https://arweave.net/${TX}`

describe("arweave art reaches the resizer", () => {
  it("proxyIpfsImageUrl rewrites a bare arweave tx url to /api/public/arweave-thumb at the width", () => {
    expect(proxyIpfsImageUrl(ART, 320)).toBe(`/api/public/arweave-thumb/${TX}?w=320`)
    expect(proxyIpfsImageUrl(ART)).toBe(`/api/public/arweave-thumb/${TX}?w=640`)
  })
  it("leaves anything that is not a bare 43-char tx url alone (a subdomain, a path, a short id)", () => {
    for (const u of [`https://abc.arweave.net/${TX}`, `https://arweave.net/${TX}/x.png`, "https://arweave.net/abc", `https://arweave.net/${TX}?ext=png`]) {
      expect(proxyIpfsImageUrl(u, 320)).toBe(u)
      expect(ARWEAVE_TX_RE.test(u)).toBe(false)
    }
  })
  it("the OG card asks the resizer for a 640 px PNG, never the multi-MB original", () => {
    expect(ogImageTarget(ART)).toBe(`https://www.rippackscity.com/api/public/arweave-thumb/${TX}?w=640&f=png`)
  })
  it("the edition hero gets a srcset over the resizer's widths", () => {
    expect(heroSrcSet(`/api/public/arweave-thumb/${TX}?w=960`)).toBe(
      `/api/public/arweave-thumb/${TX}?w=320 320w, /api/public/arweave-thumb/${TX}?w=640 640w, /api/public/arweave-thumb/${TX}?w=960 960w`,
    )
  })
})

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)
const { GET } = await import("@/app/api/public/arweave-thumb/[id]/route")

const call = (id: string, qs = "") =>
  GET(new NextRequest(`https://www.rippackscity.com/api/public/arweave-thumb/${id}${qs}`), { params: Promise.resolve({ id }) })

const bigPng = () =>
  sharp({ create: { width: 1600, height: 2000, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } }).png().toBuffer()

describe("GET /api/public/arweave-thumb/[id]", () => {
  beforeEach(() => fetchMock.mockReset())

  it("resizes to a WebP no wider than w, with an immutable cache, fetched from arweave.net only", async () => {
    const png = await bigPng()
    fetchMock.mockResolvedValue(new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } }))
    const res = await call(TX, "?w=320")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(String(fetchMock.mock.calls[0][0])).toBe(ART)
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect(meta.width).toBe(320)
    expect(meta.format).toBe("webp")
  })

  it("f=png returns a PNG (the OG card's format)", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(await bigPng()), { status: 200, headers: { "content-type": "image/png" } }))
    const res = await call(TX, "?w=640&f=png")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format).toBe("png")
  })

  it("refuses an id that is not a tx id (404) and a width or format outside the set (400), fetching nothing", async () => {
    expect((await call("..%2Fetc")).status).toBe(404)
    expect((await call("abc")).status).toBe(404)
    expect((await call(TX, "?w=333")).status).toBe(400)
    expect((await call(TX, "?f=gif")).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("FAILS OPEN to the original — never a broken image — on an upstream error, a non-image or a throw", async () => {
    const expectOriginal = (res: Response) => {
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe(ART)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    fetchMock.mockResolvedValue(new Response("x", { status: 503 }))
    expectOriginal(await call(TX, "?w=320"))
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))
    expectOriginal(await call(TX, "?w=320"))
    let threw = 0
    vi.stubGlobal("fetch", async () => { threw++; throw new Error("timeout") })
    try {
      expectOriginal(await call(TX, "?w=320"))
      expect(threw).toBe(1)
    } finally {
      vi.stubGlobal("fetch", fetchMock)
    }
  })
})
