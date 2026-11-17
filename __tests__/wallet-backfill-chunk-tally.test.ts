import { describe, it, expect, beforeEach, vi } from "vitest"

// The chunk-failure tally is what turns a SILENT wmc-upsert data loss into a
// visible one: a failing chunk doesn't abort the run (partial progress is
// banked), but it's recorded so the caller can set ok:false + a pipeline_runs
// error instead of reporting a clean success while rows were dropped.
//
// From 2026-08-28 it ALSO records what retrying recovered. Measured over the
// 7 days to that date, the wallet-backfill family lost 207,287 rows across
// 1,010 failed chunks and **100% of them carried one of exactly two transient
// messages** — so the chunk writer now retries, and these tests pin that
// against those two real strings rather than a synthetic "boom".

const H = vi.hoisted(() => {
  const state: any = {
    // Queue of results the mocked upsert_wmc_batch returns, in order. The last
    // entry repeats once the queue drains.
    upsertResults: [] as any[],
    rpcCalls: [] as Array<{ name: string; params: any }>,
  }
  return {
    state,
    client: {
      rpc: async (name: string, params: any) => {
        state.rpcCalls.push({ name, params })
        const q = state.upsertResults
        return q.length > 1 ? q.shift() : q[0]
      },
    },
  }
})

vi.mock("@/lib/supabase", () => ({ supabase: H.client, supabaseAdmin: H.client }))

import {
  newChunkTally,
  chunkFailureError,
  chunkFailureExtra,
  upsertWmcChunkWithRetry,
  CHUNK_RETRY_RUN_BUDGET_MS,
  CHUNK_RPC_TIMEOUT_MS,
  type ChunkFailureTally,
} from "@/lib/chains/flow/wmc-chunk-upsert"

// The two error messages that account for 100% of measured wmc chunk loss.
// Spelled EXACTLY as production reports them — a paraphrase would pass these
// tests while the real strings still fell through isTransient.
const POOL_TIMEOUT = "Timed out acquiring connection from connection pool."
const LOCK_TIMEOUT = "canceling statement due to lock timeout"
// The one timeout that must NEVER be retried: retrying a statement Postgres
// already killed just burns the budget to fail identically.
const STATEMENT_TIMEOUT = "canceling statement due to statement timeout"

const ok = (written: number) => ({ data: { written }, error: null })
const err = (message: string, code?: string) => ({
  data: null,
  error: { message, code: code ?? "", details: "", hint: "" },
})

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ moment_id: String(i) }))

beforeEach(() => {
  H.state.upsertResults = [ok(0)]
  H.state.rpcCalls = []
})

describe("newChunkTally", () => {
  it("starts empty, with a full retry budget", () => {
    expect(newChunkTally()).toEqual({
      chunkErrors: 0,
      chunkRowsLost: 0,
      firstChunkError: null,
      chunkRetryRecoveries: 0,
      chunkRowsRecovered: 0,
      retryBudgetMsLeft: CHUNK_RETRY_RUN_BUDGET_MS,
    })
  })
})

describe("chunkFailureError", () => {
  const t = (over: Partial<ChunkFailureTally> = {}): ChunkFailureTally => ({
    ...newChunkTally(),
    ...over,
  })

  it("returns null when no chunk failed (the healthy path — must NOT redden a clean run)", () => {
    expect(chunkFailureError(newChunkTally())).toBeNull()
  })

  it("summarizes count + rows lost when chunks failed", () => {
    expect(
      chunkFailureError(t({ chunkErrors: 2, chunkRowsLost: 350, firstChunkError: "23505 dup" })),
    ).toBe("wmc_upsert_chunk_failures=2 rows_lost=350 first=23505 dup")
  })

  it("omits the first= clause when there's no message", () => {
    expect(chunkFailureError(t({ chunkErrors: 1, chunkRowsLost: 200 }))).toBe(
      "wmc_upsert_chunk_failures=1 rows_lost=200",
    )
  })

  it("truncates a long first error to 200 chars", () => {
    const long = "x".repeat(500)
    const out = chunkFailureError(t({ chunkErrors: 1, chunkRowsLost: 1, firstChunkError: long }))!
    expect(out).toContain("first=" + "x".repeat(200))
    expect(out).not.toContain("x".repeat(201))
  })

  it("stays null when every failed chunk was RECOVERED by a retry", () => {
    // The property that makes the retry worth shipping: a run whose chunks all
    // came back on a second attempt lost nothing, so it must report ok.
    expect(chunkFailureError(t({ chunkRetryRecoveries: 3, chunkRowsRecovered: 600 }))).toBeNull()
  })
})

