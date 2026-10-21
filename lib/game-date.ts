// The on-chain `dateOfMoment` as a YYYY-MM-DD game date, or null.
//
// All Day's "Dynamic" Series 5 plays carry the date 1899-12-30 — the zero date of a spreadsheet
// epoch, i.e. "no date", not a game played in 1899. Both All Day edition writers kept it because it
// passes a YYYY-MM-DD shape check, and player/team pages rendered "Dec 30, 1899" (80 editions,
// 2026-10-21 sweep). No collection's moments predate 1900, so anything earlier is an absence.
export function parseGameDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null
  const s = String(raw).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  if (Number(s.slice(0, 4)) < 1900) return null
  return s
}
