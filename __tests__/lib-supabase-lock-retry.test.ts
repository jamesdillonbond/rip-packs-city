import { describe, it, expect } from "vitest"
import { isLockContention, newLockRetryBudget, withLockRetry, type WriteResult } from "@/lib/supabase/lock-retry"

const LOCK = { message: "canceling statement due to lock timeout", code: "55P03" }
const noSleep = async () => {}

function seq(results: WriteResult<number>[]) {
  let i = 0
  const calls = { n: 0 }
  const op = async () => {
    calls.n++
    return results[Math.min(i++, results.length - 1)]
  }
  return { op, calls }
}

describe("isLockContention", () => {
  it("matches 55P03, 40P01 and their messages only", () => {
    expect(isLockContention(LOCK)).toBe(true)
    expect(isLockContention({ code: "40P01" })).toBe(true)
    expect(isLockContention({ message: "deadlock detected" })).toBe(true)
    expect(isLockContention({ message: "canceling statement due to lock timeout" })).toBe(true)
    // A statement timeout is NOT lock contention and must never be retried.
    expect(isLockContention({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false)
    expect(isLockContention({ message: "duplicate key" })).toBe(false)
    expect(isLockContention(null)).toBe(false)
  })
})

describe("withLockRetry", () => {
  it("recovers a write that lost a lock race, and counts the recovery", async () => {
    const { op, calls } = seq([{ data: null, error: LOCK }, { data: 5, error: null }])
    const b = newLockRetryBudget()
    const res = await withLockRetry(op, b, { sleep: noSleep })
    expect(res).toEqual({ data: 5, error: null })
    expect(calls.n).toBe(2)
    expect(b.retries).toBe(1)
    expect(b.recovered).toBe(1)
  })

  it("does not retry a non-lock error", async () => {
    const { op, calls } = seq([{ data: null, error: { code: "57014", message: "statement timeout" } }])
    const b = newLockRetryBudget()
    const res = await withLockRetry(op, b, { sleep: noSleep })
    expect(res.error?.code).toBe("57014")
    expect(calls.n).toBe(1)
    expect(b.retries).toBe(0)
  })

  it("returns the last error when the lock never clears, and does not count it as recovered", async () => {
    const { op, calls } = seq([{ data: null, error: LOCK }])
    const b = newLockRetryBudget()
    const res = await withLockRetry(op, b, { delays: [1, 2, 3], sleep: noSleep })
    expect(res.error).toEqual(LOCK)
    expect(calls.n).toBe(4)
    expect(b.recovered).toBe(0)
  })

  it("stops retrying once the run budget is spent", async () => {
    const { op, calls } = seq([{ data: null, error: LOCK }])
    const b = newLockRetryBudget(20)
    await withLockRetry(op, b, { delays: [15, 15, 15], sleep: noSleep })
    expect(calls.n).toBe(2) // one retry fits (15 ≤ 20), the next does not (15 > 5)
    expect(b.msLeft).toBe(5)
  })

  it("does not touch the budget on a clean first attempt", async () => {
    const { op, calls } = seq([{ data: 1, error: null }])
    const b = newLockRetryBudget(100)
    await withLockRetry(op, b, { sleep: noSleep })
    expect(calls.n).toBe(1)
    expect(b).toEqual({ msLeft: 100, recovered: 0, retries: 0 })
  })
})
