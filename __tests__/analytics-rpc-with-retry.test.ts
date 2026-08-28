import { describe, it, expect, vi } from "vitest"
import { rpcWithRetry, queryWithRetry, DEFAULT_RPC_TIMEOUT_MS } from "@/lib/analytics/rpc-with-retry"

// Unit tests for lib/analytics/rpc-with-retry.ts — the wrapper every
// /api/analytics/* route uses. It must retry connection-class (transient)
// errors with backoff but NEVER retry logic-class (42xxx) errors, and it must
// stop as soon as it succeeds or exhausts its attempt budget. Backoff is
// exercised with baseDelayMs:1 so the suite stays fast.

type Resp = { data?: unknown; error?: unknown }

// Build a fake Supabase client whose .rpc() returns the queued responses in
// order. Returns the client plus the spy so tests can assert call counts.
function fakeClient(responses: Resp[]) {
  const rpc = vi.fn()
  for (const r of responses) {
    rpc.mockResolvedValueOnce({ data: r.data ?? null, error: r.error ?? null })
  }
  return { client: { rpc } as any, rpc }
}

const ok = (data: unknown): Resp => ({ data, error: null })
const err = (code: string, message = ""): Resp => ({ error: { code, message } })
const msgErr = (message: string): Resp => ({ error: { message } })

