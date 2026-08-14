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
 * Who currently occupies `slot`, for the picker's "this replaces …" notice.
 *
 * ⚠ Matches on the slab's OWN `slot`, never on array position — and that is the
 * entire reason this is a named function rather than an index. Filled slabs pack
 * to the FRONT of the dashboard's fixed-length array while `slot` is the
 * persisted column, so `slabs[slot - 1]` names the wrong Moment the moment the
 * case has a gap: pin into slot 3 of a case holding slots 1 and 5 and the
 * confirm step would warn you about the slab in slot 5, which it is not about to
 * touch. Naming the wrong trophy in a destructive confirmation is worse than
 * naming none — the collector approves a replacement they did not agree to.
 *
 * Returns `null` for an empty slot, which the caller must render as "empty"
 * rather than as silence (an absent notice is indistinguishable from an
 * un-wired caller).
 */
export function occupantOfSlot<T extends { slot: number }>(
  slabs: readonly (T | null | undefined)[],
  slot: number | null | undefined,
): T | null {
  if (slot == null) return null
  return slabs.find((s): s is T => !!s && s.slot === slot) ?? null
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
