import { describe, it, expect } from "vitest"
import { verdict } from "../scripts/git-unstick-index-lock.mjs"

// The decision rule for clearing a .git/index.lock, pinned as a pure function.
//
// ⛔ WHY THE REFUSALS MATTER MORE THAN THE SUCCESS. This script DELETES a file
// git uses to serialise writes. Getting "stale" wrong on a lock a parallel
// session is really holding corrupts that session's index. So every arm below is
// a REFUSAL except one, and the one success requires all three signals to agree.
//
// ⭐ The rule is not age-based, deliberately: the 2026-09-05 recurrence was a
// 0-byte lock only 76 SECONDS old, so "a real in-flight lock is seconds old"
// argues to leave it — wrongly. Age is a hint; these three are the verdict.

const FROZEN = 1_700_000_000_000

describe("git-unstick verdict", () => {
  it("declares STALE only when all three signals agree", () => {
    const v = verdict({ bytes: 0, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(true)
    expect(v.reasons).toEqual([])
  })

  it("REFUSES when the lock has content — a live git wrote to it", () => {
    const v = verdict({ bytes: 42, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("42 bytes")
  })

  it("REFUSES when a git process is running — there IS a holder", () => {
    const v = verdict({ bytes: 0, procs: 1, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("git process")
  })

  // 🚨 THE FAIL-CLOSED ARM. If the process probe itself breaks, "no processes
  // found" and "could not look" are the same value unless this is explicit —
  // and treating a broken probe as an all-clear is exactly the shape that turns
  // a diagnostic into a data-loss tool.
  it("REFUSES when the process probe FAILED — a broken probe is not an all-clear", () => {
    const v = verdict({ bytes: 0, procs: null, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("refusing to guess")
  })

  it("REFUSES when the mtime advanced — something is progressing", () => {
    const v = verdict({ bytes: 0, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN + 1000 })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("mtime advanced")
  })

  it("names EVERY disagreeing signal, not just the first", () => {
    const v = verdict({ bytes: 9, procs: 2, mtimeA: FROZEN, mtimeB: FROZEN + 1 })
    expect(v.stale).toBe(false)
    expect(v.reasons.length).toBe(3)
  })
})
