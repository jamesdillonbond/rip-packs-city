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

  // ── size ceiling (2026-07-27) ───────────────────────────────────────────────
  // Vercel's edge cache silently refuses oversize responses. Measured on prod,
  // same URL 3x: a 4.03 MB png went MISS/HIT/HIT while a 16.75 MB and a 23.27 MB
  // mp4 went MISS/MISS/MISS with `s-maxage` stripped — so every video view cost a
  // full unamortised transfer forever. Above the ceiling we redirect instead of
  // proxying, so Vercel moves zero bytes for something it could never cache.
  const headersFor = (h: Record<string, string>) => ({
    get: (k: string) => h[k.toLowerCase()] ?? null,
  })

  it("302s to the upstream gateway for an object too large to edge-cache", async () => {
    const cancel = vi.fn(async () => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: { cancel },
        headers: headersFor({ "content-type": "video/mp4", "content-length": String(23 * 1024 * 1024) }),
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://ipfs.io/ipfs/${GOOD_CID}`)
    // The bytes must never be pulled through the function.
    expect(cancel).toHaveBeenCalled()
  })

  it("still streams (and edge-caches) an object under the ceiling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: "binarydata",
        headers: headersFor({ "content-type": "image/png", "content-length": String(4 * 1024 * 1024) }),
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=31536000")
  })

  it("streams when the upstream declares no content-length (chunked)", async () => {
    // Unknown size must fall back to the prior behaviour, not guess a redirect.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: "binarydata",
        headers: headersFor({ "content-type": "image/png" }),
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
  })

  it("aborts well before the platform's own 25s initial-response cutoff", async () => {
    // The timeout used to be exactly 25_000 — the platform limit — so the
    // platform always won and killed the function with a 504 before the catch
    // could return its 502, making the <img onError> fallback unreachable for
    // the slow-gateway case it exists for (205 such 504s in 40 min, 2026-07-27).
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: "x",
        headers: headersFor({ "content-type": "image/png" }),
      })),
    )
    await GET(req, ctx(GOOD_CID))
    const ms = timeoutSpy.mock.calls[0][0] as number
    expect(ms).toBeLessThan(25_000)
    expect(ms).toBeLessThanOrEqual(10_000)
    timeoutSpy.mockRestore()
  })
})
