import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { isServableMediaType } from "@/lib/media/servable-media-type"

// /api/public/ipfs-media streams a CALLER-CHOSEN CID from our origin. Only raster
// images and video may be served there; anything else is redirected to the
// gateway (security audit 2026-10-25) — HTML or an SVG pinned to IPFS would
// otherwise run its script as rippackscity.com when a visitor opened the URL.

describe("isServableMediaType", () => {
  it("serves raster images and video, including with parameters", () => {
    for (const t of ["image/png", "image/jpeg", "IMAGE/PNG", "image/webp; q=1", "video/mp4", "video/webm"]) {
      expect(isServableMediaType(t), t).toBe(true)
    }
  })
  it("refuses document-capable and unknown types", () => {
    for (const t of ["text/html", "text/html; charset=utf-8", "image/svg+xml", "application/xhtml+xml", "application/xml", "text/xml", "application/json", "application/octet-stream", "text/plain", "", null]) {
      expect(isServableMediaType(t as string | null), String(t)).toBe(false)
    }
  })
  it("the ipfs-media route consults it before streaming, and redirects otherwise", () => {
    const src = readFileSync("app/api/public/ipfs-media/[cid]/route.ts", "utf8")
    const check = src.indexOf("if (!isServableMediaType(contentType))")
    expect(check).toBeGreaterThan(0)
    expect(src.slice(check, check + 400)).toContain("NextResponse.redirect(upstreamUrl, 302)")
    expect(check).toBeLessThan(src.indexOf("upstreamBody.pipeThrough(counted)"))
  })
})
