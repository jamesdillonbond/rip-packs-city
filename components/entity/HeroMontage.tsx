"use client"

// components/entity/HeroMontage.tsx
// Phase 2 (entity media). A small fixed-size row of moment thumbnails shown
// beside the text hero on Set / Team / Series pages, which otherwise have a
// text-only hero. The calling page passes its top editions (24 candidates on
// the team hub); the component renders the first `max` whose thumbnail actually
// loads. Dead-but-non-null URLs (e.g. TS legacy assets.nbatopshot.com/editions/…
// that 404) are pruned on error and the next candidate slides in, so the strip
// never renders blank tiles. Client component only so image errors can be
// caught; its markup still SSRs (decorative / aria-hidden, so no SEO cost).

import { useState } from "react"
import { proxyIpfsUrl } from "@/lib/ipfs-media"

interface MontageItem {
  thumbnail_url: string | null
  name?: string | null
}

export default function HeroMontage({ items, max = 5 }: { items: MontageItem[]; max?: number }) {
  const candidates = (items ?? []).filter((i) => !!i.thumbnail_url)
  const [dead, setDead] = useState<Set<number>>(new Set())
  if (candidates.length === 0) return null

  const indexed = candidates.map((it, i) => ({ it, i }))
  const shown = indexed.filter(({ i }) => !dead.has(i)).slice(0, max)
  if (shown.length === 0) return null

  return (
    <div
      aria-hidden="true"
      style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflow: "hidden" }}
    >
      {shown.map(({ it, i }) => (
        <div
          key={i}
          style={{
            width: 72,
            height: 72,
            flex: "0 0 auto",
            borderRadius: 4,
            overflow: "hidden",
            border: "1px solid var(--rpc-border)",
            background: "rgba(0,0,0,0.35)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proxyIpfsUrl(it.thumbnail_url) ?? undefined}
            alt={it.name ?? ""}
            width={72}
            height={72}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setDead((s) => new Set(s).add(i))}
            onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) setDead((s) => new Set(s).add(i)) }}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </div>
      ))}
    </div>
  )
}
