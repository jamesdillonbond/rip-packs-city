import { describe, it, expect, afterEach, vi } from "vitest"
import {
  boundedRead,
  apiReadTimeoutMs,
  API_DB_READ_TIMEOUT_MS,
  RPC_READ_TIMEOUT_CODE,
} from "../lib/api/bounded-read"
import { safeApiError, statusForSafeError } from "../lib/api-error"

// ─────────────────────────────────────────────────────────────────────────────
// The behavioural half of the API-route read bound.
//
// `__tests__/api-routes-that-degrade-honestly-also-bound-their-reads.test.ts`
// is the SOURCE half — it can see that a route names a budget primitive, and
// its own header says it cannot see "whether the bound is HONOURED, or what the
// route answers when it fires". This file is that missing half, and it is the
// shape `image-proxy-routes-bound-their-upstream` pairs for the same reason.
//
// ⚠ EVERY case below drives a read that NEVER settles. That is the point: a
// test whose read resolves quickly passes identically with the bound removed,
// which is how a guard comes to read as coverage while measuring nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** A supabase-js read that never settles — the failure this file exists for. */
function neverSettles(): PromiseLike<{ data: unknown; error: unknown }> {
  return new Promise<{ data: unknown; error: unknown }>(() => {})
}

afterEach(() => {
  delete process.env.API_DB_READ_TIMEOUT_MS
  vi.useRealTimers()
})

describe("boundedRead", () => {
  it("RESOLVES a hung read into the { data, error } branch the route already has", async () => {
    process.env.API_DB_READ_TIMEOUT_MS = "20"
    const { data, error } = await boundedRead(neverSettles(), "api/test/hung")
    // Both halves matter. `data: null` is what the route's own `if (error)`
    // branch returns on; a non-null payload here would let a route answer with
    // a fabricated empty result instead of an honest 503.
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect((error as { message: string }).message).toContain("api/test/hung")
    expect((error as { message: string }).message).toContain("read exceeded 20ms")
  })

  it("NEVER REJECTS on overrun — a rejection would escape routes that have no catch", async () => {
    // The whole reason this helper exists rather than `withBoardBudget`.
    // `app/api/wallet-summary` destructures the read with no try/catch, so a
    // rejecting bound would convert a slow read into an unhandled 500 — a
    // failure its own honest-error helper never gets to classify.
    process.env.API_DB_READ_TIMEOUT_MS = "20"
    await expect(boundedRead(neverSettles(), "api/test/no-throw")).resolves.toBeTruthy()
  })

  it("folds a TRANSPORT REJECTION into the same envelope", async () => {
    // supabase-js RETURNS Postgrest errors, but the fetch underneath it can
    // still reject. A route that handles one and not the other is only half
    // converted, and the unhandled half is the 500.
    const { data, error } = await boundedRead(
      Promise.reject(new Error("socket hang up")),
      "api/test/transport",
    )
    expect(data).toBeNull()
    expect((error as { message: string }).message).toBe("socket hang up")
  })

  it("a THROWN Postgrest error keeps its `code`, so apiErrorResponse can still classify it", async () => {
    // 🚨 The regression the first draft shipped. `apiErrorResponse` reads
    // `error.code`: `57014` is a retryable 503, anything else a hard 500. A
    // helper that rebuilt the thrown value as `{ message }` stripped the code
    // and turned /api/collection-snapshot's honest 503 into a 500 telling the
    // caller not to retry. Pinned here as well as in that route's own test,
    // because the defect belongs to THIS file.
    const thrown = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    })
    const { data, error } = await boundedRead(Promise.reject(thrown), "api/test/thrown-pg")
    expect(data).toBeNull()
    expect(error).toBe(thrown)
    expect((error as { code?: string }).code).toBe("57014")
  })

  it("a thrown PRIMITIVE still gets an envelope with a message", async () => {
    const { data, error } = await boundedRead(Promise.reject("boom"), "api/test/thrown-primitive")
    expect(data).toBeNull()
    expect((error as { message: string }).message).toBe("boom")
  })

  it("🚨 a timed-out COUNT read resolves count NULL, never 0", async () => {
    // The one way this bound could become the defect it prevents. CLAUDE.md
    // names `?? 0` on a supabase count as a fabricated-number shape: a failed
    // count that resolves to zero publishes a MEASURED zero. A bound filling in
    // `count: 0` would manufacture that at every call site at once.
    process.env.API_DB_READ_TIMEOUT_MS = "20"
    const { count, error } = await boundedRead(neverSettles(), "api/test/hung-count")
    expect(count).toBeNull()
    expect(count).not.toBe(0)
    expect(error).not.toBeNull()
  })

  it("a thrown COUNT read also resolves count NULL", async () => {
    const { count } = await boundedRead(Promise.reject(new Error("nope")), "api/test/thrown-count")
    expect(count).toBeNull()
  })

  it("CONTROL: a real count passes through untouched", async () => {
    process.env.API_DB_READ_TIMEOUT_MS = "5000"
    const { count } = await boundedRead(
      Promise.resolve({ data: null, error: null, count: 0 }),
      "api/test/real-zero-count",
    )
    // A MEASURED zero must survive. Collapsing it to null would be the same
    // conflation in the other direction.
    expect(count).toBe(0)
  })

  it("CONTROL: a read that settles inside the budget passes through UNTOUCHED", async () => {
    // The no-change case. Without it, a bound that swallowed every read would
    // pass all three cases above.
    process.env.API_DB_READ_TIMEOUT_MS = "5000"
    const rows = [{ id: 1 }]
    const out = await boundedRead(Promise.resolve({ data: rows, error: null }), "api/test/fast")
    expect(out.data).toBe(rows)
    expect(out.error).toBeNull()
  })

  it("CONTROL: a read that settles WITH a Postgrest error is not relabelled as a timeout", async () => {
    // The bound must not overwrite a real error with its own — an operator
    // grepping for `57014` has to still find it.
    process.env.API_DB_READ_TIMEOUT_MS = "5000"
    const pgErr = { message: "canceling statement due to statement timeout", code: "57014" }
    const { data, error } = await boundedRead(
      Promise.resolve({ data: null, error: pgErr }),
      "api/test/pg-error",
    )
    expect(data).toBeNull()
    expect(error).toBe(pgErr)
  })

  it("clears its timer, so a fast read leaves no pending handle", async () => {
    // `withBoardBudget` records why: an uncleared 8 s timer keeps the event loop
    // alive, turning a bound meant to shorten a response into a source of delay.
    vi.useFakeTimers()
    await boundedRead(Promise.resolve({ data: [], error: null }), "api/test/timer")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("an explicit timeoutMs beats the env and the default", async () => {
    process.env.API_DB_READ_TIMEOUT_MS = "60000"
    const { error } = await boundedRead(neverSettles(), "api/test/explicit", 20)
    expect((error as { message: string }).message).toContain("read exceeded 20ms")
  })
})

