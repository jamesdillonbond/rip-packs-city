// Ranking for the concierge's get_player_editions tool. Priced editions are ordered by FMV in
// the asked direction; an edition with no FMV sorts LAST either way (an unpriced edition is
// not the cheapest one, it is an unknown one).

export function sortPlayerEditionsByFmv<T extends { fmv_usd?: number | string | null }>(rows: T[], ascending: boolean): T[] {
  const priced = (r: T) => r.fmv_usd != null && Number.isFinite(Number(r.fmv_usd))
  return [...rows].sort((a, b) => {
    const pa = priced(a), pb = priced(b)
    if (pa !== pb) return pa ? -1 : 1
    if (!pa) return 0
    return ascending ? Number(a.fmv_usd) - Number(b.fmv_usd) : Number(b.fmv_usd) - Number(a.fmv_usd)
  })
}
