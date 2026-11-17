// Contract tests for the upstream circuit breaker.
//
// The property that matters is NEGATIVE — "this can never pause a working
// pipeline" — and a negative claim is the shape this repo has repeatedly found
// stated in a comment and asserted nowhere. So it is asserted first, directly,
// and with the failure direction exercised in both directions.

import { describe, it, expect } from "vitest"
import {
  checkUpstreamBreaker,
  CLOUDFLARE_ORIGIN_DOWN,
  UPSTREAM_OUTAGE_SKIP,
} from "@/lib/pipeline/upstream-breaker"

type Row = { ok: boolean | null; error: string | null; finished_at: string | null; extra: unknown }

/** Minimal stand-in for the supabase query builder chain this module uses. */
function fakeClient(rows: Row[] | null, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error }),
  }
  return { from: () => chain } as never
}

const NOW = Date.parse("2026-08-30T03:00:00Z")
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const WINDOW = 30 * 60 * 1000

const call = (rows: Row[] | null, error: unknown = null, windowMs = WINDOW) =>
  checkUpstreamBreaker({
    pipeline: "offers-sweep",
    windowMs,
    client: fakeClient(rows, error),
    now: () => NOW,
  })

const failing = (msAgo: number, err = "Top Shot GraphQL failed with 530. Response body: <head>"): Row => ({
  ok: false,
  error: err,
  finished_at: at(msAgo),
  extra: null,
})

describe("upstream breaker — it cannot pause a HEALTHY pipeline", () => {
  it("does not trip when the most recent run succeeded", async () => {
    const v = await call([{ ok: true, error: null, finished_at: at(60_000), extra: null }])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("last_run_ok")
  })

  it("does not trip when a success FOLLOWS the outage failures", async () => {
    // Recovery must disarm it immediately, not after the window elapses.
    const v = await call([
      { ok: true, error: null, finished_at: at(60_000), extra: null },
      failing(120_000),
      failing(180_000),
    ])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("last_run_ok")
  })

  it("does not trip on a failure that is NOT the upstream signature", async () => {
    // An error in our own code must stay loud. If it could trip the breaker it
    // would then hide behind it.
    const v = await call([failing(60_000, "TypeError: cannot read property 'id' of undefined")])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("error_not_upstream")
  })

  it("does not trip for a pipeline with no history at all", async () => {
    const v = await call([])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("no_prior_run")
  })
})

describe("upstream breaker — POSITIVE CONTROL: it does trip when the upstream is down", () => {
  // Without this the suite above would pass on a function that returns
  // `skip: false` unconditionally.
  it("trips on a recent signature failure", async () => {
    const v = await call([failing(60_000)])
    expect(v.skip).toBe(true)
    expect(v.reason).toBe("upstream_down")
    expect(v.lastError).toContain("530")
  })

  it.each([
    ["Top Shot GraphQL failed with 530. Response body: <head>"],
    ["http 530: error code: 1033"],
    ["graphql: gql HTTP 530: error code: 1033  | graphql: gql HTTP 530"],
    ["HTTP 530 error code: 1033"],
  ])("matches the shape observed in production: %s", async (err) => {
    expect(CLOUDFLARE_ORIGIN_DOWN.test(err)).toBe(true)
    expect((await call([failing(60_000, err)])).skip).toBe(true)
  })

  it("the signature does NOT match ordinary prose containing 530", async () => {
    // A bare /530/ would match all of these, and a signature that matches
    // ordinary text lets our own bugs trip the breaker.
    for (const s of ["wrote 530 rows", "cursor 530", "530 editions skipped", "duration 5301 ms"]) {
      expect(CLOUDFLARE_ORIGIN_DOWN.test(s)).toBe(false)
    }
  })
})

describe("upstream breaker — HALF-OPEN, so a pause reverses itself", () => {
  it("stops skipping once the window has elapsed", async () => {
    const v = await call([failing(WINDOW + 1000)])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("outside_window")
  })

  it("is still armed just inside the window", async () => {
    // Pins the boundary in both directions, so an off-by-one cannot pass.
    expect((await call([failing(WINDOW - 1000)])).skip).toBe(true)
  })

  it("does not disarm itself after writing ONE skip marker", async () => {
    // The marker is the newest row. If it were treated as "the last real run",
    // the breaker would fire exactly once and then let every tick through.
    const marker: Row = {
      ok: true,
      error: null,
      finished_at: at(10_000),
      extra: { skipped: UPSTREAM_OUTAGE_SKIP },
    }
    const v = await call([marker, failing(60_000)])
    expect(v.skip).toBe(true)
    expect(v.reason).toBe("upstream_down")
  })

  it("steps over MANY stacked skip markers", async () => {
    const markers: Row[] = Array.from({ length: 5 }, (_, i) => ({
      ok: true,
      error: null,
      finished_at: at(10_000 * (i + 1)),
      extra: { skipped: UPSTREAM_OUTAGE_SKIP },
    }))
    expect((await call([...markers, failing(60_000)])).skip).toBe(true)
  })
})

describe("upstream breaker — every unreadable state FAILS OPEN", () => {
  // "Open" here means one ordinary tick; "closed" means a silently paused
  // pipeline. The cheaper mistake is the one this must make.
  it("fails open when the query returns an error", async () => {
    // ⚠ supabase-js RETURNS the error rather than throwing — the shape that
    // defeated the saturation throttle's `count ?? 0`.
    const v = await call(null, { message: "canceling statement due to statement timeout" })
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("read_failed")
  })

  it("fails open when the client throws", async () => {
    const throwing = { from: () => { throw new Error("network") } } as never
    const v = await checkUpstreamBreaker({
      pipeline: "offers-sweep", windowMs: WINDOW, client: throwing, now: () => NOW,
    })
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("read_failed")
  })

  it("fails open on an unparseable finished_at", async () => {
    const v = await call([{ ok: false, error: "failed with 530", finished_at: "not-a-date", extra: null }])
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("read_failed")
  })

  it("fails open when data is null with no error", async () => {
    const v = await call(null)
    expect(v.skip).toBe(false)
    expect(v.reason).toBe("no_prior_run")
  })

  it("REGRESSION — a NON-ARRAY payload must not throw into the calling route", async () => {
    // This was a real bug, caught by __tests__/api-cron-offers-sweep-deep.test.ts
    // rather than by this file: `rows.find()` sat outside the try, so a payload
    // that was not an array threw past this module and was swallowed by the
    // ROUTE's fatal handler — which logged a fatal run and reset the cursor.
    // A breaker whose failure mode is "abort the pipeline it protects" is worse
    // than no breaker at all.
    const shapes: unknown[] = [
      { cursor_after: "cursor-A" }, // the shape the route fixture returns
      "unexpected string",
      42,
    ]
    for (const shape of shapes) {
      const v = await checkUpstreamBreaker({
        pipeline: "offers-sweep",
        windowMs: WINDOW,
        client: fakeClient(shape as never),
        now: () => NOW,
      })
      expect(v.skip).toBe(false)
      expect(v.reason).toBe("read_failed")
    }
  })

  it("an EMPTY array is not the same answer as an unreadable one", async () => {
    // Both fail open, but they must stay distinguishable: collapsing them would
    // make a brand-new pipeline indistinguishable from a broken read.
    expect((await call([])).reason).toBe("no_prior_run")
    expect((await call(null, { message: "timeout" })).reason).toBe("read_failed")
  })
})
