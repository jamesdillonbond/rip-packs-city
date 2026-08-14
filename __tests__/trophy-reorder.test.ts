import { describe, it, expect } from "vitest"
import { reorderByDelta, reorderByTarget } from "@/lib/trophy/reorder"

// ─────────────────────────────────────────────────────────────────────────────
// Trophy-case reorder math.
//
// Extracted from app/dashboard/page.tsx, which is a `page.tsx` — measured by
// NEITHER coverage gate — where the drag / Auto-Arrange / undo logic has never
// had a test. `reorderByDelta` additionally backs the ONLY reorder a phone or a
// keyboard has: "Edit Layout" was `display: none` under 768px and HTML5
// `draggable` never fires on touch, so mobile owners could not reorder their
// case by any means, and a keyboard user could not on any viewport.
// ─────────────────────────────────────────────────────────────────────────────

const IDS = [10, 20, 30, 40]

describe("reorderByDelta", () => {
  it("moves a slab left", () => {
    expect(reorderByDelta(IDS, 30, -1)).toEqual([10, 30, 20, 40])
  })

  it("moves a slab right", () => {
    expect(reorderByDelta(IDS, 20, 1)).toEqual([10, 30, 20, 40])
  })

  it("CLAMPS at the ends rather than wrapping", () => {
    // ⚠ The important one. Wrapping would fling the last trophy to the front of
    // the case — a reorder nobody asked for, applied to the thing the public
    // profile leads with, with the undo bar as the only clue.
    expect(reorderByDelta(IDS, 10, -1)).toBeNull()
    expect(reorderByDelta(IDS, 40, 1)).toBeNull()
  })

  it("returns null for a no-op, so no round trip is spent", () => {
    expect(reorderByDelta(IDS, 20, 0)).toBeNull()
  })

  it("returns null for an id that is not in the list", () => {
    expect(reorderByDelta(IDS, 999, 1)).toBeNull()
  })

  it("does not mutate the input", () => {
    const src = [...IDS]
    reorderByDelta(src, 30, -1)
    expect(src).toEqual(IDS)
  })

  it("preserves every id exactly once", () => {
    // A splice bug that drops or duplicates an id would persist a corrupt case.
    for (const id of IDS) {
      for (const d of [-1, 1] as const) {
        const next = reorderByDelta(IDS, id, d)
        if (!next) continue
        expect([...next].sort()).toEqual([...IDS].sort())
      }
    }
  })

  it("handles a single-slab case without moving anything", () => {
    expect(reorderByDelta([7], 7, -1)).toBeNull()
    expect(reorderByDelta([7], 7, 1)).toBeNull()
  })
})

describe("reorderByTarget", () => {
  it("moves the dragged slab into the target's position", () => {
    expect(reorderByTarget(IDS, 40, 10)).toEqual([40, 10, 20, 30])
    expect(reorderByTarget(IDS, 10, 40)).toEqual([20, 30, 40, 10])
  })

  it("returns null on a self-drop", () => {
    expect(reorderByTarget(IDS, 20, 20)).toBeNull()
  })

  it("returns null when either id is unknown", () => {
    expect(reorderByTarget(IDS, 999, 20)).toBeNull()
    expect(reorderByTarget(IDS, 20, 999)).toBeNull()
  })

  it("does not mutate the input", () => {
    const src = [...IDS]
    reorderByTarget(src, 40, 10)
    expect(src).toEqual(IDS)
  })

  it("agrees with reorderByDelta for an adjacent move", () => {
    // The two paths persist the same thing; if they diverge, drag and the
    // arrows would disagree about what "one to the left" means.
    expect(reorderByTarget(IDS, 30, 20)).toEqual(reorderByDelta(IDS, 30, -1))
    expect(reorderByTarget(IDS, 20, 30)).toEqual(reorderByDelta(IDS, 20, 1))
  })
})
