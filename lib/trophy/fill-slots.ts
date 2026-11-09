// lib/trophy/fill-slots.ts
//
// Multi-pick for a trophy case (2026-11-08). Dame Time feedback, the same
// evening, from both outside entrants: "it only let me select one at a time"
// and "I had to search each time". Each of them opened the picker SIX times —
// one modal per slot, the search box reset on every open — to fill one case.
//
// Picking several at once fills the case's EMPTY slots, in order, starting
// with the slot that was tapped. An OCCUPIED slot keeps the one-at-a-time
// replace flow: a pin there is an overwrite with no undo, and the confirm step
// that names whose trophy is displaced stays the only way to do it.

/** The case's empty slots (1-based, ascending), from the slot numbers in use. */
export function openSlotsOf(occupied: readonly (number | null | undefined)[], size = 6): number[] {
  const used = new Set(occupied.filter((s): s is number => typeof s === "number"));
  const out: number[] = [];
  for (let s = 1; s <= size; s++) if (!used.has(s)) out.push(s);
  return out;
}

/**
 * The slots a multi-pick writes, in the order picks land in them. The tapped
 * slot comes first, then the other empty slots ascending. A tapped slot that is
 * NOT empty (a replace) — or no known empty slots at all — is a single pick
 * into that slot alone.
 */
export function fillTargets(slot: number, openSlots: readonly number[] | null | undefined): number[] {
  if (!openSlots || !openSlots.includes(slot)) return [slot];
  return [slot, ...openSlots.filter((s) => s !== slot).sort((a, b) => a - b)];
}

/**
 * Toggle one Moment in an ordered selection, capped at `max`. Picking again
 * removes it; a pick past the cap is ignored (the UI says the case is full).
 */
export function togglePick<T>(picked: readonly T[], item: T, max: number, key: (t: T) => string): T[] {
  const k = key(item);
  if (picked.some((p) => key(p) === k)) return picked.filter((p) => key(p) !== k);
  if (picked.length >= max) return picked as T[];
  return [...picked, item];
}

/** "slot 3" / "slots 1, 2 and 4" — names exactly where the picks will go. */
export function describeSlots(slots: readonly number[]): string {
  if (slots.length === 0) return "";
  if (slots.length === 1) return `slot ${slots[0]}`;
  return `slots ${slots.slice(0, -1).join(", ")} and ${slots[slots.length - 1]}`;
}