describe("apiReadTimeoutMs", () => {
  it("defaults when the env var is absent", () => {
    expect(apiReadTimeoutMs()).toBe(API_DB_READ_TIMEOUT_MS)
  })

  it("a NON-NUMERIC or NON-POSITIVE env value falls back rather than un-bounding", () => {
    // An env typo must not silently remove the bound in production — the
    // failure would be invisible until the next 504.
    for (const bad of ["", "abc", "0", "-1", "NaN"]) {
      process.env.API_DB_READ_TIMEOUT_MS = bad
      expect(apiReadTimeoutMs(), `"${bad}" must fall back`).toBe(API_DB_READ_TIMEOUT_MS)
    }
  })

  it("a valid env value is honoured", () => {
    process.env.API_DB_READ_TIMEOUT_MS = "250"
    expect(apiReadTimeoutMs()).toBe(250)
  })
})

// ── THE TWO HALVES MUST CONNECT (2026-09-04) ───────────────────────────────
//
// Neither unit test could see this on its own, and that is why it shipped:
// `api-error.test.ts` proves the CLASSIFIER handles the code, and the cases
// above prove the HELPER resolves on timeout — but nothing asserted the helper
// actually STAMPS the code the classifier reads. Removing it from the helper
// left every test in this file green while restoring the original bug.
//
// 🚨 The bug: a bound timeout carried no `code`, its message ("read exceeded
// 8000ms") matches none of the classifier's substrings, and so all **86 routes**
// pairing this helper with `apiErrorResponse` answered a transient timeout as
// `{ code: "internal", retryable: false }` at **500** with no `Retry-After`.
// Measured live on /api/collection-stats: 500 at 8.2 s, then 200 at 4.0 s on the
// very next request — the one action the caller should have taken was the one
// the response told it not to.
describe("a timeout carries the code the error classifier reads", () => {
  afterEach(() => { delete process.env.API_DB_READ_TIMEOUT_MS })

  it("stamps RPC_READ_TIMEOUT on the resolved error", async () => {
    process.env.API_DB_READ_TIMEOUT_MS = "20"
    const { error, data, count } = await boundedRead(new Promise(() => {}), "api/x/never-settles")
    expect(error?.code).toBe(RPC_READ_TIMEOUT_CODE)
    expect(String(error?.message)).toContain("read exceeded")
    // The rest of the envelope is unchanged — null, never a fabricated 0/[].
    expect(data).toBeNull()
    expect(count).toBeNull()
  })

  it("END TO END: a hanging read becomes a RETRYABLE 503, not a hard 500", async () => {
    // The assertion that would have caught this. It spans both modules, which is
    // exactly where the defect lived.
    process.env.API_DB_READ_TIMEOUT_MS = "20"
    const { error } = await boundedRead(new Promise(() => {}), "api/x/never-settles")
    const safe = safeApiError(error)
    expect(safe.code).toBe("timeout")
    expect(safe.retryable).toBe(true)
    expect(statusForSafeError(safe)).toBe(503)
  })

  it("a read that SUCCEEDS carries no timeout code", async () => {
    // The control: without it, a helper that stamped the code unconditionally
    // would pass the two cases above and mark every success as a timeout.
    const { error, data } = await boundedRead(Promise.resolve({ data: [1], error: null }), "api/x/ok")
    expect(error).toBeNull()
    expect(data).toEqual([1])
  })
})
