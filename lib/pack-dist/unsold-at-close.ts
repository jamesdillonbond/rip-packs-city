// lib/pack-dist/unsold-at-close.ts
//
// ⚠ GOLAZOS "PACKS REMAINING" CAN BE PACKS NOBODY BOUGHT (2026-10-19). Golazos
// pack EV rows carry total_unopened = Dapper's primary_available_supply — the
// packs the primary sale did NOT sell. While the drop is on sale that is the
// remaining stock. Once the sale window has CLOSED it is unsold inventory: dist
// 219 "Jornadas 1-9" reads "Packs remaining 20,566" from a 24,000-pack drop
// that closed 2023-09-30, while the complete open history holds 1,685 opens.
// The number is true (those packs exist, sealed); read bare, it says they are in
// collectors' hands. This names it.

/** Sub-label for the Packs remaining tile when the figure is unsold primary
 *  supply from a closed sale; null in every other case. */
export function unsoldAtCloseLabel(
  collection: string,
  metadata: Record<string, unknown> | null | undefined,
  packsRemaining: number | null,
  nowMs: number = Date.now(),
): string | null {
  if (collection !== "laliga-golazos" || !metadata || packsRemaining === null) return null
  const avail = Number(metadata.primary_available_supply)
  const end = typeof metadata.primary_end_time === "string" ? Date.parse(metadata.primary_end_time) : NaN
  if (!Number.isFinite(avail) || avail <= 0 || avail !== packsRemaining) return null
  if (!Number.isFinite(end) || end > nowMs) return null
  const total = Number(metadata.primary_total_supply)
  const closed = new Date(end).toISOString().slice(0, 10)
  return Number.isFinite(total) && total > 0
    ? `unsold of ${total.toLocaleString("en-US")} when the drop closed ${closed}`
    : `unsold when the drop closed ${closed}`
}
