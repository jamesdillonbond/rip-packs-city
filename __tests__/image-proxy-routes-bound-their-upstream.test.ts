import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// THE IMAGE PROXIES MUST BOUND THEIR UPSTREAM AND ANSWER WITH A STATUS.
//
// Live runtime errors for the 24 h to 2026-09-03 05:43Z carry a group of
// **463 `TimeoutError: The operation was aborted due to timeout` across 69
// users**, on routes including `/api/badge-image`. Both of the routes below
// called `fetch` with no `AbortSignal` AND no `try/catch`, so a slow CDN threw
// out of the handler as a 500 — instead of a status the caller's `<img onError>`
// can act on. A decorative badge became a broken image AND a server error.
//
// ⭐ THE PART WORTH KEEPING IS WHY THEY WERE MISSED, NOT THAT THEY WERE.
// `og-fetches-are-bounded` drove exactly this class to zero on 2026-08-29 — 30
// bare calls across 28 files — and then froze the ban to the directories where
// the class had been found: `app/api/og/**` and `lib/og/**`. These routes are
// `app/api/badge-image` and `app/api/moment-thumbnail`, so they were outside
// that walk BY CONSTRUCTION. `scripts/check-unbounded-server-reads.mjs` records
// the identical shape for the Supabase-read class ("the guard written to make it
// shape-level walks `app/insights`, so occurrence 4 was outside it BY
// CONSTRUCTION"). **This is the third time a guard's glob has excluded the next
// instance of the class it was written for.**
//
// ⚠ SO THE RATCHET BELOW IS DELIBERATELY WIDER THAN THE FIX. Bounding only the
// two routes in the error report would repeat the mistake a third time. It walks
// ALL of `app/api/**` (minus the OG tree, which has its own ban) and freezes the
// measured population so it can only fall.
//
// ⚠ AND IT IS A RATCHET, NOT A BAN, ON PURPOSE. The remaining population is 26
// files, and most are cron/ingest routes where "what should this return on a
// timeout?" is a real per-route decision — several have no honest degraded
// answer to reject into. Banning them blind would turn a slow ingest into a
// thrown one. Lower the budget when you convert a route; never raise it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const API = path.join(ROOT, "app", "api")

/** The OG tree has its own, stricter ban — `og-fetches-are-bounded`. */
const OWNED_ELSEWHERE = "app/api/og/"

