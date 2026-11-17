// Edition-grain badge matching for the wallet binder.
//
// ⛔ Badges belong to an EDITION, never to a player-and-series. Until
// 2026-10-10 CollectionTabClient keyed badge_editions rows by
// `player_name::series_number` and kept the highest badge_score, so every
// moment of a player in a series wore that player's best edition's badges.
// Donovan Clingan's 2024 Rookie Ultimates #1/1 showed his Rookie Debut's
// "Top Shot Debut" (and, because Rookie Debut is a three-star rookie, lost its
// own Rookie Premiere / Rookie Year / Rookie Mint). Burn, lock, supply and ask
// figures in BadgeInfo were borrowed from that other edition the same way.
//
// The key is `badge_editions.external_id`, which equals the binder row's
// `editionKey` (wallet_moments_cache.edition_key) — including Top Shot
// parallels ("233:8332::19") and All Day / Golazos bare ids. Measured
// 2026-10-10: 2,735 of 2,735 sampled Top Shot binder rows matched exactly.
//
// A row with no key, or whose edition is not in the map, gets NO badge info —
// an absence, never another edition's badges.
import type { BadgeInfo, MomentRow } from "@/lib/collection/types"
import { BADGE_PILL_TITLES } from "@/lib/collection/helpers"

export function buildEditionBadgeMap(editions: any[]): Map<string, BadgeInfo> {
  const map = new Map<string, BadgeInfo>()
  for (const edition of editions) {
    const key = typeof edition?.external_id === "string" ? edition.external_id.trim() : ""
    if (!key) continue
    map.set(key, {
      badge_score: edition.badge_score,
      badge_titles: (edition.badge_titles ?? []).filter((t: string) => BADGE_PILL_TITLES.has(t)),
      is_three_star_rookie: edition.is_three_star_rookie,
      has_rookie_mint: edition.has_rookie_mint,
      burn_rate_pct: edition.burn_rate_pct,
      lock_rate_pct: edition.lock_rate_pct,
      low_ask: edition.low_ask,
      circulation_count: edition.circulation_count,
      effective_supply: edition.effective_supply ?? null,
      burned: edition.burned ?? 0,
      owned: edition.owned ?? 0,
      hidden_in_packs: edition.hidden_in_packs ?? 0,
      for_sale_by_collectors: edition.for_sale_by_collectors ?? null,
    })
  }
  return map
}

export function badgeInfoForRow(row: Pick<MomentRow, "editionKey">, map: Map<string, BadgeInfo>): BadgeInfo | null {
  const key = row.editionKey?.trim()
  if (!key) return null
  return map.get(key) ?? null
}
