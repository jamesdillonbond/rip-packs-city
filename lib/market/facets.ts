// lib/market/facets.ts
//
// Filter options present in the listings /api/market FETCHED (its window, up
// to 1,000 rows), not just the 50 it returns for the page. The Market dropdowns
// were built from the page alone, so a badge, set or team carried by row 51+
// could not be picked (2026-10-14).
//
// Computed BEFORE the in-memory post-filters (discount, special serials,
// badges), so selecting one badge does not hide the others. These are what the
// page can offer for collections with no catalog (/api/market/filter-options
// serves Top Shot and All Day, whose RPCs filter at the source). `badges` is []
// when the badge read failed — the route refuses a badge filter then, so
// offering one would only lead to a 503.

import { collectDistinct } from "@/lib/market-format"
import { collectBadgeOptions } from "@/lib/market/filters"

export interface MarketFacets {
  sets: string[]
  series: string[]
  teams: string[]
  players: string[]
  badges: string[]
}

export function collectMarketFacets(
  rows: {
    setName?: string | null
    seriesName?: string | null
    teamName?: string | null
    playerName?: string | null
    badgeSlugs: string[]
  }[],
  badgesReadOk = true,
): MarketFacets {
  return {
    sets: collectDistinct(rows, (r) => r.setName?.trim()),
    series: collectDistinct(rows, (r) => r.seriesName),
    teams: collectDistinct(rows, (r) => r.teamName?.trim()),
    players: collectDistinct(rows, (r) => r.playerName?.trim()),
    badges: badgesReadOk ? collectBadgeOptions(rows) : [],
  }
}
