/**
 * lib/schonely.ts
 *
 * Schonely-flavored loading and empty-state copy for Rip Packs City.
 * Pays homage to longtime Portland Trail Blazers broadcaster Bill Schonely
 * (1929–2023), whose vocabulary — "Rip City!", "Bingo bango bongo",
 * "Lickety brindle up the middle", "Climbing the golden ladder",
 * "Crossing the cyclops" — defined Rip City for half a century.
 */

export const LOADING_PHRASES: readonly string[] = [
  "Climbing the golden ladder...",
  "Lickety brindle up the middle...",
  "Crossing the cyclops...",
  "Bingo bango bongo...",
  "Lacing up...",
  "Working the scorer's table...",
];

export const EMPTY_STATE_PHRASES: readonly string[] = [
  "No bingo, no bango, no bongo — nothing here yet.",
  "The scoreboard's still warming up.",
  "Quiet on the court for now.",
];

function pickFrom(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickLoading(): string {
  return pickFrom(LOADING_PHRASES);
}

export function pickEmpty(): string {
  return pickFrom(EMPTY_STATE_PHRASES);
}
