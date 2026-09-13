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

// ─────────────────────────────────────────────────────────────────────────────
// UPSTREAM TIMING — register #91.
//
// ⭐ WHY THE CALLEE HAS TO MEASURE THIS. `lib/og/official-mark-art.ts` bounds
// these fetches at OFFICIAL_ART_BUDGET_MS = 4_000 and logs "unavailable after
// <elapsed>ms". ⛔ Because it truncates ITSELF at the budget, its elapsed is
// always ≈ the budget — 4007ms and 4013ms are the two instances observed in
// production — so it records THAT we gave up and never WHAT WE WOULD HAVE
// WAITED. #91's option (a) ("raise to ~6-7s") can only be sized from the
// latter, and before this the success path logged nothing at all. The caller's
// instrument is structurally incapable of answering the question it was added
// for; this is the one that can.
//
// ⚠ THE FAST-PATH CASE IS THE LOAD-BEARING ONE. A route that logged EVERY
// upstream fetch would satisfy the slow assertion while making the log useless
// (warm hits are the overwhelming majority and would bury the tail). The
// threshold is the feature, so it is the thing pinned.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/badge-image — upstream timing (#91)", () => {
  /** Stub fetch so the mocked clock advances by `ms` across the round trip. */
  function stubClockAndFetch(ms: number, opts: { throwWith?: Error } = {}) {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        clock += ms
        if (opts.throwWith) throw opts.throwWith
        return new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        })
      })
    )
    return vi.spyOn(console, "log").mockImplementation(() => {})
  }

  it("logs elapsed_ms when the upstream round trip is slow", async () => {
    const log = stubClockAndFetch(2_500)
    const res = await GET(req("?name=rookieMint"))
    expect(res.status).toBe(200)

    const lines = log.mock.calls.map((c) => String(c[0]))
    const slow = lines.find((l) => l.includes("upstream slow"))
    expect(slow, `expected an "upstream slow" line; got: ${JSON.stringify(lines)}`).toBeTruthy()
    // The NUMBER is the deliverable — a line that says "slow" without the
    // measurement would satisfy a substring check and size nothing.
    expect(slow).toContain("elapsed_ms=2500")
    // And it must name the badge, so a line here joins to the URLs the caller
    // lists when it gives up.
    expect(slow).toContain("name=rookieMint")
  })

  it("CONTROL: a fast upstream logs NOTHING — the threshold is the feature", async () => {
    const log = stubClockAndFetch(5)
    const res = await GET(req("?name=rookieMint"))
    expect(res.status).toBe(200)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(
      lines.filter((l) => l.includes("[badge-image]")),
      `a warm hit must not be logged, or the tail is buried: ${JSON.stringify(lines)}`
    ).toEqual([])
  })

  it("a failed upstream logs the SLUG and the error class as separate fields", async () => {
    const err = new Error("boom")
    err.name = "TimeoutError"
    const log = stubClockAndFetch(8_000, { throwWith: err })
    const res = await GET(req("?name=rookieMint"))
    expect(res.status).toBe(502)

    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("upstream fetch failed"))
    expect(line).toBeTruthy()
    // ⚠ REGRESSION PIN: `const name = err.name` used to SHADOW the slug, so this
    // line printed name=TimeoutError while the success line printed the badge.
    // One key, two meanings, depending on the branch.
    expect(line, "name= must be the badge slug, not the error class").toContain("name=rookieMint")
    expect(line, "the error class belongs in its own field").toContain("err=TimeoutError")
    expect(line).toContain("reason=abort_timeout")
    expect(line).toContain("elapsed_ms=8000")
  })
})