describe("rpcWithRetry", () => {
  it("returns data on first success without retrying", async () => {
    const { client, rpc } = fakeClient([ok({ rows: 3 })])
    const res = await rpcWithRetry(client, "some_fn", { a: 1 }, { baseDelayMs: 1 })
    expect(res).toEqual({ data: { rows: 3 }, error: null })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("some_fn", { a: 1 })
  })

  it("coalesces undefined success data to null", async () => {
    const { client } = fakeClient([{ data: undefined, error: null }])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res).toEqual({ data: null, error: null })
  })

  it("retries a transient SQLSTATE then returns the eventual success", async () => {
    const { client, rpc } = fakeClient([err("53300", "too many connections"), ok({ v: 1 })])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toEqual({ v: 1 })
    expect(res.error).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("treats any 08xxx code as transient", async () => {
    const { client, rpc } = fakeClient([err("08004"), ok("recovered")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("recovered")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("treats network-y messages with no code as transient", async () => {
    const { client, rpc } = fakeClient([msgErr("fetch failed"), ok("ok")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("ok")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  // The pgbouncer/Supavisor pool-exhaustion message — "Timed out acquiring
  // connection from connection pool." — is the class behind the recurring
  // team/player/pack detail-page 500s. "timed out" (two words) is NOT caught by
  // the "timeout" substring, so these explicit phrases must be transient.
  it.each([
    "Timed out acquiring connection from connection pool.",
    "timed out acquiring connection",
    "connection pool exhausted",
  ])("treats pool-acquire message %j as transient", async (message) => {
    const { client, rpc } = fakeClient([msgErr(message), ok("recovered")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("recovered")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  // ── PostgREST schema-cache: two lookalike messages, opposite verdicts ─────
  //
  // Context (2026-08-13): PGRST002 was the single largest real user-facing error
  // on the platform — Sentry JAVASCRIPT-NEXTJS-1Z, 81 users / 84 events since
  // 2026-07-18, plus the edition and player detail pages (~97 events in 7 days).
  // Every one of those paths ALREADY ran through rpcWithRetry; none of the
  // heuristics matched the message, so a failure PostgREST itself labels
  // "Retrying." was never retried once.
  it.each([
    "Could not query the database for the schema cache. Retrying.",
    "could not query the database for the schema cache",
  ])("retries the PGRST002 introspection failure %j", async (message) => {
    const { client, rpc } = fakeClient([msgErr(message), ok("recovered")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("recovered")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  // ⚠ The lookalike that must NOT be retried. PGRST205 means the cache loaded
  // fine and the object genuinely is not there — a deploy or naming bug.
  // Retrying only burns the budget to fail identically, and a bare "schema
  // cache" substring match would have swallowed exactly this case.
  it.each([
    "Could not find the table 'public.nope' in the schema cache",
    "Could not find the function public.nope(x) in the schema cache",
  ])("never retries the PGRST205 missing-object error %j", async (message) => {
    const { client, rpc } = fakeClient([msgErr(message), ok("unreachable")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.error?.message).toBe(message)
    expect(res.data).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("never retries a logic-class (42xxx) error", async () => {
    const { client, rpc } = fakeClient([
      err("42883", "function does not exist"),
      ok("should-not-reach"),
    ])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "42883" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  // 57014 (query_canceled) carries the message "canceling statement due to
  // statement timeout", which CONTAINS the substring "timeout" the transient
  // message-heuristics match on — so before 2026-07-26 every statement timeout
  // was retried 3x. A statement that blew its timeout will blow it again; the
  // retry was pure load amplification on the DB, and it landed on the busiest
  // surface in the product (edition pages). It must perform exactly 1 attempt.
  it("never retries a statement timeout (57014) despite the 'timeout' message", async () => {
    const { client, rpc } = fakeClient([
      err("57014", "canceling statement due to statement timeout"),
      ok("should-not-reach"),
    ])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "57014" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  // Same statement-timeout error, but folded into a message-only shape with no
  // SQLSTATE (which the JS client sometimes does). Still must not retry.
  it("never retries a statement-timeout message that carries no SQLSTATE", async () => {
    const { client, rpc } = fakeClient([
      msgErr("canceling statement due to statement timeout"),
      ok("should-not-reach"),
    ])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  // Guard the fix's blast radius: the genuine pool-class codes that share the
  // 53xxx/57xxx neighbourhood must STILL retry.
  it.each(["53300", "57P01"])("still retries pool-class code %s", async (code) => {
    const { client, rpc } = fakeClient([err(code, "pool problem"), ok("recovered")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("recovered")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("does not retry an unknown non-transient error", async () => {
    const { client, rpc } = fakeClient([err("23505", "duplicate key"), ok("nope")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.error).toMatchObject({ code: "23505" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("stops after exhausting the attempt budget on a persistent transient error", async () => {
    const { client, rpc } = fakeClient([err("57P01"), err("57P01"), err("57P01")])
    const res = await rpcWithRetry(client, "f", {}, { attempts: 3, baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "57P01" })
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it("honors a custom attempts count and the minimum-1 clamp", async () => {
    const { client, rpc } = fakeClient([err("08006"), err("08006"), err("08006"), err("08006"), err("08006")])
    await rpcWithRetry(client, "f", {}, { attempts: 5, baseDelayMs: 1 })
    expect(rpc).toHaveBeenCalledTimes(5)

    const { client: c2, rpc: r2 } = fakeClient([err("08006")])
    await rpcWithRetry(c2, "f", {}, { attempts: 0, baseDelayMs: 1 })
    expect(r2).toHaveBeenCalledTimes(1) // clamped up to 1
  })
})

// ── The wall-clock bound (2026-08-13) ──────────────────────────────────────
// These cover the defect the retry loop above could never see: an RPC that
// never ANSWERS. Retrying handles a call that fails; nothing handled a call
// that just parks, and that is what left /[collection]/edition/[slug] sitting
// on "SCANNING THE MARKETPLACE…" until Vercel killed the function at 300s.
describe("rpcWithRetry — wall-clock bound", () => {
  // A client whose .rpc() never settles, i.e. a stuck connection acquire.
  // Deliberately shaped like the repo's own mocks: a bare thenable with NO
  // .abortSignal, which is why the implementation cannot rely on the signal.
  function hangingClient() {
    const rpc = vi.fn(() => new Promise(() => {}))
    return { client: { rpc } as any, rpc }
  }

  // Every other test here passes an explicit timeoutMs, so none of them would
  // notice the DEFAULT being removed or set to Infinity — which is the exact
  // state production was in. This pins the default itself, and the window it
  // has to sit in for the reasoning to hold.
  it("defaults to a bound above the DB's own ceiling and below Vercel's", () => {
    expect(Number.isFinite(DEFAULT_RPC_TIMEOUT_MS)).toBe(true)
    // Above service_role's statement_timeout=30s, or we would start cancelling
    // statements Postgres would have finished and answered.
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeGreaterThan(30_000)
    // Below the 300s function kill, or the bound never gets to fire and the
    // request dies as an unattributed "Task timed out" instead.
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeLessThan(300_000)
  })

  it("settles with a timeout error instead of hanging forever", async () => {
    const { client } = hangingClient()
    const res = await rpcWithRetry(client, "get_edition_detail", {}, { timeoutMs: 60, baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "RPC_TIMEOUT" })
    // The message must name the function — an unattributed timeout in a
    // 6-wide Promise.all tells an operator nothing about which leg stuck.
    expect(res.error?.message).toContain("get_edition_detail")
  })

  it("spends the budget in TOTAL, not per attempt", async () => {
    // The trap this pins: a per-attempt timeout silently multiplies by
    // `attempts`, so a "30s" bound would really be 90s.
    const { client } = hangingClient()
    const t0 = Date.now()
    await rpcWithRetry(client, "f", {}, { timeoutMs: 80, attempts: 3, baseDelayMs: 1 })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(240) // 3 x 80ms would be >= 240ms
  })

  it("does not cut off a slow query that answers inside the budget", async () => {
    // MUST consume real time. An immediately-resolving mock settles as a
    // microtask before the timer macrotask ever runs, so this assertion would
    // pass even with timeoutMs: 0 and prove nothing.
    const rpc = vi.fn(
      () => new Promise((r) => setTimeout(() => r({ data: { slow: true }, error: null }), 60)),
    )
    const res = await rpcWithRetry({ rpc } as any, "f", {}, { timeoutMs: 400, baseDelayMs: 1 })
    expect(res.error).toBeNull()
    expect(res.data).toEqual({ slow: true })
  })

  it("does not retry after a timeout — the hang consumed the whole budget", async () => {
    // Each attempt is handed the REMAINING budget, so an attempt that times
    // out has spent all of it and no retry can follow, even with attempts: 3.
    // Pinned because the tempting "fix" — slicing the budget per attempt so a
    // retry fits — would cap one statement below the 30s service_role allows
    // and start cancelling queries Postgres would have finished and answered.
    const rpc = vi.fn(() => new Promise(() => {}))
    const res = await rpcWithRetry({ rpc } as any, "f", {}, { timeoutMs: 80, attempts: 3, baseDelayMs: 1 })
    expect(res.error).toMatchObject({ code: "RPC_TIMEOUT" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("still retries a FAST transient error under the same budget", async () => {
    // The bound must not disable the retry behaviour this helper exists for:
    // an error that comes back quickly leaves budget, so attempt 2 runs.
    const { client, rpc } = fakeClient([err("53300", "too many connections"), ok({ v: 9 })])
    const res = await rpcWithRetry(client, "f", {}, { timeoutMs: 5_000, baseDelayMs: 1 })
    expect(res.data).toEqual({ v: 9 })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("cancels the real request via abortSignal when the builder supports it", async () => {
    // The race alone would settle our promise but leave the socket and its
    // pool slot held — the opposite of helpful while the pool is saturated.
    let seen: AbortSignal | undefined
    const builder: any = {
      abortSignal: (s: AbortSignal) => {
        seen = s
        return new Promise(() => {})
      },
    }
    const rpc = vi.fn(() => builder)
    await rpcWithRetry({ rpc } as any, "f", {}, { timeoutMs: 60, attempts: 1, baseDelayMs: 1 })
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen?.aborted).toBe(true)
  })
})

// queryWithRetry — the table-read sibling, added 2026-08-16 after fmv-recalc wrote
// ZERO rows for 12.4h across 17 consecutive runs, every one dying on a single
// unretried `.from("sales")` chunk fetch that left its cursor pinned at offset 0.
//
// The property that matters most here is the FACTORY. A PostgREST builder is a
// single-use thenable: it fires its request once, and awaiting the same object
// again yields the first attempt's settled result. A retry that closed over one
// builder would therefore "retry" without re-issuing anything — and would pass a
// naive test that only counted awaits.
describe("queryWithRetry", () => {
  const poolErr = { error: { message: "Timed out acquiring connection from connection pool." } }

  it("CALLS THE FACTORY AGAIN on retry — not just re-awaits one builder", async () => {
    const build = vi.fn()
    build.mockResolvedValueOnce({ data: null, ...poolErr })
    build.mockResolvedValueOnce({ data: [{ id: 1 }], error: null })

    const res = await queryWithRetry(build, "sales chunk", { baseDelayMs: 1 })

    // Two DISTINCT invocations of the builder factory, not two awaits of one.
    expect(build).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ data: [{ id: 1 }], error: null })
  })

  it("does not retry a non-transient error, so a real fault still fails fast", async () => {
    const build = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column does not exist" },
    })
    const res = await queryWithRetry(build, "sales chunk", { baseDelayMs: 1 })
    expect(build).toHaveBeenCalledTimes(1)
    expect((res.error as { code?: string })?.code).toBe("42703")
  })

  it("gives up after `attempts` and returns the last error rather than throwing", async () => {
    const build = vi.fn().mockResolvedValue({ data: null, ...poolErr })
    const res = await queryWithRetry(build, "sales chunk", { attempts: 3, baseDelayMs: 1 })
    expect(build).toHaveBeenCalledTimes(3)
    expect(String((res.error as { message?: string })?.message)).toMatch(/connection pool/i)
    expect(res.data).toBeNull()
  })

  it("succeeds on the first try without invoking the factory twice", async () => {
    const build = vi.fn().mockResolvedValue({ data: [{ id: 7 }], error: null })
    const res = await queryWithRetry(build, "sales chunk", { baseDelayMs: 1 })
    expect(build).toHaveBeenCalledTimes(1)
    expect(res.data).toEqual([{ id: 7 }])
  })

  // The shared budget is a TOTAL, not per-attempt: an exhausted budget must stop
  // the loop rather than let `attempts` multiply it.
  it("stops when the total budget is exhausted even with attempts remaining", async () => {
    const build = vi.fn(
      () => new Promise((r) => setTimeout(() => r({ data: null, ...poolErr }), 30))
    )
    const res = await queryWithRetry(build, "sales chunk", {
      attempts: 5,
      baseDelayMs: 1,
      timeoutMs: 45,
    })
    expect(build.mock.calls.length).toBeLessThan(5)
    expect(res.error).not.toBeNull()
  })
})

describe("rpcWithRetry — minAttemptSliceMs (the budget-crumb floor)", () => {
  // A .rpc() that fails with a REAL transient error after `ms` of wall clock.
  // Must consume real time: the whole defect is about how much of a shared
  // budget an earlier attempt eats, which an instantly-settling mock cannot
  // express.
  function slowFailClient(ms: number, message: string) {
    const rpc = vi.fn(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ data: null, error: { code: "53300", message } }), ms),
        ),
    )
    return { client: { rpc } as any, rpc }
  }

  it("is INERT by default — a caller that does not opt in is unchanged", async () => {
    // The guard ships in a hot path shared by every entity page and board
    // render. This is the assertion that says they did not silently inherit it:
    // with no minAttemptSliceMs, all three attempts are still issued even
    // though the last one is handed a crumb.
    const { client, rpc } = slowFailClient(40, "too many connections")
    await rpcWithRetry(client, "f", {}, { attempts: 3, timeoutMs: 100, baseDelayMs: 1 })
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it("does not issue an attempt handed less than the floor", async () => {
    // Two 40ms failures eat 80 of the 100ms budget, leaving ~20ms — under the
    // 50ms floor, so attempt 3 must never be issued.
    const { client, rpc } = slowFailClient(40, "too many connections")
    await rpcWithRetry(client, "f", {}, {
      attempts: 3, timeoutMs: 100, baseDelayMs: 1, minAttemptSliceMs: 50,
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("PRESERVES THE REAL ERROR instead of overwriting it with our own bound", async () => {
    // The point of the whole change. Without the floor the doomed crumb
    // attempt times out and `RPC_TIMEOUT` — a bound WE imposed — replaces the
    // database's actual complaint in first_chunk_error. Asserting the ABSENCE
    // of the false claim, not merely the presence of some error.
    const { client } = slowFailClient(40, "Timed out acquiring connection from connection pool.")
    const res = await rpcWithRetry(client, "upsert_wmc_batch", {}, {
      attempts: 3, timeoutMs: 100, baseDelayMs: 1, minAttemptSliceMs: 50,
    })
    expect(res.error?.message).toContain("acquiring connection")
    expect(res.error?.code).not.toBe("RPC_TIMEOUT")
    expect(res.error?.message).not.toContain("timed out after")
  })

  it("never blocks the FIRST attempt, even with a floor above the whole budget", async () => {
    // A floor larger than timeoutMs must not turn the call into a no-op that
    // reports failure without ever asking the database.
    const { client, rpc } = fakeClient([ok({ v: 1 })])
    const res = await rpcWithRetry(client, "f", {}, {
      attempts: 3, timeoutMs: 100, baseDelayMs: 1, minAttemptSliceMs: 10_000,
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(res.data).toEqual({ v: 1 })
  })

  it("still retries when the failure is FAST and leaves a usable slice", async () => {
    // The floor must not disable the recovery this retry exists for: a
    // pool-acquire that fails in milliseconds leaves nearly the whole budget.
    const { client, rpc } = fakeClient([err("53300", "too many connections"), ok({ v: 9 })])
    const res = await rpcWithRetry(client, "f", {}, {
      attempts: 3, timeoutMs: 5_000, baseDelayMs: 1, minAttemptSliceMs: 1_000,
    })
    expect(res.data).toEqual({ v: 9 })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
