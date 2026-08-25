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

// OBSERVABILITY. This route's dominant outcome is a 502 — measured over 72 h of
// cache-MISS invocations, 99 × 502 against 26 × 200 and 5 × 302 — and it used to
// be returned SILENTLY, so "our 8 s abort fired" and "ipfs.io answered 5xx" were
// spelled identically in the logs and neither could be counted.
//
// ⚠ That blindness has already cost this route once: its header records that the
// 502 path was unreachable DEAD CODE for the slow-gateway case it exists for,
// and it took a hand count of 504s to notice. These cases pin that the two
// failure modes are DISTINGUISHABLE in the log line, not merely that something
// is logged — a single generic message would satisfy "it logs" and re-create the
// exact ambiguity being fixed.
describe("GET /api/public/ipfs-media/[cid] — failure modes are attributable", () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "))
    })
  })

  it("names an ABORT distinctly from an upstream answer", async () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout))
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(502)
    const line = logs.find((l) => l.includes("[ipfs-media]"))
    expect(line, "the abort must be logged at all").toBeTruthy()
    expect(line).toContain("reason=abort_timeout")
    // The discriminator: an abort must NOT be reported as an upstream answer.
    expect(line).not.toContain("upstreamStatus=")
  })

  it("names a TRANSPORT fault distinctly from an abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")))
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(502)
    const line = logs.find((l) => l.includes("[ipfs-media]"))
    expect(line).toContain("reason=transport")
    expect(line).not.toContain("reason=abort_timeout")
  })

  it("reports the gateway's OWN status when it answered not-ok", async () => {
    // The case measured live: ipfs.io itself returns 504 after ~28s. No change to
    // UPSTREAM_TIMEOUT_MS can move this one, which is why it must be separable.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 504 })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(504)
    const line = logs.find((l) => l.includes("[ipfs-media]"))
    expect(line).toContain("upstreamStatus=504")
    expect(line).not.toContain("reason=abort_timeout")
  })

  it("flags a chunked upstream as hasLength=false, which the size ceiling cannot see", async () => {
    // A chunked upstream has no content-length, so the oversize redirect cannot
    // fire and a multi-MB object streams through uncacheable — the Fast Data
    // Transfer shape. It was previously indistinguishable from a small image.
    // ⚠ Must be a STREAM body. `new Response("string")` sets content-length
    // automatically, so a string fixture makes hasLength=true and the case
    // silently tests the opposite of its name — which is how a chunked upstream
    // gets mistaken for a small cached image in the first place.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("body"))
        c.close()
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    const line = logs.find((l) => l.includes("[ipfs-media] ok"))
    expect(line).toContain("hasLength=false")
    expect(line).toContain("type=video/mp4")
  })
})

// ⚠ A COERCION TRAP IN THE SIZE CEILING, pinned 2026-08-24.
//
// The route's comment says a missing content-length "falls through to the
// streaming path rather than guessing". It does — but NOT by the mechanism the
// wording implies. `headers.get()` returns `null` when absent, and
// `Number(null ?? "")` is 0, for which `Number.isFinite` is TRUE. So the absent
// case is not detected as absent; it becomes a finite ZERO that happens to fail
// the `>` comparison.
//
// Right outcome, wrong reasoning — the shape that breaks the moment someone
// inverts the condition. Pinned as BEHAVIOUR (a chunked upstream streams, and is
// reported as hasLength=false) rather than as the spelling of the expression, so
// the property survives a refactor of how the check is written.
describe("size ceiling: absent vs zero vs unparseable content-length", () => {
  it("the coercion that makes this subtle is real, not hypothetical", () => {
    // Documents WHY the route reads the raw header separately. If a future
    // runtime ever made this NaN, the route's fallthrough reasoning changes and
    // this case is the alarm.
    //
    // ⚠ Routed through a real Headers object rather than the literal
    // `Number(null ?? "")`: TypeScript folds that literal and rejects it as
    // "always nullish" (TS2871), and writing it literally would ALSO be a
    // weaker claim — this asserts what `headers.get()` actually returns for an
    // absent header, which is the thing the route depends on.
    const absent = new Headers().get("content-length")
    expect(absent).toBeNull()
    expect(Number(absent ?? "")).toBe(0)
    expect(Number.isFinite(Number(absent ?? ""))).toBe(true)
  })

  it("a chunked upstream (no content-length) streams and is flagged", async () => {
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")) })
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("x")); c.close() },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } }),
    ))
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200) // streamed, NOT redirected
    expect(logs.find((l) => l.includes("[ipfs-media] ok"))).toContain("hasLength=false")
  })

  it("an UNPARSEABLE content-length also streams rather than redirecting", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("x")); c.close() },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "not-a-number" },
      }),
    ))
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
  })

  it("NO-CHANGE CONTROL: a declared oversize length still redirects", async () => {
    // Without this, "everything streams" would satisfy the two cases above and
    // the size ceiling could be deleted entirely.
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("x")); c.close() },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(9 * 1024 * 1024) },
      }),
    ))
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(302)
  })
})
