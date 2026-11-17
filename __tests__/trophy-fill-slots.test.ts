import { describe, it, expect } from "vitest"
import { describeSlots, fillTargets, openSlotsOf, togglePick } from "@/lib/trophy/fill-slots"

// Multi-pick (2026-11-08): Dame Time entrants filled a case one modal per slot.

describe("openSlotsOf", () => {
  it("lists the empty slots ascending, ignoring nulls", () => {
    expect(openSlotsOf([2, null, 5, undefined])).toEqual([1, 3, 4, 6])
    expect(openSlotsOf([])).toEqual([1, 2, 3, 4, 5, 6])
    expect(openSlotsOf([1, 2, 3, 4, 5, 6])).toEqual([])
  })
})

describe("fillTargets", () => {
  it("the tapped empty slot first, then the other empty slots ascending", () => {
    expect(fillTargets(4, [1, 3, 4, 6])).toEqual([4, 1, 3, 6])
  })
  it("⛔ an OCCUPIED tapped slot is a single replace, never a multi-fill", () => {
    expect(fillTargets(2, [1, 3])).toEqual([2])
  })
  it("no known empty slots (unknown read) is a single pick", () => {
    expect(fillTargets(3, null)).toEqual([3])
    expect(fillTargets(3, undefined)).toEqual([3])
  })
})

describe("togglePick", () => {
  const k = (s: string) => s
  it("adds in order, removes on a second tap", () => {
    expect(togglePick(["a"], "b", 3, k)).toEqual(["a", "b"])
    expect(togglePick(["a", "b"], "a", 3, k)).toEqual(["b"])
  })
  it("ignores a pick past the cap", () => {
    expect(togglePick(["a", "b"], "c", 2, k)).toEqual(["a", "b"])
  })
})

describe("describeSlots", () => {
  it("names exactly the slots", () => {
    expect(describeSlots([3])).toBe("slot 3")
    expect(describeSlots([1, 2, 4])).toBe("slots 1, 2 and 4")
    expect(describeSlots([])).toBe("")
  })
})