/** Anything that attaches a bound, directly or through a helper. */
const BOUND = /AbortSignal\.timeout\(|new AbortController\(|ogFetch\(|fetchWithTimeout\(/

function apiFiles(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) apiFiles(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

interface Row {
  rel: string
  calls: number
  bound: boolean
}

const ROWS: Row[] = apiFiles()
  .map((full) => {
    const rel = path.relative(ROOT, full).split(path.sep).join("/")
    // ⚠ Comments stripped FIRST. Every route fixed in this class carries a
    // comment quoting the shape it replaced, and this file's own header quotes
    // `fetch` — an unstripped scan would count the documentation as the defect
    // and make a future conversion read as a regression.
    const code = stripComments(readFileSync(full, "utf8"))
    // `(?<![.\w])` keeps `res.fetch`/`prefetch(` out of the count.
    const calls = (code.match(/(?<![.\w])fetch\s*\(/g) || []).length
    return { rel, calls, bound: BOUND.test(code) }
  })
  .filter((r) => r.calls > 0 && !r.rel.startsWith(OWNED_ELSEWHERE))

const UNBOUNDED = ROWS.filter((r) => !r.bound)

/**
 * Measured 2026-09-03: 28 files under `app/api/**` (excluding the OG tree) call
 * `fetch` with no bound anywhere in the file. `badge-image` and
 * `moment-thumbnail` were converted in the same commit, taking it to 26.
 * Lower this when you convert one. NEVER raise it.
 */
const BUDGET = 26

describe("image proxies bound their upstream, and the wider class only shrinks", () => {
  it("is not vacuous — the walk found API routes, and found some that ARE bound", () => {
    // ⚠ Every clause can fail silently: a broken walk, a renamed helper, or a
    // changed `fetch` spelling all produce a clean-looking pass.
    expect(ROWS.length, "the app/api walk found no file calling fetch at all").toBeGreaterThan(20)
    expect(
      ROWS.length - UNBOUNDED.length,
      "no app/api file attaches a bound — the BOUND pattern probably stopped matching",
    ).toBeGreaterThan(0)
  })

  it(`is at or below the frozen budget of ${BUDGET}`, () => {
    expect(
      UNBOUNDED.length,
      `${UNBOUNDED.length} file(s) under app/api (excluding the OG tree, which has its own ban) ` +
        `call fetch with no AbortSignal anywhere. An unbounded upstream on a user-facing route ` +
        `throws instead of answering. Bound one and LOWER the budget in the same commit:\n  ` +
        UNBOUNDED.map((r) => `${r.rel} (${r.calls})`).join("\n  "),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("has NO SLACK — the budget equals the live count", () => {
    // A ratchet with headroom silently licenses the next N additions.
    expect(
      UNBOUNDED.length,
      `BUDGET is ${BUDGET} but the live count is ${UNBOUNDED.length}. If lower, a conversion ` +
        `landed without lowering the budget — lower it now rather than banking the slack.`,
    ).toBe(BUDGET)
  })

  it("BAN AT ZERO: the user-facing image proxies are bound", () => {
    // These three are a ban rather than a ratchet because the population is zero
    // and their answer on failure is settled: a status, so `<img onError>` can
    // fall back. They are named individually because that is the property — a
    // walk cannot tell "decorative image proxy" from "cron route".
    for (const rel of [
      "app/api/badge-image/route.ts",
      "app/api/moment-thumbnail/route.ts",
      "app/api/public/ipfs-media/[cid]/route.ts",
    ]) {
      const row = ROWS.find((r) => r.rel === rel)
      expect(row, `${rel} is gone or no longer calls fetch — re-derive this list`).toBeDefined()
      expect(row!.bound, `${rel} must bound its upstream fetch`).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 BAN AT ZERO: A ROUTE THAT STREAMS AN UPSTREAM BODY MAY NOT BOUND IT WITH
// `AbortSignal.timeout`.
//
// That helper's signal starts at fetch time and STAYS LIVE FOR THE RESPONSE
// BODY, and it cannot be rescheduled. So a proxy that returns `upstream.body`
// under one aborts transfers it has already won — the headers arrived inside
// the budget, and the stream is killed part-way through with a 200 and its
// headers already on the wire, where no catch in the handler can see it.
//
// ⭐ MEASURED: `/api/public/ipfs-media/[cid]` did exactly this and produced
// **426 uncaught TimeoutErrors across 60 users in the 24 h to 2026-09-03**, with
// one request logging `ok … elapsedMs=6037` and then four of them. Both
// streaming proxies in the tree now use a manual `AbortController` re-armed once
// the headers are in, so the population is ZERO and this is a ban, not a ratchet.
//
// ⚠ THE WALK IS THE PROPERTY, NOT A LIST OF THE TWO FILES THAT HAD THE BUG.
// This repo has now had THREE cases of a guard whose glob excluded the next
// instance of its own class (see this file's header). "Returns an upstream body
// as a Response" is the shape where the defect is possible, so that is what is
// searched — anywhere under app/ or lib/, whatever it is called.
// ─────────────────────────────────────────────────────────────────────────────
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** `new NextResponse(upstream.body …)` / `new Response(res.body …)`, comments stripped. */
const STREAMS_UPSTREAM = /new (?:Next)?Response\(\s*[A-Za-z_$][\w$]*\.body\b/

const STREAMING_PROXIES = [
  ...sourceFiles(path.join(ROOT, "app")),
  ...sourceFiles(path.join(ROOT, "lib")),
]
  .map((full) => ({
    rel: path.relative(ROOT, full).split(path.sep).join("/"),
    code: stripComments(readFileSync(full, "utf8")),
  }))
  .filter((f) => STREAMS_UPSTREAM.test(f.code))

describe("a route that streams an upstream body bounds it with a RESCHEDULABLE controller", () => {
  it("is not vacuous — the walk found streaming proxies", () => {
    // If this ever reads 0, the shape regex stopped matching (a rename, a
    // helper, a different Response constructor) and every case below is
    // silently passing on an empty set.
    expect(
      STREAMING_PROXIES.length,
      "no file returns an upstream body — STREAMS_UPSTREAM probably stopped matching",
    ).toBeGreaterThan(0)
  })

  it("BAN AT ZERO: none of them uses AbortSignal.timeout", () => {
    const offenders = STREAMING_PROXIES.filter((f) => /AbortSignal\.timeout\s*\(/.test(f.code))
    expect(
      offenders.map((f) => f.rel),
      `AbortSignal.timeout cannot be rescheduled, so its deadline governs the RESPONSE BODY as ` +
        `well as the headers — the transfer is aborted mid-flight after the 200 has gone out, ` +
        `where no catch can see it. Use a manual AbortController, re-armed once the headers ` +
        `arrive (see app/api/public/ipfs-media/[cid]/route.ts).`,
    ).toEqual([])
  })

  it("and each still bounds the fetch at all", () => {
    // The lazy way to satisfy the ban is to delete the bound. Assert the
    // replacement is present, not merely that the banned spelling is absent.
    for (const f of STREAMING_PROXIES) {
      expect(/new AbortController\s*\(/.test(f.code), `${f.rel} streams an upstream body with no bound`).toBe(
        true,
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The behavioural half. The source check above cannot tell a bound that is
// ATTACHED from one that is HONOURED, and it cannot see what the route answers
// when the upstream never responds.
// ─────────────────────────────────────────────────────────────────────────────
describe("a timed-out upstream answers with a status, never a throw", () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  /** Reject the way `AbortSignal.timeout` does — a DOMException named TimeoutError. */
  function stubTimingOutFetch() {
    const err = new Error("The operation was aborted due to timeout")
    err.name = "TimeoutError"
    const spy = vi.fn(async () => {
      throw err
    })
    vi.stubGlobal("fetch", spy)
    return spy
  }

  it("badge-image: a timing-out CDN yields 502, not a rejected promise", async () => {
    const spy = stubTimingOutFetch()
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(
      new NextRequest("https://t/api/badge-image?name=rookieYear") as never,
    )
    expect(res.status).toBe(502)
    // ⚠ The bound must be ATTACHED, not merely present in the file: assert the
    // signal reached the call. Without this, deleting `signal:` keeps the source
    // check green (the constant is still there) and this case still passes on
    // the stub's own rejection.
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0] as unknown[])[1]).toHaveProperty("signal")
  })

  it("moment-thumbnail: same contract", async () => {
    const spy = stubTimingOutFetch()
    const { GET } = await import("@/app/api/moment-thumbnail/route")
    const res = await GET(
      new NextRequest("https://t/api/moment-thumbnail?flowId=25510") as never,
    )
    expect(res.status).toBe(502)
    expect((spy.mock.calls[0] as unknown[])[1]).toHaveProperty("signal")
  })

  it("NO-CHANGE CONTROL: an upstream that ANSWERS no still passes its own status through", async () => {
    // 502 is reserved for "we never heard back". A 404 from the CDN is the CDN's
    // answer and must not be relabelled — collapsing the two would hide a dead
    // slug behind what looks like a transient timeout.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    )
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(
      new NextRequest("https://t/api/badge-image?name=rookieYear") as never,
    )
    expect(res.status).toBe(404)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // ⚠ A BOUND THAT ONLY WRAPS THE FETCH IS HALF A BOUND.
  //
  // The abort signal attached to a fetch stays live for the RESPONSE BODY. Both
  // proxies read theirs with `await upstream.arrayBuffer()` AFTER the try/catch
  // closes, so a deadline elapsing — or a connection reset — during that read
  // rejected outside every catch in the handler and escaped as a 500. Exactly
  // the failure the bound was added to remove, one statement later.
  //
  // ⓘ Found by grepping the SHAPE, not the file, after the sibling
  // `/api/public/ipfs-media` was measured doing it at scale: 426 uncaught
  // TimeoutErrors across 60 users in 24 h, 2026-09-03. These two BUFFER rather
  // than stream, so the window is much smaller and no live instance is claimed
  // for them — but the source-level check above cannot see the difference
  // between a body read that is guarded and one that is not, which is why this
  // half is behavioural.
  // ───────────────────────────────────────────────────────────────────────────
  /** Headers arrive fine; the body read is what fails. */
  function stubBodyFailingFetch(name = "TimeoutError") {
    const err = new Error("The operation was aborted due to timeout")
    err.name = name
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/svg+xml" }),
      arrayBuffer: async () => {
        throw err
      },
    }))
  }

  it("badge-image: a body that fails AFTER the headers still answers 502, not a throw", async () => {
    vi.stubGlobal("fetch", stubBodyFailingFetch())
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(new NextRequest("https://t/api/badge-image?name=rookieYear") as never)
    expect(res.status).toBe(502)
  })

  it("moment-thumbnail: same contract on the body read", async () => {
    vi.stubGlobal("fetch", stubBodyFailingFetch())
    const { GET } = await import("@/app/api/moment-thumbnail/route")
    const res = await GET(new NextRequest("https://t/api/moment-thumbnail?flowId=25510") as never)
    expect(res.status).toBe(502)
  })

  it("a TRANSPORT fault mid-body is named apart from our own deadline", async () => {
    // The discriminator is the whole value of the log line: raising the bound
    // only helps one of the two, and a reset mid-transfer is the likelier of
    // them on a buffered read this small.
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")))
    vi.stubGlobal("fetch", stubBodyFailingFetch("TypeError"))
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(new NextRequest("https://t/api/badge-image?name=rookieYear") as never)
    expect(res.status).toBe(502)
    const line = logs.find((l) => l.includes("[badge-image] upstream body failed"))
    expect(line, "a body failure must be logged at all").toBeTruthy()
    expect(line).toContain("reason=transport_body")
    expect(line).not.toContain("reason=abort_body")
  })

  it("NO-CHANGE CONTROL: a body that reads FINE is still served, with its content-type", async () => {
    // Without this, wrapping the read in a catch that swallowed everything would
    // pass all three cases above.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/svg+xml" }),
        arrayBuffer: async () => new TextEncoder().encode("<svg/>").buffer,
      })),
    )
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(new NextRequest("https://t/api/badge-image?name=rookieYear") as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
  })

  it("NO-CHANGE CONTROL: an unknown slug is still rejected before any fetch", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    const { GET } = await import("@/app/api/badge-image/route")
    const res = await GET(
      new NextRequest("https://t/api/badge-image?name=../../etc/passwd") as never,
    )
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})
