'use client'

// lib/hooks/useMarketFilterOptions.ts
//
// The Market page's Set / Series / Team / Badge dropdown options and Player
// suggestions (2026-10-14). They used to be built from the 50 listings on
// screen, so a value with no listing among them (Portland Fire: 70 Top Shot
// editions with a live ask) could not be picked at all.
//
// Each list = the catalog (/api/market/filter-options — the DB-filtered arms (lib/market/edition-market-arms.ts):
// every value the collection's editions carry, the columns their market RPCs
// filter on, and every badge in market_edition_badges, which their badge filter
// reads) ∪ the facets of every window /api/market has fetched this session ∪ the
// page ∪ the current selection.
//
// A failed or absent catalog leaves `catalog` null — the facets still apply, so
// the lists degrade to what has been fetched, never to nothing.

import { useEffect, useMemo, useState } from 'react'
import { fetchJson } from '@/lib/analytics/fetch-json'
import { collectDistinct } from '@/lib/market-format'
import { collectBadgeOptions } from '@/lib/market/filters'
import type { MarketFacets } from '@/lib/market/facets'

type FilterCatalog = { sets: string[]; series: string[]; teams: string[]; players: string[]; badges: string[] }

const NO_FACETS: MarketFacets = { sets: [], series: [], teams: [], players: [], badges: [] }

export function mergeOptions(...lists: (readonly string[] | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const l of lists) for (const v of l ?? []) if (v) seen.add(v)
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

interface OptionRow {
  setName: string | null
  seriesName: string | null
  teamName: string | null
  playerName: string | null
  badgeSlugs: string[]
}

export function useMarketFilterOptions(args: {
  collectionUuid: string | null
  facets: MarketFacets | undefined
  listings: OptionRow[]
  selected: { sets: string[]; series: string[]; teams: string[]; badges: string[] }
}) {
  const { collectionUuid, facets, listings, selected } = args

  // Keyed by collection so a stale catalog is never shown for another one.
  const [loaded, setLoaded] = useState<{ uuid: string; catalog: FilterCatalog } | null>(null)
  useEffect(() => {
    if (!collectionUuid) return
    let cancelled = false
    fetchJson<{ catalog?: boolean } & Partial<FilterCatalog>>(`/api/market/filter-options?collectionId=${encodeURIComponent(collectionUuid)}`)
      .then(({ ok, json }) => {
        if (cancelled || !ok || json?.catalog !== true) return
        const { sets, series, teams, players, badges } = json
        if ([sets, series, teams, players, badges].every(Array.isArray)) {
          setLoaded({ uuid: collectionUuid, catalog: { sets: sets!, series: series!, teams: teams!, players: players!, badges: badges! } })
        }
      })
    return () => { cancelled = true }
  }, [collectionUuid])
  const catalog = loaded && loaded.uuid === collectionUuid ? loaded.catalog : null

  // Every option any response this session has carried, so picking a set does
  // not shrink the Set list to that one set when the next window is narrower.
  // Accumulated during render (React's "adjust state on prop change" pattern),
  // reset when the collection changes.
  const [seen, setSeen] = useState<{ uuid: string | null; last: MarketFacets | undefined; facets: MarketFacets }>(
    { uuid: collectionUuid, last: undefined, facets: NO_FACETS })
  if (seen.uuid !== collectionUuid || seen.last !== facets) {
    const base = seen.uuid === collectionUuid ? seen.facets : NO_FACETS
    const f = facets ?? NO_FACETS
    setSeen({
      uuid: collectionUuid,
      last: facets,
      facets: {
        sets: mergeOptions(base.sets, f.sets),
        series: mergeOptions(base.series, f.series),
        teams: mergeOptions(base.teams, f.teams),
        players: mergeOptions(base.players, f.players),
        badges: mergeOptions(base.badges, f.badges),
      },
    })
  }

  const { sets, series, teams, badges } = selected
  return useMemo(() => ({
    setOptions: mergeOptions(catalog?.sets, seen.facets.sets, collectDistinct(listings, (l) => l.setName), sets),
    seriesOptions: mergeOptions(catalog?.series, seen.facets.series, collectDistinct(listings, (l) => l.seriesName), series),
    teamOptions: mergeOptions(catalog?.teams, seen.facets.teams, collectDistinct(listings, (l) => l.teamName), teams),
    badgeOptions: mergeOptions(catalog?.badges, seen.facets.badges, collectBadgeOptions(listings), badges).sort(),
    playerSuggestions: mergeOptions(catalog?.players, seen.facets.players, collectDistinct(listings, (l) => l.playerName)),
  }), [catalog, seen, listings, sets, series, teams, badges])
}
