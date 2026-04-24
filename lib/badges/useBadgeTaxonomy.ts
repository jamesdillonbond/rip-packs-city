'use client'

import { useEffect, useState } from 'react'
import { normalizeBadgeKey } from './normalize'

export interface BadgeMeta {
  title: string
  category: string
  color_family: string
  icon_url: string | null
  priority: number
  description: string | null
}

export type BadgeTaxonomyMap = Record<string, BadgeMeta>

// Module-level caches keyed by the sorted unique titles input. Satisfies
// "cache the result per-page-view (same titles array = same result)" — any
// component asking for the same badge set reuses the fetch.
const resultCache = new Map<string, BadgeTaxonomyMap>()
const inflight = new Map<string, Promise<BadgeTaxonomyMap>>()

function cacheKey(titles: string[]): string {
  const seen = new Set<string>()
  for (const t of titles) {
    const n = normalizeBadgeKey(t)
    if (n) seen.add(n)
  }
  return Array.from(seen).sort().join('|')
}

async function fetchTaxonomy(titles: string[]): Promise<BadgeTaxonomyMap> {
  const key = cacheKey(titles)
  if (!key) return {}
  const cached = resultCache.get(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    try {
      const res = await fetch('/api/badge-taxonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles }),
      })
      const json = (await res.json().catch(() => ({}))) as { taxonomy?: BadgeTaxonomyMap; error?: string }
      if (!res.ok) throw new Error(json.error || 'taxonomy fetch failed')
      const map = json.taxonomy ?? {}
      resultCache.set(key, map)
      return map
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** Pure lookup — caller normalizes and reads. Used by downstream components. */
export function lookupBadge(map: BadgeTaxonomyMap, input: string): BadgeMeta | null {
  return map[normalizeBadgeKey(input)] ?? null
}

/** React hook: fetches taxonomy for the given titles, returns live map. */
export function useBadgeTaxonomy(titles: string[]): BadgeTaxonomyMap {
  const key = cacheKey(titles)
  const [map, setMap] = useState<BadgeTaxonomyMap>(() => resultCache.get(key) ?? {})
  useEffect(() => {
    if (!key) { setMap({}); return }
    const cached = resultCache.get(key)
    if (cached) { setMap(cached); return }
    let alive = true
    fetchTaxonomy(titles).then((m) => { if (alive) setMap(m) }).catch(() => { if (alive) setMap({}) })
    return () => { alive = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return map
}

// ── color_family → Tailwind class mapping ────────────────────────────────────
// Classes match the palette already used by BadgeRow / BadgePill so visual
// style stays consistent after the unification.
export const COLOR_FAMILY_CLASSES: Record<string, string> = {
  gold: 'bg-amber-950 text-amber-300 border-amber-800',
  amber: 'bg-amber-950 text-amber-300 border-amber-800',
  red: 'bg-red-950 text-red-300 border-red-800',
  rose: 'bg-rose-950 text-rose-300 border-rose-800',
  indigo: 'bg-indigo-950 text-indigo-300 border-indigo-800',
  emerald: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  cyan: 'bg-cyan-950 text-cyan-300 border-cyan-800',
  neutral: 'bg-white/5 text-white/80 border-white/10',
}

const NEUTRAL_CLASSES = COLOR_FAMILY_CLASSES.neutral

export function classesForColorFamily(family: string | null | undefined): string {
  if (!family) return NEUTRAL_CLASSES
  return COLOR_FAMILY_CLASSES[family] ?? NEUTRAL_CLASSES
}
