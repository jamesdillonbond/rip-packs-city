// lib/entity/team-series-checklists.ts
//
// Team Series Checklists (Trevor, 2026-11-23 — "Can we build something like this?" on a
// screenshot of Top Shot's Team Checklists): one row per series, "collect a Moment of
// every <team> player from a series". Backed by public.get_team_series_checklists
// (migration 20261124032715) via /api/entity/team-series-checklists.
//
// PURE — no imports — the client component and the tests read it.

export interface SeriesChecklistPlayer {
  player_key: string
  player_name: string
  /** null when no wallet is tracked */
  owned: boolean | null
  owned_count: number
  /** cheapest LIVE ask among the player's editions in the series (<= 3x FMV, FMV required); null = no fair ask */
  cheapest_ask_usd: number | null
  cheapest_route_slug: string | null
  cheapest_name: string | null
  thumbnail_url: string | null
  edition_count: number
}

export interface SeriesChecklist {
  series_num: number
  players_total: number
  /** null when no wallet is tracked */
  players_owned: number | null
  to_go: number
  /** sum of cheapest live asks over the players still to go; excludes `unlisted` (never $0 for them) */
  cost_to_go_usd: number
  /** players still to go with no fair live ask — NOT in cost_to_go_usd */
  unlisted: number
  complete: boolean | null
  players: SeriesChecklistPlayer[]
}

export interface TeamSeriesChecklists {
  wallet_cached: boolean | null
  series: SeriesChecklist[]
}

/** Coerces the RPC's jsonb (numerics arrive as strings or numbers) into the typed shape; drops malformed rows. */
export function parseTeamSeriesChecklists(raw: unknown): TeamSeriesChecklists {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)
  const series: SeriesChecklist[] = []
  for (const s of Array.isArray(o.series) ? o.series : []) {
    if (!s || typeof s !== "object") continue
    const r = s as Record<string, unknown>
    const sn = num(r.series_num)
    const total = num(r.players_total)
    if (sn == null || total == null) continue
    const players: SeriesChecklistPlayer[] = []
    for (const p of Array.isArray(r.players) ? r.players : []) {
      if (!p || typeof p !== "object") continue
      const q = p as Record<string, unknown>
      const name = str(q.player_name)
      if (!name) continue
      players.push({
        player_key: str(q.player_key) ?? name,
        player_name: name,
        owned: bool(q.owned),
        owned_count: num(q.owned_count) ?? 0,
        cheapest_ask_usd: num(q.cheapest_ask_usd),
        cheapest_route_slug: str(q.cheapest_route_slug),
        cheapest_name: str(q.cheapest_name),
        thumbnail_url: str(q.thumbnail_url),
        edition_count: num(q.edition_count) ?? 0,
      })
    }
    series.push({
      series_num: sn,
      players_total: total,
      players_owned: num(r.players_owned),
      to_go: num(r.to_go) ?? 0,
      cost_to_go_usd: num(r.cost_to_go_usd) ?? 0,
      unlisted: num(r.unlisted) ?? 0,
      complete: bool(r.complete),
      players,
    })
  }
  return { wallet_cached: bool(o.wallet_cached), series }
}

/**
 * The series to badge "Closest": with a wallet, the incomplete series with the fewest
 * players to go; ties go to the cheaper fully-priced one, then the newer series. Without a
 * wallet nothing is "closest" (every row is the whole roster) → null.
 */
export function closestSeries(list: SeriesChecklist[], hasWallet: boolean): number | null {
  if (!hasWallet) return null
  let best: SeriesChecklist | null = null
  for (const s of list) {
    if (s.to_go <= 0 || s.players_total <= 0) continue
    if (!best) { best = s; continue }
    if (s.to_go !== best.to_go) { if (s.to_go < best.to_go) best = s; continue }
    // An unlisted player makes the total a lower bound — prefer the fully priced row.
    const sPriced = s.unlisted === 0, bPriced = best.unlisted === 0
    if (sPriced !== bPriced) { if (sPriced) best = s; continue }
    if (s.cost_to_go_usd !== best.cost_to_go_usd) { if (s.cost_to_go_usd < best.cost_to_go_usd) best = s; continue }
    if (s.series_num > best.series_num) best = s
  }
  return best ? best.series_num : null
}

/** "6 to go · $73.43 · 1 unlisted" pieces; the money piece is absent when every missing player is unlisted. */
export function toGoParts(s: SeriesChecklist, fmt: (n: number) => string): string[] {
  const parts = [`${s.to_go} to go`]
  const priced = s.to_go - s.unlisted
  if (priced > 0) parts.push(`${s.unlisted > 0 ? "≥ " : ""}${fmt(s.cost_to_go_usd)}`)
  if (s.unlisted > 0) parts.push(`${s.unlisted} unlisted`)
  return parts
}
