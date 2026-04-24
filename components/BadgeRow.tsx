'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  classesForColorFamily,
  lookupBadge,
  useBadgeTaxonomy,
  type BadgeMeta,
} from '@/lib/badges/useBadgeTaxonomy'

// BadgeRow — single source of truth for rendering badge pills across the
// collection page, badges page, sniper rows, and wallet rows. Consumes the
// badge_taxonomy RPC (via useBadgeTaxonomy) so color_family / priority /
// category live in one Postgres table instead of being hand-classified here.
// Priority sorts ascending (lower → first/largest). Titles not in the
// taxonomy fall back to neutral styling and render at the tail.

export type BadgeSource = 'sync' | 'derived' | 'play_tag' | 'set_play_tag' | string

export interface BadgeItem {
  id: string
  title: string
  source?: BadgeSource | null
}

export interface BadgeRowProps {
  badges: BadgeItem[]
  maxVisible?: number
  size?: 'sm' | 'md'
  className?: string
}

function sizeClasses(size: 'sm' | 'md'): string {
  return size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 639px)')
    const update = () => setIsMobile(mq.matches)
    update()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update)
      return () => mq.removeEventListener('change', update)
    } else {
      // Safari <14 fallback
      // eslint-disable-next-line deprecation/deprecation
      mq.addListener(update)
      return () => {
        // eslint-disable-next-line deprecation/deprecation
        mq.removeListener(update)
      }
    }
  }, [])
  return isMobile
}

export default function BadgeRow({
  badges,
  maxVisible = 3,
  size = 'md',
  className = '',
}: BadgeRowProps) {
  const isMobile = useIsMobile()
  const [expanded, setExpanded] = useState(false)
  const titles = useMemo(() => badges.map((b) => b.title), [badges])
  const taxonomy = useBadgeTaxonomy(titles)

  const sorted = useMemo(() => {
    // Lower priority renders first. Unknown titles sink to the tail (Infinity).
    const withMeta: { badge: BadgeItem; meta: BadgeMeta | null; priority: number }[] = badges.map((b) => {
      const meta = lookupBadge(taxonomy, b.title)
      return { badge: b, meta, priority: meta?.priority ?? Number.POSITIVE_INFINITY }
    })
    withMeta.sort((a, b) => a.priority - b.priority)
    return withMeta
  }, [badges, taxonomy])

  if (!badges || badges.length === 0) return null

  const cap = isMobile ? 2 : maxVisible
  const visible = expanded ? sorted : sorted.slice(0, cap)
  const hidden = expanded ? [] : sorted.slice(cap)

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {visible.map(({ badge, meta }) => {
        const classes = classesForColorFamily(meta?.color_family)
        const tooltip = badge.source ? `${meta?.title ?? badge.title} (${badge.source})` : (meta?.title ?? badge.title)
        return (
          <span
            key={badge.id}
            title={tooltip}
            className={`inline-flex items-center rounded-full border font-medium ${sizeClasses(size)} ${classes}`}
          >
            {meta?.title ?? badge.title}
          </span>
        )
      })}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(true)
          }}
          title={hidden.map(({ meta, badge }) => meta?.title ?? badge.title).join(', ')}
          className={`inline-flex items-center rounded-full border font-medium bg-white/5 text-white/60 border-white/10 hover:bg-white/10 transition-colors ${sizeClasses(size)}`}
        >
          +{hidden.length}
        </button>
      )}
    </div>
  )
}

/**
 * Normalize a mixed bag of legacy inputs (play_tags, set_play_tags, badge_titles,
 * unified badges[]) into a single BadgeItem[] for BadgeRow. Any callsite still
 * holding legacy shapes can feed them through this helper rather than hand-
 * building the array.
 */
export function normalizeBadges(input: {
  badges?: Array<{ id?: string; title: string; source?: string | null }> | null
  badge_titles?: string[] | null
  play_tags?: Array<{ id?: string; title: string }> | null
  set_play_tags?: Array<{ id?: string; title: string }> | null
}): BadgeItem[] {
  const out: BadgeItem[] = []
  const seen = new Set<string>()

  const pushUnique = (b: BadgeItem) => {
    const key = b.title.toLowerCase().trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(b)
  }

  if (Array.isArray(input.badges)) {
    for (const b of input.badges) {
      if (!b?.title) continue
      pushUnique({ id: b.id ?? `b-${b.title}`, title: b.title, source: b.source ?? 'derived' })
    }
  }

  if (Array.isArray(input.badge_titles)) {
    for (const title of input.badge_titles) {
      if (!title) continue
      pushUnique({ id: `t-${title}`, title, source: 'derived' })
    }
  }

  if (Array.isArray(input.play_tags)) {
    for (const t of input.play_tags) {
      if (!t?.title) continue
      pushUnique({ id: t.id ?? `pt-${t.title}`, title: t.title, source: 'play_tag' })
    }
  }

  if (Array.isArray(input.set_play_tags)) {
    for (const t of input.set_play_tags) {
      if (!t?.title) continue
      pushUnique({ id: t.id ?? `spt-${t.title}`, title: t.title, source: 'set_play_tag' })
    }
  }

  return out
}
