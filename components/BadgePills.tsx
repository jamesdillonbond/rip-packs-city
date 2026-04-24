'use client'

import { useMemo } from 'react'
import {
  classesForColorFamily,
  lookupBadge,
  useBadgeTaxonomy,
} from '@/lib/badges/useBadgeTaxonomy'

// BadgePills — horizontal pill row used by sniper-feed rows and compact
// card headers. Consumes badge_taxonomy so color_family / priority come
// straight from the single source of truth. Sorts ascending by priority
// (lower → first); unknown titles render neutral and sink to the tail.

export interface BadgePillsProps {
  titles: string[]
  className?: string
  size?: 'xs' | 'sm'
  limit?: number
}

function sizeClasses(size: 'xs' | 'sm'): string {
  return size === 'xs' ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-0.5 text-[11px]'
}

export default function BadgePills({ titles, className = '', size = 'xs', limit }: BadgePillsProps) {
  const unique = useMemo(() => Array.from(new Set(titles.filter(Boolean))), [titles])
  const taxonomy = useBadgeTaxonomy(unique)

  const sorted = useMemo(() => {
    const withMeta = unique.map((t) => {
      const meta = lookupBadge(taxonomy, t)
      return {
        input: t,
        label: meta?.title ?? t,
        colorFamily: meta?.color_family ?? null,
        priority: meta?.priority ?? Number.POSITIVE_INFINITY,
        description: meta?.description ?? null,
      }
    })
    withMeta.sort((a, b) => a.priority - b.priority)
    return limit ? withMeta.slice(0, limit) : withMeta
  }, [unique, taxonomy, limit])

  if (!sorted.length) return null

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {sorted.map((b) => (
        <span
          key={b.input}
          title={b.description ? `${b.label} — ${b.description}` : b.label}
          className={`inline-flex items-center rounded border font-semibold ${sizeClasses(size)} ${classesForColorFamily(b.colorFamily)}`}
        >
          {b.label}
        </span>
      ))}
    </div>
  )
}
