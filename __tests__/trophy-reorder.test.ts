import { describe, it, expect } from "vitest"
import { occupantOfSlot, reorderByDelta, reorderByTarget } from "@/lib/trophy/reorder"

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

// ─────────────────────────────────────────────────────────────────────────────
// occupantOfSlot — who the picker's confirm step is about to overwrite.
//
// The whole point is that the array index is NOT the slot. Filled slabs pack to
// the front of the dashboard's fixed-length array while `slot` is the persisted
// column, so an index lookup names a different trophy as soon as the case has a
// gap — and it names it inside a destructive confirmation, where the collector
// approves a replacement they were never shown.
// ─────────────────────────────────────────────────────────────────────────────

describe("occupantOfSlot", () => {
  // Slots 1 and 5 are filled; they sit at indices 0 and 1 because filled slabs
  // pack forward. Index-based lookup and slot-based lookup DISAGREE here, which
  // is exactly the shape that makes this function necessary.
  const packed = [{ slot: 1, player_name: "Lillard" }, { slot: 5, player_name: "Simons" }]

  it("finds the slab whose own slot matches", () => {
    expect(occupantOfSlot(packed, 5)?.player_name).toBe("Simons")
  })

  it("returns null for a slot nobody holds, even when that index is occupied", () => {
    // `packed[1]` exists, so an index lookup would confidently answer "Simons"
    // for slot 2 — a trophy in a completely different slot.
    expect(occupantOfSlot(packed, 2)).toBeNull()
  })

  it("ignores the empty cells of a fixed-length case", () => {
    const sparse = [null, { slot: 4, player_name: "Grant" }, undefined, null, null, null]
    expect(occupantOfSlot(sparse, 4)?.player_name).toBe("Grant")
    expect(occupantOfSlot(sparse, 1)).toBeNull()
  })

  it("returns null when no slot is being picked", () => {
    // The dashboard passes the open-modal slot, which is null while closed.
    expect(occupantOfSlot(packed, null)).toBeNull()
    expect(occupantOfSlot(packed, undefined)).toBeNull()
  })
})