describe("chunkFailureExtra", () => {
  it("spreads the tally fields for logRun extra", () => {
    expect(
      chunkFailureExtra({ ...newChunkTally(), chunkErrors: 3, chunkRowsLost: 12, firstChunkError: "boom" }),
    ).toEqual({
      chunk_errors: 3,
      chunk_rows_lost: 12,
      first_chunk_error: "boom",
      chunk_retry_recoveries: 0,
      chunk_rows_recovered: 0,
    })
  })

  it("EMITS the recovery keys on a clean run rather than omitting them", () => {
    // Absent-vs-zero is the distinction that made 8 of 10 saturation breakers
    // unreadable (they logged `extra: {}`): an observer querying
    // `extra->>'chunk_rows_recovered'` must get 0, not NULL, or the incidence
    // of recovery is unmeasurable. Assert KEY PRESENCE, not just the value.
    const out = chunkFailureExtra(newChunkTally())
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(["chunk_retry_recoveries", "chunk_rows_recovered"]),
    )
    expect(out.chunk_retry_recoveries).toBe(0)
    expect(out.chunk_rows_recovered).toBe(0)
  })
})

describe("upsertWmcChunkWithRetry", () => {
  it("writes in one attempt when the pool is healthy", async () => {
    H.state.upsertResults = [ok(150)]
    const tally = newChunkTally()
    const written = await upsertWmcChunkWithRetry(rows(150), "test", tally, "c0")

    expect(written).toBe(150)
    expect(H.state.rpcCalls).toHaveLength(1)
    expect(tally.chunkErrors).toBe(0)
    expect(tally.chunkRetryRecoveries).toBe(0)
    // A run that never retried must not be charged any budget.
    expect(tally.retryBudgetMsLeft).toBe(CHUNK_RETRY_RUN_BUDGET_MS)
  })

  // ── the known offenders ──────────────────────────────────────────────────
  for (const [label, message] of [
    ["pool-acquire timeout (978 chunks / 188,521 rows in 7d)", POOL_TIMEOUT],
    ["lock timeout (32 chunks / 18,766 rows in 7d)", LOCK_TIMEOUT],
  ] as const) {
    it(`RECOVERS a chunk lost to ${label}`, async () => {
      H.state.upsertResults = [err(message), ok(200)]
      const tally = newChunkTally()
      const written = await upsertWmcChunkWithRetry(rows(200), "test", tally, "c0")

      expect(H.state.rpcCalls).toHaveLength(2)
      expect(written).toBe(200)
      // The rows were saved, so nothing is lost and the run is NOT reddened.
      expect(tally.chunkErrors).toBe(0)
      expect(tally.chunkRowsLost).toBe(0)
      expect(chunkFailureError(tally)).toBeNull()
      // ...and the recovery is COUNTED, so the fix is measurable in prod.
      expect(tally.chunkRetryRecoveries).toBe(1)
      expect(tally.chunkRowsRecovered).toBe(200)
      // A retry charges the run budget.
      expect(tally.retryBudgetMsLeft).toBeLessThan(CHUNK_RETRY_RUN_BUDGET_MS)
    })
  }

  it("still reports loss when every attempt fails", async () => {
    H.state.upsertResults = [err(POOL_TIMEOUT)]
    const tally = newChunkTally()
    const written = await upsertWmcChunkWithRetry(rows(200), "test", tally, "c0")

    expect(written).toBe(0)
    expect(H.state.rpcCalls).toHaveLength(3) // exhausted the 3 attempts
    expect(tally.chunkErrors).toBe(1)
    expect(tally.chunkRowsLost).toBe(200)
    expect(tally.chunkRetryRecoveries).toBe(0)
    expect(chunkFailureError(tally)).toContain("wmc_upsert_chunk_failures=1 rows_lost=200")
  })

  // ── controls: the retry must NOT fire for these ──────────────────────────
  it("does NOT retry a statement timeout", async () => {
    H.state.upsertResults = [err(STATEMENT_TIMEOUT, "57014")]
    const tally = newChunkTally()
    await upsertWmcChunkWithRetry(rows(200), "test", tally, "c0")

    expect(H.state.rpcCalls).toHaveLength(1)
    expect(tally.chunkErrors).toBe(1)
    expect(tally.retryBudgetMsLeft).toBe(CHUNK_RETRY_RUN_BUDGET_MS)
  })

  it("does NOT retry a logic-class (42xxx) error", async () => {
    H.state.upsertResults = [err('relation "wallet_moments_cache" does not exist', "42P01")]
    const tally = newChunkTally()
    await upsertWmcChunkWithRetry(rows(10), "test", tally, "c0")

    expect(H.state.rpcCalls).toHaveLength(1)
    expect(tally.chunkErrors).toBe(1)
    expect(tally.chunkRowsLost).toBe(10)
  })

  it("falls back to a SINGLE attempt once the run's retry budget is spent", async () => {
    // The ceiling that keeps a saturation spell from pushing the 60s golazos
    // route past maxDuration. Pre-2026-08-28 behaviour is the fallback.
    H.state.upsertResults = [err(POOL_TIMEOUT)]
    const tally = { ...newChunkTally(), retryBudgetMsLeft: 0 }
    await upsertWmcChunkWithRetry(rows(200), "test", tally, "c0")

    expect(H.state.rpcCalls).toHaveLength(1)
    expect(tally.chunkErrors).toBe(1)
    expect(tally.chunkRowsLost).toBe(200)
  })

  it("makes no call at all for an empty chunk", async () => {
    const tally = newChunkTally()
    expect(await upsertWmcChunkWithRetry([], "test", tally, "c0")).toBe(0)
    expect(H.state.rpcCalls).toHaveLength(0)
    expect(tally.chunkErrors).toBe(0)
  })

  it("passes the chunk through as p_rows to upsert_wmc_batch", async () => {
    H.state.upsertResults = [ok(2)]
    const chunk = rows(2)
    await upsertWmcChunkWithRetry(chunk, "test", newChunkTally(), "c0")

    expect(H.state.rpcCalls[0].name).toBe("upsert_wmc_batch")
    expect(H.state.rpcCalls[0].params).toEqual({ p_rows: chunk })
  })
})

