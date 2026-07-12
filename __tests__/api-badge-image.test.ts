import { describe, it, expect, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/badge-image (edge badge-art proxy).
// The slug allowlist IS the injection guard: an unknown/missing `name` (per
// `src`) yields no upstream URL → 400 before any fetch. A whitelisted slug
// proxies the CDN SVG through. We pin the allowlist 400s and stub global.fetch
// for one allowlisted happy path.

import { GET } from "@/app/api/badge-image/route"

const req = (qs = "") => new NextRequest("https://t/api/badge-image" + qs)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GET /api/badge-image", () => {
  it("400s with no name", async () => {
    expect((await GET(req())).status).toBe(400)
  })

  it("400s on a non-allowlisted topshot slug", async () => {
    expect((await GET(req("?name=notARealBadge"))).status).toBe(400)
  })

  it("400s on a non-allowlisted allday slug", async () => {
    expect((await GET(req("?src=allday&name=notARealBadge"))).status).toBe(400)
  })

  it("proxies a whitelisted topshot slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        })
      )
    )
    const res = await GET(req("?name=rookieYear"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg")
  })
})
