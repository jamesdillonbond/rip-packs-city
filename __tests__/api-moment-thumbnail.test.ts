import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/moment-thumbnail (GET, edge). Image proxy to
// assets.nbatopshot.com. The flowId-format guard is testable with no network;
// the happy + upstream-error paths are exercised with a stubbed global.fetch.

import { GET } from "@/app/api/moment-thumbnail/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GET /api/moment-thumbnail", () => {
  it("400s when flowId is missing", async () => {
    const res = await GET(req("https://t/api/moment-thumbnail"))
    expect(res.status).toBe(400)
  })

  it("400s when flowId contains illegal characters", async () => {
    const res = await GET(req("https://t/api/moment-thumbnail?flowId=abc/../etc"))
    expect(res.status).toBe(400)
  })

  it("proxies the upstream image with a long-lived cache header", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new ArrayBuffer(4),
    }))
    const res = await GET(req("https://t/api/moment-thumbnail?flowId=12345"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toContain("immutable")
  })

  it("propagates a non-ok upstream status", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const res = await GET(req("https://t/api/moment-thumbnail?flowId=missing"))
    expect(res.status).toBe(404)
  })
})
