// lib/trophy/reorder.ts
//
// Pure reorder math for the trophy case, extracted from the dashboard's
// TrophyCaseSection so it is unit-testable and measured by the coverage
// ratchet — `app/dashboard/page.tsx` is a `page.tsx`, which NEITHER gate
// measures, and the drag/Auto-Arrange/undo logic living there has no component
// test at all.
//
// Both callers move one slab to a new index in the filled-slab id list and
// persist the whole order; they differ only in how the target index is chosen.

/**
 * Move `id` by `delta` positions, returning the new id order.
 *
 * Returns `null` when the move is a no-op or out of range, so the caller can
 * skip the network round trip rather than persisting an unchanged order.
 *
 * ⚠ CLAMPED, NOT WRAPPED. A "move right" on the last slab must not jump it to
 * the front: that is a reorder the collector did not ask for, applied to the
 * thing their public profile leads with, and the undo bar would be their only
 * clue. Same for "move left" on the first.
 */
export function reorderByDelta(
  ids: readonly number[],
  id: number,
  delta: number,
): number[] | null {
  const from = ids.indexOf(id)
  if (from < 0) return null
  const to = from + delta
  if (to < 0 || to >= ids.length || to === from) return null
  const next = ids.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Move `dragId` to `targetId`'s position (the drag-and-drop case).
 *
 * Returns `null` on a self-drop or an id that is not in the list — the same
 * "nothing to persist" contract as `reorderByDelta`.
 */
export function reorderByTarget(
  ids: readonly number[],
  dragId: number,
  targetId: number,
): number[] | null {
  if (dragId === targetId) return null
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return null
  const next = ids.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
