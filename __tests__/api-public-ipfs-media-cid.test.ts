import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/public/ipfs-media/[cid] (edge). Dynamic route:
// 2nd arg is { params: Promise<{ cid }> }. The CID regex is the SSRF guard, so
// bad CIDs 400 pre-fetch. Otherwise it streams the ipfs.io upstream back. We stub
// global fetch to pin: 400 on a bad CID, 200 + content-type passthrough on a good
// upstream, upstream-status passthrough on a not-ok upstream, and 502 on a fetch
// fault.

import { GET } from "@/app/api/public/ipfs-media/[cid]/route"

const ctx = (cid: string) => ({ params: Promise.resolve({ cid }) })
const req = {} as any
// A syntactically valid CIDv0 (Qm + 44 base58 chars — the regex allowlist).
const GOOD_CID = "Qm" + "A".repeat(44)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/public/ipfs-media/[cid]", () => {
  it("400s on a CID that fails the SSRF allowlist regex", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    const res = await GET(req, ctx("../etc/passwd"))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled() // guard is pre-fetch
  })

  it("streams the upstream body with its content-type on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: "binarydata",
        headers: { get: () => "image/png" },
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toContain("immutable")
  })

  it("passes through a non-ok upstream status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, body: null, headers: { get: () => null } })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(404)
  })

  it("502s when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout")
      }),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(502)
  })
})
