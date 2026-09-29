import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { NextRequest } from "next/server"
import { proxyIpfsImageUrl, proxyIpfsUrl, thumbWidthFor } from "@/lib/ipfs-media"

// ── known-issues #162 (2026-09-29) ───────────────────────────────────────────
// Every UFC Strike image is a 3.7–4.4 MB PNG, rendered with a plain <img>, so a phone downloaded
// megabytes per 60–120 px tile. /api/public/ipfs-thumb/<cid>?w= resizes once per (CID, width) and
// the CDN serves it after that. Pinned here: the helper only rewrites IPFS art, widths round UP to a
// fixed set, the route refuses bad input, FAILS OPEN to the original on any failure, and really
// returns a smaller WebP.

const CID = "QmS5zRrP4D95mmxFdYpjhhQYiLWa9LsqUr9FRGYFjLagng"

describe("proxyIpfsImageUrl / thumbWidthFor", () => {
  it("rewrites an ipfs.io image to the resizing proxy at the requested width", () => {
    expect(proxyIpfsImageUrl(`https://ipfs.io/ipfs/${CID}`, 320)).toBe(`/api/public/ipfs-thumb/${CID}?w=320`)
    expect(proxyIpfsImageUrl(`https://ipfs.io/ipfs/${CID}`)).toBe(`/api/public/ipfs-thumb/${CID}?w=640`)
  })

  it("passes typed CDN art through untouched, exactly as proxyIpfsUrl does", () => {
    const cdn = "https://assets.nbatopshot.com/media/123/image?width=250"
    expect(proxyIpfsImageUrl(cdn, 320)).toBe(cdn)
    expect(proxyIpfsImageUrl(cdn, 320)).toBe(proxyIpfsUrl(cdn))
    expect(proxyIpfsImageUrl(null)).toBeNull()
  })

  it("rounds a rendered size UP to an allowed width, capped at the largest", () => {
    expect(thumbWidthFor(34)).toBe(160)
    expect(thumbWidthFor(144)).toBe(160)
    expect(thumbWidthFor(161)).toBe(320)
    expect(thumbWidthFor(400)).toBe(640)
    expect(thumbWidthFor(5000)).toBe(960)
  })
})

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)
const { GET } = await import("@/app/api/public/ipfs-thumb/[cid]/route")

const call = (cid: string, w?: string) =>
  GET(new NextRequest(`https://www.rippackscity.com/api/public/ipfs-thumb/${cid}${w === undefined ? "" : `?w=${w}`}`), {
    params: Promise.resolve({ cid }),
  })

async function bigPng(): Promise<Buffer> {
  return sharp({ create: { width: 1600, height: 2000, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } })
    .png()
    .toBuffer()
}

describe("GET /api/public/ipfs-thumb/[cid]", () => {
  beforeEach(() => fetchMock.mockReset())

  it("resizes the original to a WebP no wider than w, with an immutable cache", async () => {
    const png = await bigPng()
    fetchMock.mockResolvedValue(new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } }))
    const res = await call(CID, "320")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect(res.headers.get("cache-control")).toContain("immutable")
    const out = Buffer.from(await res.arrayBuffer())
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.width).toBe(320)
    expect(out.byteLength).toBeLessThan(png.byteLength)
    // It fetched the ORIGINAL through our own edge proxy, not a gateway.
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://www.rippackscity.com/api/public/ipfs-media/${CID}`)
  })

  it("never enlarges a small original", async () => {
    const small = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#000" } }).png().toBuffer()
    fetchMock.mockResolvedValue(new Response(new Uint8Array(small), { status: 200, headers: { "content-type": "image/png" } }))
    const meta = await sharp(Buffer.from(await (await call(CID, "640")).arrayBuffer())).metadata()
    expect(meta.width).toBe(100)
  })

  it("fails OPEN to the original, uncached, when the upstream is not an image (a video CID)", async () => {
    fetchMock.mockResolvedValue(new Response("x", { status: 200, headers: { "content-type": "video/mp4" } }))
    const res = await call(CID, "320")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://www.rippackscity.com/api/public/ipfs-media/${CID}`)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("fails OPEN when the upstream errors or the bytes do not decode", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }))
    expect((await call(CID, "320")).status).toBe(302)
    fetchMock.mockResolvedValue(new Response("not a png", { status: 200, headers: { "content-type": "image/png" } }))
    expect((await call(CID, "320")).status).toBe(302)
  })

  it("fails OPEN when the upstream fetch throws (a timeout)", async () => {
    let threw = 0
    vi.stubGlobal("fetch", async () => { threw++; throw new Error("timeout") })
    try {
      expect((await call(CID, "320")).status).toBe(302)
      expect(threw).toBe(1)
    } finally {
      vi.stubGlobal("fetch", fetchMock)
    }
  })

  it("refuses a malformed CID and an unlisted width without fetching anything", async () => {
    expect((await call("not-a-cid", "320")).status).toBe(404)
    expect((await call(CID, "333")).status).toBe(400)
    expect((await call(CID, "abc")).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// Ratchet: the resizer is IMAGES ONLY. A video fed to it 302s back (fail-open), costing a wasted
// hop on every play, so no line that builds a video src/url may call proxyIpfsImageUrl.
describe("no video is routed through the image resizer", () => {
  it("every proxyIpfsImageUrl call site is on a line that is not a video src", () => {
    const roots = ["app", "components", "lib"]
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(ent.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (line.includes("proxyIpfsImageUrl(") && /video(_url|Url)|<video/i.test(line)) offenders.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    let seen = 0
    for (const r of roots) walk(path.join(process.cwd(), r))
    for (const r of roots) {
      const count = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
        const p = path.join(d, e.name)
        return n + (e.isDirectory() ? count(p) : /\.(ts|tsx)$/.test(e.name) ? (fs.readFileSync(p, "utf8").match(/proxyIpfsImageUrl\(/g)?.length ?? 0) : 0)
      }, 0)
      seen += count(path.join(process.cwd(), r))
    }
    // Not vacuous: the call sites exist (44 converted on 2026-09-29).
    expect(seen).toBeGreaterThan(30)
    expect(offenders).toEqual([])
  })
})
