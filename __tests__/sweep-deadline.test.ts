import { describe, it, expect, vi, afterEach } from "vitest"
import { remainingBudgetMs, sweepDeadlineSignal } from "../lib/http/sweep-deadline"

// Contract tests for the shared per-request bound used by sweeps that run
// inside `after()` routes (lib/http/sweep-deadline.ts).
//
// The property that makes this helper SAFE to apply to an unmeasured upstream —
// and the reason it could be applied to all three `*-dune` routes without any
// fetch timings to size a cap from — is:
//
//   it can only ever abort a request that has ALREADY outlived the sweep
//   budget its caller declares, i.e. one the loop would have stopped on at its
//   next check anyway.
//
// So the tests below assert that property directly, not merely that a number
// comes back. A test that only checked "returns a positive number" would pass
// against an implementation that returned a constant, which is exactly the
// vacuous shape CLAUDE.md warns reads as coverage everywhere.

afterEach(() => vi.useRealTimers())

describe("remainingBudgetMs — the bound is DERIVED from the caller's own budget", () => {
  it("returns the budget still left, less the reserve", () => {
    vi.useFakeTimers()
    const started = Date.now()
    vi.advanceTimersByTime(200_000)
    // 720s budget, 200s elapsed, 30s held back for the terminal log.
    expect(remainingBudgetMs(started, 720_000, { reserveMs: 30_000 })).toBe(490_000)
  })

  it("shrinks as the sweep proceeds — it is not a constant", () => {
    vi.useFakeTimers()
    const started = Date.now()
    const early = remainingBudgetMs(started, 720_000)
    vi.advanceTimersByTime(300_000)
    const late = remainingBudgetMs(started, 720_000)
    // The discriminating assertion: a fixed cap would make these equal.
    expect(late).toBeLessThan(early)
    expect(early - late).toBe(300_000)
  })

  it("never returns a non-positive timeout, even past the budget", () => {
    vi.useFakeTimers()
    const started = Date.now()
    vi.advanceTimersByTime(900_000) // 180s beyond a 720s budget
    // AbortSignal.timeout(0) or a negative value would abort instantly or throw.
    expect(remainingBudgetMs(started, 720_000, { reserveMs: 30_000 })).toBeGreaterThan(0)
  })

  it("lets an upstream-specific ceiling win when it is tighter", () => {
    vi.useFakeTimers()
    const started = Date.now()
    // 720s of budget left, but this upstream is known to answer in seconds.
    expect(remainingBudgetMs(started, 720_000, { maxMs: 15_000 })).toBe(15_000)
  })

  it("keeps the budget when the budget is the tighter of the two", () => {
    vi.useFakeTimers()
    const started = Date.now()
    vi.advanceTimersByTime(710_000)
    // 10s of budget left against a 15s upstream cap — the budget must win, or
    // the request could outlive the sweep and the terminal log is never reached.
    expect(remainingBudgetMs(started, 720_000, { maxMs: 15_000 })).toBe(10_000)
  })
})

describe("sweepDeadlineSignal — the safety property, stated as a test", () => {
  it("cannot abort a request that is still inside the sweep budget", () => {
    vi.useFakeTimers()
    const started = Date.now()
    const BUDGET = 720_000
    const RESERVE = 30_000
    // Sample across the whole sweep: at every point, the bound handed to a
    // request must not expire before the budget itself does. If it could, the
    // helper would be capable of failing a call the sweep would have allowed —
    // the "a short cap converts working behaviour into failure" risk.
    for (let elapsed = 0; elapsed < BUDGET - RESERVE; elapsed += 30_000) {
      const bound = remainingBudgetMs(started, BUDGET, { reserveMs: RESERVE })
      expect(elapsed + bound).toBeLessThanOrEqual(BUDGET - RESERVE)
      vi.advanceTimersByTime(30_000)
    }
  })

  it("returns a real AbortSignal that is not already aborted", () => {
    const sig = sweepDeadlineSignal(Date.now(), 720_000, { reserveMs: 30_000 })
    expect(sig).toBeInstanceOf(AbortSignal)
    expect(sig.aborted).toBe(false)
  })

  it("clamps to a 1s floor rather than aborting instantly", () => {
    // A past-budget request must not get timeout(0) — that aborts before the
    // request is even issued, turning "over budget" into "never attempted".
    expect(remainingBudgetMs(Date.now() - 10_000, 1_000)).toBe(1_000)
  })

  it("aborts once the derived bound elapses", async () => {
    // Positive control for the whole helper: without this, every assertion
    // above would be about arithmetic and none about actually aborting.
    // The bound here is the 1s floor, so the wait must clear it.
    const sig = sweepDeadlineSignal(Date.now() - 10_000, 1_000)
    expect(sig.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 1_200))
    expect(sig.aborted).toBe(true)
  }, 5_000)
})
