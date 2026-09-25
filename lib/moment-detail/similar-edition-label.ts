// lib/moment-detail/similar-edition-label.ts

/**
 * 2026-09-25: the "Similar editions" tiles are, on Top Shot, this play's OTHER
 * PARALLELS — same player, tier, series and set — so six tiles read identically
 * ("Courtney Lee · RARE · Series 2025-26 · Run It Back: For The Win") with only
 * the price differing. Name the parallel from the printing ladder already on
 * the page (matched on external_id), else the print run ("/25") so a tile
 * always says what it is. Empty when neither is known.
 */
export function similarEditionParallelLabel(
  s: { external_id?: string | null; circulation_count: number | null },
  siblings: ReadonlyArray<{ external_id: string; subedition_name: string | null; circulation_count: number | null }>,
): string {
  const sib = s.external_id ? siblings.find((x) => x.external_id === s.external_id) : undefined
  const name = sib?.subedition_name?.trim()
  const run = s.circulation_count ?? sib?.circulation_count ?? null
  if (name && run != null) return ` · ${name} /${run.toLocaleString("en-US")}`
  if (name) return ` · ${name}`
  if (run != null) return ` · /${run.toLocaleString("en-US")}`
  return ""
}
