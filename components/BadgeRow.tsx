'use client'

import React, { useEffect, useState } from 'react'

// BadgeRow — single source of truth for rendering badge pills across the
// collection page, badges page, sniper rows, and wallet rows. Picks a color
// family per title (championship / rookie / playoffs / play-tag) and clips to
// maxVisible, with a "+N" pill that expands on tap to show the rest.

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

const CHAMPIONSHIP_KEYWORDS = [
  'championship',
  'finals',
  'super bowl',
  'mvp',
  'hall of fame',
]

const ROOKIE_KEYWORDS = [
  'rookie debut',
  'rookie premiere',
  'rookie of the year',
  'three-star rookie',
  'three star rookie',
  'rookie year',
  'rookie mint',
  'rookie',
  'ts debut',
  'top shot debut',
]

const PLAYOFFS_KEYWORDS = ['playoffs', 'all-star', 'all star', 'postseason']

function classify(title: string): 'championship' | 'rookie' | 'playoffs' | 'play_tag' {
  const t = title.toLowerCase()
  for (const kw of CHAMPIONSHIP_KEYWORDS) if (t.includes(kw)) return 'championship'
  for (const kw of ROOKIE_KEYWORDS) if (t.includes(kw)) return 'rookie'
  for (const kw of PLAYOFFS_KEYWORDS) if (t.includes(kw)) return 'playoffs'
  return 'play_tag'
}

function classesFor(category: ReturnType<typeof classify>): string {
  switch (category) {
    case 'championship':
      return 'bg-amber-950 text-amber-300 border-amber-800'
    case 'rookie':
      return 'bg-red-950 text-red-300 border-red-800'
    case 'playoffs':
      return 'bg-indigo-950 text-indigo-300 border-indigo-800'
    case 'play_tag':
    default:
      return 'bg-white/5 text-white/80 border-white/10'
  }
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

  if (!badges || badges.length === 0) return null

  const cap = isMobile ? 2 : maxVisible
  const visible = expanded ? badges : badges.slice(0, cap)
  const hidden = expanded ? [] : badges.slice(cap)

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {visible.map((b) => {
        const cat = classify(b.title)
        const tooltip = b.source ? `${b.title} (${b.source})` : b.title
        return (
          <span
            key={b.id}
            title={tooltip}
            className={`inline-flex items-center rounded-full border font-medium ${sizeClasses(size)} ${classesFor(cat)}`}
          >
            {b.title}
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
          title={hidden.map((b) => b.title).join(', ')}
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
