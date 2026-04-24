'use client'

import { useMemo, useState } from 'react'
import {
  classesForColorFamily,
  lookupBadge,
  useBadgeTaxonomy,
} from '@/lib/badges/useBadgeTaxonomy'

// BadgeIcon — single compact badge cell for the collection page grid (and
// anywhere else one wants icon-first badge rendering). Shows the taxonomy's
// icon_url when present; otherwise degrades to a color_family pill
// (essentially a compact BadgeRow row). Unknown titles render as a neutral
// pill.
//
// Accepts either a `title` (canonical or near-canonical) or a raw slug —
// both are normalized through the taxonomy lookup key.

export interface BadgeIconProps {
  title: string
  size?: number
  className?: string
}

export default function BadgeIcon({ title, size = 18, className = '' }: BadgeIconProps) {
  const titles = useMemo(() => [title], [title])
  const taxonomy = useBadgeTaxonomy(titles)
  const meta = lookupBadge(taxonomy, title)
  const [errored, setErrored] = useState(false)

  const label = meta?.title ?? title
  const tooltip = meta?.description ? `${label} — ${meta.description}` : label

  if (meta?.icon_url && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={meta.icon_url}
        alt={label}
        title={tooltip}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErrored(true)}
        className={className}
        style={{ width: size, height: size, display: 'inline-block', verticalAlign: 'middle' }}
      />
    )
  }

  const classes = classesForColorFamily(meta?.color_family)
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classes} ${className}`}
    >
      {label}
    </span>
  )
}
