// The on-chain `dateOfMoment` as a YYYY-MM-DD game date, or null.
//
// All Day's "Dynamic" Series 5 plays carry the date 1899-12-30 — the zero date of a spreadsheet
// epoch, i.e. "no date", not a game played in 1899. Both All Day edition writers kept it because it
// passes a YYYY-MM-DD shape check, and player/team pages rendered "Dec 30, 1899" (80 editions,
// 2026-10-21 sweep). No collection's moments predate 1900, so anything earlier is an absence.
//
// 2026-11-06 (Search Console read): Top Shot's sentinel is the UNIX epoch — off-court content
// (set 102 "Fit Check", 14 editions live) carries "1970-01-01T00:00:00Z", which both Top Shot
// edition writers (app/api/ingest, app/api/admin/backfill-topshot-catalog) sliced to "1970-01-01"
// and persisted, so the edition <title>, grid tile and moment page read "Jan 1, 1970" as a fact.
// Vintage dates ARE real ("Heroes of the Game" carries 1958–1972 plays), so the test is the exact
// epoch DAY, never a later cut-off year.
export const EPOCH_SENTINEL_DATE = "1970-01-01"

export function parseGameDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null
  const s = String(raw).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  if (Number(s.slice(0, 4)) < 1900) return null
  if (s === EPOCH_SENTINEL_DATE) return null
  return s
}
