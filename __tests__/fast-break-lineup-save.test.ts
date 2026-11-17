import { describe, it, expect } from "vitest"
import {
  computeLineupDiff,
  classifyPlayer,
  projectTimesUsedAfter,
} from "@/lib/fast-break-lineup-save"

const A = "00000000-0000-0000-0000-00000000000a"
const B = "00000000-0000-0000-0000-00000000000b"
const C = "00000000-0000-0000-0000-00000000000c"
const D = "00000000-0000-0000-0000-00000000000d"

describe("computeLineupDiff", () => {
  it("first save: existing is null → every player is 'added' and isFirstSave is true", () => {
    const d = computeLineupDiff(null, [A, B, C])
    expect(d.isFirstSave).toBe(true)
    expect(d.idempotent).toBe(false)
    expect(d.added.sort()).toEqual([A, B, C].sort())
    expect(d.removed).toEqual([])
    expect(d.unchanged).toEqual([])
  })

  it("idempotent re-save: same set, identical order → idempotent and no delta", () => {
    const d = computeLineupDiff([A, B, C], [A, B, C])
    expect(d.isFirstSave).toBe(false)
    expect(d.idempotent).toBe(true)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.unchanged.sort()).toEqual([A, B, C].sort())
  })

  it("idempotent re-save: same set, reordered → still idempotent (order-independent)", () => {
    const d = computeLineupDiff([A, B, C], [C, A, B])
    expect(d.idempotent).toBe(true)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.unchanged.sort()).toEqual([A, B, C].sort())
  })

  it("swap: one player out, one in → added/removed populated, unchanged keeps the rest", () => {
    const d = computeLineupDiff([A, B, C], [A, B, D])
    expect(d.idempotent).toBe(false)
    expect(d.isFirstSave).toBe(false)
    expect(d.added).toEqual([D])
    expect(d.removed).toEqual([C])
    expect(d.unchanged.sort()).toEqual([A, B].sort())
  })

  it("swap: full lineup change → all old removed, all new added, none unchanged", () => {
    const d = computeLineupDiff([A, B], [C, D])
    expect(d.idempotent).toBe(false)
    expect(d.added.sort()).toEqual([C, D].sort())
    expect(d.removed.sort()).toEqual([A, B].sort())
    expect(d.unchanged).toEqual([])
  })

  it("idempotent flag is false when prior row existed but had zero players (recovery from corrupt state)", () => {
    const d = computeLineupDiff([], [A, B, C])
    expect(d.isFirstSave).toBe(false)
    expect(d.idempotent).toBe(false)
    expect(d.added.sort()).toEqual([A, B, C].sort())
    expect(d.removed).toEqual([])
  })
})

describe("classifyPlayer", () => {
  it("returns 'added', 'removed', 'unchanged', or 'absent' as appropriate", () => {
    const d = computeLineupDiff([A, B, C], [A, B, D])
    expect(classifyPlayer(A, d)).toBe("unchanged")
    expect(classifyPlayer(B, d)).toBe("unchanged")
    expect(classifyPlayer(C, d)).toBe("removed")
    expect(classifyPlayer(D, d)).toBe("added")
    expect(classifyPlayer("ffffffff-ffff-ffff-ffff-ffffffffffff", d)).toBe("absent")
  })
})

describe("projectTimesUsedAfter", () => {
  it("adds 1 for added", () => {
    expect(projectTimesUsedAfter(0, "added")).toBe(1)
    expect(projectTimesUsedAfter(2, "added")).toBe(3)
  })

  it("subtracts 1 for removed but never goes negative", () => {
    expect(projectTimesUsedAfter(2, "removed")).toBe(1)
    expect(projectTimesUsedAfter(1, "removed")).toBe(0)
    expect(projectTimesUsedAfter(0, "removed")).toBe(0)
  })

  it("leaves unchanged players untouched", () => {
    expect(projectTimesUsedAfter(3, "unchanged")).toBe(3)
  })
})

describe("repro of the original bug — lineup save sequence", () => {
  // Simulates the contract the Postgres save_fast_break_lineup function
  // honors: each save advances times_used by exactly the per-player verdict
  // from computeLineupDiff. Asserts the bug-fix invariants directly:
  //   - re-save same lineup A → counters do not grow
  //   - swap one player → removed decrements, added increments

  function applySave(
    state: Map<string, number>,
    existing: string[] | null,
    next: string[],
  ): Map<string, number> {
    const diff = computeLineupDiff(existing, next)
    const after = new Map(state)
    if (diff.idempotent) return after
    for (const id of diff.added) {
      after.set(id, projectTimesUsedAfter(state.get(id) ?? 0, "added"))
    }
    for (const id of diff.removed) {
      after.set(id, projectTimesUsedAfter(state.get(id) ?? 0, "removed"))
    }
    return after
  }

  it("Save A → Save A → Save A' (one swap)", () => {
    let counters = new Map<string, number>()

    // Save A — first save of [A, B, C]
    counters = applySave(counters, null, [A, B, C])
    expect(counters.get(A)).toBe(1)
    expect(counters.get(B)).toBe(1)
    expect(counters.get(C)).toBe(1)

    // Save A again (idempotent) — counters MUST NOT grow
    counters = applySave(counters, [A, B, C], [A, B, C])
    expect(counters.get(A)).toBe(1)
    expect(counters.get(B)).toBe(1)
    expect(counters.get(C)).toBe(1)

    // Save A' — swap C for D
    counters = applySave(counters, [A, B, C], [A, B, D])
    expect(counters.get(A)).toBe(1) // unchanged
    expect(counters.get(B)).toBe(1) // unchanged
    expect(counters.get(C)).toBe(0) // removed → decremented
    expect(counters.get(D)).toBe(1) // added → incremented
  })

  it("does not let times_used go below zero on consecutive removals", () => {
    let counters = new Map<string, number>([[A, 0], [B, 1]])
    // Edge case: A was already 0 before this swap (shouldn't happen in
    // practice, but the projection clamps at 0 to keep the invariant).
    counters = applySave(counters, [A, B], [B, C])
    expect(counters.get(A)).toBe(0)
    expect(counters.get(B)).toBe(1)
    expect(counters.get(C)).toBe(1)
  })
})
