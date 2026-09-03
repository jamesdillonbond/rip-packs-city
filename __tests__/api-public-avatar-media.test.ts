import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/public/avatar-media/route"

// The same-origin avatar proxy. Its host allowlist is the SSRF guard; these
// cases are the boundary of what it will fetch and what it will re-serve.

const OK_SRC = "https://i2c.seadn.io/ethereum/0xabc/def/ghi.png?w=500"

function req(src?: string): NextRequest {
  const u = new URL("https://www.rippackscity.com/api/public/avatar-media")
  if (src !== undefined) u.searchParams.set("src", src)
  return new NextRequest(u)
}

function stubUpstream(opts: {
  status?: number
  type?: string | null
  length?: string | null
  throws?: boolean
} = {}) {
  const cancel = vi.fn().mockResolvedValue(undefined)
  const fn = vi.fn(async () => {
    if (opts.throws) throw new Error("timeout")
    const headers = new Headers()
    if (opts.type !== null) headers.set("content-type", opts.type ?? "image/png")
    if (opts.length) headers.set("content-length", opts.length)
    const status = opts.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      body: { cancel } as unknown as ReadableStream,
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fn)
  return { fn, cancel }
}

beforeEach(() => stubUpstream())
afterEach(() => vi.unstubAllGlobals())

describe("the guard runs before any fetch", () => {
  it("400s a non-allowlisted host and never calls fetch", async () => {
    const { fn } = stubUpstream()
    const res = await GET(req("https://evil.example/a.png"))
    expect(res.status).toBe(400)
    // The important half: no request left the building.
    expect(fn).not.toHaveBeenCalled()
  })

  it("400s the metadata address without fetching", async () => {
    const { fn } = stubUpstream()
    expect((await GET(req("https://169.254.169.254/latest/meta-data/"))).status).toBe(400)
    expect(fn).not.toHaveBeenCalled()
  })

  it("400s http, a missing src, and junk", async () => {
    for (const bad of ["http://i.seadn.io/a.png", undefined, "", "not a url", "javascript:alert(1)"]) {
      expect((await GET(req(bad))).status, String(bad)).toBe(400)
    }
  })
})

describe("redirects are refused, not followed", () => {
  it("asks fetch NOT to follow", async () => {
    const { fn } = stubUpstream()
    await GET(req(OK_SRC))
    expect((fn.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" })
  })

  it("502s a 3xx rather than chasing it", async () => {
    // An allowlisted host that 302s is the hole an allowlist would otherwise
    // leave open: the check passes on the first URL, the bytes come from
    // wherever the redirect points — possibly a private address.
    for (const status of [301, 302, 307, 308]) {
      stubUpstream({ status })
      expect((await GET(req(OK_SRC))).status, String(status)).toBe(502)
    }
  })
})

describe("what it will re-serve", () => {
  it("415s an SVG and cancels the body", async () => {
    // An SVG served from our origin is a document that can run script with our
    // session — stored XSS delivered as a profile picture.
    const { cancel } = stubUpstream({ type: "image/svg+xml" })
    const res = await GET(req(OK_SRC))
    expect(res.status).toBe(415)
    expect(cancel).toHaveBeenCalled()
  })

  it("415s text/html — the OpenSea-page case reaching the proxy", async () => {
    stubUpstream({ type: "text/html; charset=utf-8" })
    expect((await GET(req(OK_SRC))).status).toBe(415)
  })

  it("serves a png with our own content-type and nosniff", async () => {
    stubUpstream({ type: "image/png" })
    const res = await GET(req(OK_SRC))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })

  it("normalises a parameterised upstream type instead of echoing it", async () => {
    // Echoing the header verbatim is how a crafted content-type smuggles a
    // different type past a check that only looked at the prefix.
    stubUpstream({ type: "image/png; charset=binary" })
    const res = await GET(req(OK_SRC))
    expect(res.headers.get("content-type")).toBe("image/png")
  })

  it("caches at the edge but NOT immutably", async () => {
    // A CID names its bytes forever; an avatar URL does not, so a changed image
    // must not be pinned for a year.
    const cc = (await GET(req(OK_SRC))).headers.get("cache-control") ?? ""
    expect(cc).toContain("s-maxage=")
    expect(cc).toContain("stale-while-revalidate=")
    expect(cc).not.toContain("immutable")
  })
})

describe("failure falls through to the monogram", () => {
  it("502s an oversize image and cancels the body", async () => {
    // 502 rather than a redirect to upstream, unlike ipfs-media: these hosts are
    // NOT in the CSP, so redirecting hands the browser a URL its own policy
    // forbids — a guaranteed broken image instead of a clean fall-through.
    const { cancel } = stubUpstream({ length: String(9 * 1024 * 1024) })
    const res = await GET(req(OK_SRC))
    expect(res.status).toBe(502)
    expect(cancel).toHaveBeenCalled()
  })

  it("502s a timeout or transport fault", async () => {
    stubUpstream({ throws: true })
    expect((await GET(req(OK_SRC))).status).toBe(502)
  })

  it("502s an upstream error", async () => {
    stubUpstream({ status: 404 })
    expect((await GET(req(OK_SRC))).status).toBe(502)
  })

  it("bounds the upstream fetch with a signal", async () => {
    const { fn } = stubUpstream()
    await GET(req(OK_SRC))
    expect((fn.mock.calls[0] as unknown[])[1]).toHaveProperty("signal")
  })

  it("names its own bound apart from a transport fault, instead of 502ing silently", async () => {
    // ⚠ This route inherited ipfs-media's TIMEOUT lesson and not its
    // OBSERVABILITY one: it returned this 502 with no log, so "our bound fired"
    // and "the host answered" were spelled identically. That ambiguity is what
    // left ipfs-media's soft-fail path unreachable dead code for months.
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")))
    stubUpstream({ throws: true })
    expect((await GET(req(OK_SRC))).status).toBe(502)
    const line = logs.find((l) => l.includes("[avatar-media] upstream fetch failed"))
    expect(line, "the failure must be logged at all").toBeTruthy()
    // The stub throws without ever aborting the signal, so this is a transport
    // fault and must not be labelled as our deadline.
    expect(line).toContain("reason=transport")
    expect(line).not.toContain("reason=abort_timeout")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE BODY MUST NOT INHERIT THE HEADERS DEADLINE.
//
// `AbortSignal.timeout` starts at fetch time and stays live for the response
// body, and this route returns `upstream.body`. So a transfer whose headers
// arrived at 5s and was still sending at 6s was aborted MID-FLIGHT, after the
// 200 had gone out, with no catch able to see it.
//
// ⓘ Measured on the sibling, not here: `/api/public/ipfs-media/[cid]` had the
// identical shape and produced 426 uncaught TimeoutErrors across 60 users in
// 24 h (2026-09-03). Avatars are ≤4 MB and usually far less, so this route's
// window is much narrower and no live instance is claimed — the shape was found
// by grepping the EXPRESSION rather than the file.
// ─────────────────────────────────────────────────────────────────────────────
describe("the transfer gets its own budget", () => {
  /** Every delay the route schedules, in order. */
  async function scheduledDelays(): Promise<number[]> {
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") delays.push(ms)
      return real(fn, ms, ...(rest as []))
    }) as typeof setTimeout)
    stubUpstream()
    await GET(req(OK_SRC))
    return delays
  }

  it("🚨 schedules TWO deadlines, the second only after the headers are in", async () => {
    const delays = await scheduledDelays()
    expect(
      delays.length,
      "only one timeout was scheduled, so the body is still inheriting the headers deadline",
    ).toBeGreaterThanOrEqual(2)
    expect(delays[1], "the body budget must be its own, not a repeat of the headers one").toBeGreaterThan(
      delays[0],
    )
  })

  it("keeps the HEADERS deadline well under the platform's 25s initial-response cutoff", async () => {
    // The property the 6s value exists for, asserted rather than the constant:
    // at the platform limit the platform wins the race and kills the function
    // before the catch can return its 502, so the monogram fallback never fires.
    const delays = await scheduledDelays()
    expect(delays[0]).toBeLessThan(25_000)
    expect(delays[0]).toBeLessThanOrEqual(10_000)
  })
})
