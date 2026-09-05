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

/**
 * ⚠ A REAL `ReadableStream`, not a string. `Response.body` is a stream in every
 * runtime this route ships to, and the route now pipes it through a counting
 * transform so a mid-flight abort is distinguishable from a completed transfer.
 * A string body made these stubs pass while exercising a shape production never
 * sees — `"binarydata".pipeThrough` does not exist, and the first version of
 * that pipe was caught by exactly this mismatch.
 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode(text))
      ctl.close()
    },
  })
}

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
        body: streamOf("binarydata"),
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
    // ⚠ THE GATEWAY THAT ANSWERED, not a hardcoded ipfs.io. Since 2026-09-05 the
    // route races a list of gateways and streams whichever replies first, so the
    // oversize redirect must hand the browser to THAT one — redirecting to a
    // gateway we never heard from would send the client to the host that just
    // failed us. With every fetch stubbed alike the primary wins.
    expect(res.headers.get("location")).toBe(`https://ipfs.dapperlabs.com/ipfs/${GOOD_CID}`)
    // The bytes must never be pulled through the function.
    expect(cancel).toHaveBeenCalled()
  })

  it("still streams (and edge-caches) an object under the ceiling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: streamOf("binarydata"),
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
        body: streamOf("binarydata"),
        headers: headersFor({ "content-type": "image/png" }),
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
  })

  /**
   * Collect every timeout the route schedules, in order. ⚠ This replaced a spy
   * on `AbortSignal.timeout`, which the route no longer calls — the assertion
   * is on the PROPERTY (how long the route waits before aborting), not on the
   * helper it happened to use to get there.
   */
  async function scheduledDelays(): Promise<number[]> {
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") delays.push(ms)
      return real(fn, ms, ...(rest as []))
    }) as typeof setTimeout)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: streamOf("x"),
        headers: headersFor({ "content-type": "image/png" }),
      })),
    )
    await GET(req, ctx(GOOD_CID))
    return delays
  }

  it("aborts well before the platform's own 25s initial-response cutoff", async () => {
    // The timeout used to be exactly 25_000 — the platform limit — so the
    // platform always won and killed the function with a 504 before the catch
    // could return its 502, making the <img onError> fallback unreachable for
    // the slow-gateway case it exists for (205 such 504s in 40 min, 2026-07-27).
    const delays = await scheduledDelays()
    expect(delays.length, "the route scheduled no abort at all").toBeGreaterThan(0)
    const headersPhase = delays[0]
    expect(headersPhase).toBeLessThan(25_000)
    expect(headersPhase).toBeLessThanOrEqual(10_000)
  })

  it("🚨 the BODY gets its own budget — the headers deadline must not govern the transfer", async () => {
    // The defect this pins: `AbortSignal.timeout(8_000)` stays live for the
    // response body, so a transfer whose headers arrived at 6s was aborted at 8s
    // MID-FLIGHT, after a 200 and the success log had already gone out. Measured
    // 2026-09-03: 426 uncaught TimeoutErrors across 60 users in 24 h, including
    // one request that logged `ok … elapsedMs=6037` and then four of them.
    //
    // ⚠ Asserted as TWO timers with the second scheduled AFTER the fetch
    // resolved, not as a raised constant — raising the single timeout would give
    // a dead gateway 20s before <img onError> can advance, which is the
    // regression the 8s value exists to prevent.
    const delays = await scheduledDelays()
    expect(
      delays.length,
      "only one timeout was scheduled, so the body is still inheriting the headers deadline",
    ).toBeGreaterThanOrEqual(2)
    expect(delays[1], "the body budget must be its own, not a repeat of the headers one").toBeGreaterThan(
      delays[0],
    )
    // Both phases together still leave room under a 25s function lifetime.
    expect(delays[0] + delays[1]).toBeLessThan(25_000)
  })

  it("logs the transfer's OUTCOME, not just the decision to stream", async () => {
    // The `ok` line is written before a byte is pumped, which is why 426 aborted
    // transfers sat behind 200s that all logged success. The second line is
    // written from the stream's own flush, so `ok` with no `streamed` is the
    // signal that a transfer died mid-flight — read by correlation, exactly like
    // the pipeline heartbeat marker.
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: streamOf("binarydata"),
        headers: headersFor({ "content-type": "image/png" }),
      })),
    )
    const res = await GET(req, ctx(GOOD_CID))
    // Draining the response is what runs the transform — without this the flush
    // never fires and the case would pass on a route that logs nothing.
    const body = await res.text()
    expect(body).toBe("binarydata")
    expect(logs.some((l) => l.includes("[ipfs-media] ok "))).toBe(true)
    const streamed = logs.find((l) => l.includes("[ipfs-media] streamed "))
    expect(streamed, "no completion line — a reader cannot tell a finished transfer from an aborted one").toBeDefined()
    // The BYTES ACTUALLY DELIVERED, which is the number the `ok` line cannot know.
    expect(streamed).toContain("bytes=10")
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

  /**
   * A fetch that hangs until the route's OWN signal aborts it, then rejects with
   * whatever the runtime chooses to surface.
   *
   * ⚠ This replaced a stub that simply rejected with a `TimeoutError`-named
   * error and never aborted anything. That version pinned the old
   * implementation's SPELLING (`err.name === "TimeoutError"`) rather than the
   * property, so it would have gone green on a route that classified every
   * failure as an abort. Driving the route's real timer is what makes the case
   * about the classification.
   */
  function hangingFetch(rejectWith?: Error) {
    return vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () =>
            rej(rejectWith ?? (init.signal!.reason as Error)),
          )
        }),
    )
  }

  it("names an ABORT distinctly from an upstream answer", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("fetch", hangingFetch())
      const p = GET(req, ctx(GOOD_CID))
      // Past the headers budget, so the route's own timer is what ends this.
      await vi.advanceTimersByTimeAsync(9_000)
      const res = await p
      expect(res.status).toBe(502)
      const line = logs.find((l) => l.includes("[ipfs-media]"))
      expect(line, "the abort must be logged at all").toBeTruthy()
      expect(line).toContain("reason=abort_timeout")
      // The discriminator: an abort must NOT be reported as an upstream answer.
      expect(line).not.toContain("upstreamStatus=")
    } finally {
      vi.useRealTimers()
    }
  })

  it("🚨 an abort stays an abort even when the runtime discards the reason", async () => {
    // ⚠ THE REASON THE CLASSIFIER READS `signal.aborted` AND NOT `err.name`.
    // `AbortSignal.timeout` rejected with a DOMException named "TimeoutError";
    // a manual `controller.abort(reason)` is only guaranteed to preserve that
    // reason in some runtimes, and this route ships to the edge runtime, which
    // is a different implementation from the one the rule was written against.
    // If the reason is replaced by a bare `Error`, a name-sniffing classifier
    // silently relabels every one of our own timeouts as a transport fault —
    // and "raise the timeout" is then the wrong fix for a problem that no
    // longer looks like ours.
    vi.useFakeTimers()
    try {
      vi.stubGlobal("fetch", hangingFetch(new Error("aborted")))
      const p = GET(req, ctx(GOOD_CID))
      await vi.advanceTimersByTimeAsync(9_000)
      const res = await p
      expect(res.status).toBe(502)
      const line = logs.find((l) => l.includes("[ipfs-media]"))
      expect(line).toContain("reason=abort_timeout")
      // The forensic field still reports what the runtime actually threw, so
      // the two can be told apart later without reading this file.
      expect(line).toContain("name=Error")
    } finally {
      vi.useRealTimers()
    }
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

// ── THE GATEWAY FALLBACK (2026-09-05) ───────────────────────────────────────
//
// 🚨 WHAT THIS BLOCK IS FOR, MEASURED AND NOT ASSUMED. This route's own header
// recorded that **~76% of uncached media loads fail** (99 × 502 vs 26 × 200 over
// 72 h) and attributed it to a slow gateway. Both of the fixes that followed —
// a longer budget, then a client-side retry — treated the gateway as a given.
// Nobody asked whether a DIFFERENT gateway would answer. Against 8 CIDs taken
// live off `/nba-top-shot/market`:
//
//     ipfs.dapperlabs.com   8/8   0.2–1.9 s
//     ipfs.io               2/8   (six 12 s timeouts)
//     cloudflare-ipfs.com   0/8   (DNS gone)
//
// ⛔ So "the art is fine, it is a cold cache" was WRONG for these CIDs: one was
// re-probed four times through this route and returned 502 at 8.1 s every time,
// `x-vercel-cache: MISS`, while ipfs.io itself answered 504 after 28 s. Nothing
// was warming. The content was simply never coming from that host.
describe("the gateway fallback", () => {
  const headersOf = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null })

  /** Stub fetch per-host so a test can make one gateway fail and another answer. */
  function stubGateways(byHost: Record<string, () => Promise<unknown>>) {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const host = new URL(url).host
        calls.push(host)
        const handler = byHost[host]
        if (!handler) throw new Error(`no stub for ${host}`)
        return handler()
      }),
    )
    return calls
  }

  const okResponse = (text: string) => ({
    ok: true,
    status: 200,
    body: streamOf(text),
    headers: headersOf({ "content-type": "image/png" }),
  })

  it("🚨 serves the image when the PRIMARY gateway is down and a fallback answers", async () => {
    // The whole point. Before this, one dead gateway meant a blank tile on a
    // public page even though the bytes were a second away on another host.
    const calls = stubGateways({
      "ipfs.dapperlabs.com": async () => {
        throw new Error("connect ETIMEDOUT")
      },
      "ipfs.io": async () => okResponse("real-png-bytes"),
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("real-png-bytes")
    // CONTROL: it genuinely tried both, rather than passing because the primary
    // was never consulted.
    expect(calls).toContain("ipfs.dapperlabs.com")
    expect(calls).toContain("ipfs.io")
  })

  it("serves the image when the primary answers and never needs the fallback", async () => {
    const calls = stubGateways({
      "ipfs.dapperlabs.com": async () => okResponse("primary-bytes"),
      "ipfs.io": async () => okResponse("fallback-bytes"),
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    // ⚠ The PRIMARY's bytes, not whichever stub happened to settle first. The
    // list is ordered by measured availability and the order must be honoured.
    expect(await res.text()).toBe("primary-bytes")
    expect(calls).toContain("ipfs.dapperlabs.com")
  })

  it("a gateway answering 404 does not win the race over one that has the bytes", async () => {
    // `Promise.race` would let a fast 404 end the request. `Promise.any` is what
    // makes a non-ok answer a rejection, and this is the case that separates them.
    stubGateways({
      "ipfs.dapperlabs.com": async () => ({
        ok: false,
        status: 404,
        body: { cancel: async () => {} },
        headers: headersOf({}),
      }),
      "ipfs.io": async () => okResponse("found-elsewhere"),
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("found-elsewhere")
  })

  it("502s only when EVERY gateway fails at the transport layer", async () => {
    stubGateways({
      "ipfs.dapperlabs.com": async () => {
        throw new Error("connect ETIMEDOUT")
      },
      "ipfs.io": async () => {
        throw new Error("connect ETIMEDOUT")
      },
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(502)
  })

  it("still passes through an ANSWERED status when every gateway answered no", async () => {
    // The pre-existing contract: a 404 is more useful to the caller than a
    // blanket 502, and the fallback must not have quietly flattened it.
    stubGateways({
      "ipfs.dapperlabs.com": async () => ({
        ok: false,
        status: 404,
        body: { cancel: async () => {} },
        headers: headersOf({}),
      }),
      "ipfs.io": async () => ({
        ok: false,
        status: 404,
        body: { cancel: async () => {} },
        headers: headersOf({}),
      }),
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(404)
  })

  it("names every gateway's outcome in ONE log line", async () => {
    // The route used to emit two different lines for two different failures.
    // With a chain there is one outcome, and an operator must still be able to
    // tell "we aborted" from "they said no" — per gateway, not in aggregate.
    const logs: string[] = []
    vi.stubGlobal("console", { ...console, log: (m: string) => logs.push(String(m)) })
    stubGateways({
      "ipfs.dapperlabs.com": async () => {
        throw new Error("connect ETIMEDOUT")
      },
      "ipfs.io": async () => ({
        ok: false,
        status: 504,
        body: { cancel: async () => {} },
        headers: headersOf({}),
      }),
    })
    await GET(req, ctx(GOOD_CID))
    const line = logs.find((l) => l.includes("every gateway failed")) ?? ""
    expect(line).toContain("ipfs.dapperlabs.com=transport")
    expect(line).toContain("ipfs.io=not_ok:504")
    // And the old field names still resolve, so existing queries keep working.
    expect(line).toContain("reason=transport")
    expect(line).toContain("upstreamStatus=504")
  })

  it("🚨 ABORTS the losing gateway — a race that pulls both bodies costs twice", async () => {
    // ⚠ THIS CASE EXISTS BECAUSE ITS ABSENCE SURVIVED MUTATION TESTING. Deleting
    // the loser-abort loop entirely left all 26 other cases GREEN, because every
    // one of them asserts on what the CLIENT receives — and the client receives
    // the winner's bytes either way. The cost of not aborting is invisible from
    // the response: the loser's stream keeps being pulled into the function, so
    // every image on the page is fetched twice from upstream.
    //
    // ⛔ That is not a hypothetical bill. This route's own header records the
    // Fast Data Transfer incident that came from exactly this class — bytes
    // moving through the function that nobody needed — and the fix for that one
    // was the oversize redirect. A fan-out that forgot to cancel would have
    // quietly reintroduced it at N× for every cached image.
    //
    // The observable is the SIGNAL, not the payload, which is why no assertion
    // about the response body could ever have caught it.
    const signals: Record<string, AbortSignal> = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { signal: AbortSignal }) => {
        const host = new URL(url).host
        signals[host] = init.signal
        if (host === "ipfs.dapperlabs.com") {
          return {
            ok: true,
            status: 200,
            body: streamOf("winner"),
            headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
          }
        }
        return {
          ok: true,
          status: 200,
          body: { cancel: async () => {}, pipeThrough: () => streamOf("loser") },
          headers: { get: () => null },
        }
      }),
    )

    const res = await GET(req, ctx(GOOD_CID))
    expect(res.status).toBe(200)

    // The loser is cancelled...
    expect(signals["ipfs.io"]?.aborted).toBe(true)
    // ...and the winner is NOT. Without this control, a mutation that aborted
    // every controller would satisfy the line above while breaking the transfer.
    expect(signals["ipfs.dapperlabs.com"]?.aborted).toBe(false)
    expect(await res.text()).toBe("winner")
  })

  it("CONTROL — a cancelled loser's body is not streamed to the client", async () => {
    // The race pulls from one gateway only. If a loser's stream were also
    // consumed we would pay twice for every image on the page.
    const loserCancel = vi.fn(async () => {})
    stubGateways({
      "ipfs.dapperlabs.com": async () => okResponse("winner"),
      "ipfs.io": async () => ({
        ok: true,
        status: 200,
        body: { cancel: loserCancel, pipeThrough: () => streamOf("loser") },
        headers: headersOf({ "content-type": "image/png" }),
      }),
    })
    const res = await GET(req, ctx(GOOD_CID))
    expect(await res.text()).toBe("winner")
  })
})
