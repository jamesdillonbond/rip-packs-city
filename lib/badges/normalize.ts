// Mirrors the normalization inside Postgres's get_badge_display_metadata:
//   regexp_replace(lower(unaccent(t)), '[^a-z0-9]+', '', 'g')
// Clients use this to compute a lookup key matching what the RPC returned,
// so "rookie_year", "ROOKIE_YEAR", and "Rookie Year" all collapse to
// "rookieyear" on both sides.
export function normalizeBadgeKey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}