describe("CHUNK_RPC_TIMEOUT_MS — the client deadline must never out-rank the DATABASE's own limits", () => {
  // 🚨 REGRESSION PIN. The first version of this writer passed no timeoutMs and
  // inherited DEFAULT_RPC_TIMEOUT_MS = 45s, justified as "safely above
  // service_role's 30s statement_timeout". That checked the ROLE and never the
  // FUNCTION: upsert_wmc_batch declares `SET statement_timeout = 120s` in its
  // pg_proc.proconfig, and on the PostgREST path a higher function-level timeout
  // RAISES the limit. So the write was entitled to 120s and the client gave up
  // at 45s.
  //
  // Measured in the first wave after it shipped (12:47Z, 365 runs): EVERY chunk
  // error was that timeout — 30 runs, 9,153 rows lost — and not one was a
  // pool-acquire or lock timeout, the classes the retry exists for. The fix was
  // the sole cause of the loss it was written to prevent.
  //
  // The number below is not a tuning knob. It encodes an ORDERING: the client
  // deadline is a backstop for a stuck socket and must sit above every bound
  // that can legitimately end the call, so the database always answers first.
  const FUNCTION_DECLARED_STATEMENT_TIMEOUT_MS = 120_000 // pg_proc.proconfig, read live 2026-08-28
  const SUPABASE_GATEWAY_CAP_MS = 120_000 // 504 upstream request timeout, PostgREST path

  it("exceeds upsert_wmc_batch's own declared statement_timeout", () => {
    expect(CHUNK_RPC_TIMEOUT_MS).toBeGreaterThan(FUNCTION_DECLARED_STATEMENT_TIMEOUT_MS)
  })

  it("exceeds the Supabase gateway's hard cap, so the gateway answers before the client gives up", () => {
    expect(CHUNK_RPC_TIMEOUT_MS).toBeGreaterThan(SUPABASE_GATEWAY_CAP_MS)
  })

  it("is NOT the 45s page default — that value is what caused the regression", () => {
    // Pinned as an explicit inequality rather than a range: if someone later
    // removes the explicit timeoutMs, the call silently falls back to 45s and
    // this is the assertion that catches it.
    expect(CHUNK_RPC_TIMEOUT_MS).not.toBe(45_000)
    expect(CHUNK_RPC_TIMEOUT_MS).toBeGreaterThan(45_000)
  })

  it("stays a real bound rather than being effectively infinite", () => {
    // The point is a backstop, not "never give up" — an unbounded write is what
    // this module set out to fix. Ten minutes is far past any legitimate answer.
    expect(CHUNK_RPC_TIMEOUT_MS).toBeLessThan(600_000)
  })
})
