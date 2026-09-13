import { describe, it, expect } from "vitest"
import {
  queryDeadline,
  createWallBudgetFetch,
  WALL_BUDGET_EXHAUSTED,
  type WallBudgetClock,
} from "@/lib/sentinel/wall-budget"
import { isSaturationError } from "@/lib/pipeline/saturation"
import { isBlind } from "@/lib/sentinel/blind-checks"

// The state the sentinel was in at 16:48Z on 2026-09-13: three saturated arms
// each waiting out a statement budget, 180 s wall, NO terminal row, NO Telegram,
// a 504 to the GHA runner. lib/sentinel/wall-budget.ts carries the argument;
// these pin the contract.

const opts = { wallMs: 180_000, reserveMs: 40_000, perQueryCapMs: 45_000 }
const T0 = 1_000_000
const checks = (): WallBudgetClock => ({ startedAtMs: T0, phase: "checks" })
const at = (elapsedMs: number) => T0 + elapsedMs

describe("queryDeadline — the arithmetic, without a fetch", () => {
  it("with no sweep in flight, bounds at the per-query cap and never refuses", () => {
    expect(queryDeadline(opts, null, at(0))).toEqual({ kind: "bound", timeoutMs: 45_000 })
    expect(queryDeadline(opts, null, at(10_000_000))).toEqual({ kind: "bound", timeoutMs: 45_000 })
  })

  it("early in the sweep, a request gets the cap, not the whole remaining budget", () => {
    const d = queryDeadline(opts, checks(), at(0))
    expect(d).toEqual({ kind: "bound", timeoutMs: 45_000 })
  })

  it("late in the sweep, a request gets only what the budget has left", () => {
    // budget = 140 s; at 120 s elapsed, 20 s remain — less than the 45 s cap.
    const d = queryDeadline(opts, checks(), at(120_000))
    expect(d).toEqual({ kind: "bound", timeoutMs: 20_000 })
  })

  it("⭐ once the budget is spent, the request is REFUSED with a message naming the arithmetic", () => {
    const d = queryDeadline(opts, checks(), at(140_000))
    expect(d.kind).toBe("refuse")
    if (d.kind !== "refuse") throw new Error("unreachable")
    expect(d.message).toContain(WALL_BUDGET_EXHAUSTED)
    expect(d.message).toMatch(/140\.0s elapsed of a 140\.0s query budget/)
    expect(d.message).toMatch(/180\.0s wall/)
    expect(d.message).toMatch(/did not evaluate/)
  })

  it("the budget survives three consecutive worst-case arms (3 × cap < wall − reserve)", () => {
    // This is the derivation the module header states. If someone raises the
    // cap or the reserve so that it no longer holds, the third saturated arm
    // pushes the sweep to the wall again, which is the defect this exists for.
    expect(3 * opts.perQueryCapMs).toBeLessThan(opts.wallMs - opts.reserveMs)
  })

  it("⛔ the terminal phase is NEVER refused — it gets what the wall has left, floored", () => {
    const term = (elapsed: number) =>
      queryDeadline(opts, { startedAtMs: T0, phase: "terminal" }, at(elapsed))
    // 140 s elapsed: 180 − 140 − 3 = 37 s left for the terminal row.
    expect(term(140_000)).toEqual({ kind: "bound", timeoutMs: 37_000 })
    // Past the budget, past the reserve, even past the wall: still a bound.
    expect(term(178_000)).toEqual({ kind: "bound", timeoutMs: 5_000 })
    expect(term(500_000)).toEqual({ kind: "bound", timeoutMs: 5_000 })
  })

  it("a clock in the past cannot produce a negative bound", () => {
    // nowMs earlier than startedAtMs (clock skew) reads as 0 elapsed.
    expect(queryDeadline(opts, checks(), T0 - 5_000)).toEqual({ kind: "bound", timeoutMs: 45_000 })
  })
})

describe("the refusal is classified as INCONCLUSIVE by both readers of it", () => {
  const d = queryDeadline(opts, checks(), at(150_000))
  const message = d.kind === "refuse" ? d.message : ""

  it("isSaturationError — so the arm's catch branch prefixes the INCONCLUSIVE marker", () => {
    expect(isSaturationError(message)).toBe(true)
  })

  it("isBlind — so the Measurement Blackout arm counts it even from an arm that builds its detail by hand", () => {
    // Two arms (FMV Confidence, Edition Coverage) never prefix the marker; the
    // blackout arm keys on the CONDITION for exactly that reason.
    expect(isBlind(`Coverage RPC error: ${message}`)).toBe(true)
  })
})

describe("createWallBudgetFetch — the wrapper", () => {
  function harness(clock: WallBudgetClock | null, nowMs: number) {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = []
    const baseFetch = (async (input: any, init?: RequestInit) => {
      calls.push({ input, init })
      return new Response("ok")
    }) as typeof fetch
    const f = createWallBudgetFetch({ ...opts, clock: () => clock, baseFetch, now: () => nowMs })
    return { f, calls }
  }

  it("passes a bounded request through with an AbortSignal attached", async () => {
    const { f, calls } = harness(checks(), at(0))
    const res = await f("https://db/rest/v1/rpc/x", { method: "POST" })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0].init?.signal?.aborted).toBe(false)
  })

  it("⭐ REFUSES before the request leaves the process once the budget is spent", async () => {
    const { f, calls } = harness(checks(), at(141_000))
    await expect(f("https://db/rest/v1/rpc/x")).rejects.toThrow(WALL_BUDGET_EXHAUSTED)
    expect(calls).toHaveLength(0)
  })

  it("reads the clock on EVERY request, so flipping the phase changes the next call's fate", async () => {
    const clock: WallBudgetClock = { startedAtMs: T0, phase: "checks" }
    const calls: unknown[] = []
    const baseFetch = (async () => {
      calls.push(1)
      return new Response("ok")
    }) as typeof fetch
    const f = createWallBudgetFetch({ ...opts, clock: () => clock, baseFetch, now: () => at(150_000) })
    await expect(f("https://db/x")).rejects.toThrow(WALL_BUDGET_EXHAUSTED)
    clock.phase = "terminal"
    await f("https://db/x")
    expect(calls).toHaveLength(1)
  })

  it("honours a caller-supplied signal as well as its own", async () => {
    const { f, calls } = harness(checks(), at(0))
    const theirs = new AbortController()
    await f("https://db/x", { signal: theirs.signal })
    const sig = calls[0].init?.signal as AbortSignal
    expect(sig.aborted).toBe(false)
    theirs.abort()
    expect(sig.aborted).toBe(true)
  })

  it("the bound actually fires: a base fetch that ignores its signal is not what is being tested, so use one that honours it", async () => {
    const tiny = { ...opts, perQueryCapMs: 1 } // floors to MIN_QUERY_MS = 1 s inside queryDeadline
    const baseFetch = ((input: any, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
    const f = createWallBudgetFetch({ ...tiny, clock: () => null, baseFetch })
    const started = Date.now()
    await expect(f("https://db/x")).rejects.toMatchObject({ name: "TimeoutError" })
    // ~1 s, never the 45 s cap and never unbounded.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)
})
