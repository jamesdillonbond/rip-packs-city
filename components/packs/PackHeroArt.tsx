"use client"

// components/packs/PackHeroArt.tsx
//
// Pack hero art with graceful fallback. Many pack_distributions.image_url
// values point at asset-preview.nbatopshot.com URLs that are now dead (they
// return an empty 200 / 404), and the old PackThumb fallback left the 260px
// hero box rendering as an empty black square. When the primary image is
// missing or errors, fall back to a 2×2 montage of the pack's top pool edition
// thumbnails over a tier-colored backdrop; when there are no pool thumbnails
// either, fall back to the tier backdrop + the pack title's initial.

import { useState } from "react"
import { tierChip, TIER_DEFAULT } from "@/lib/tier-style"

export default function PackHeroArt({
  url,
  tier,
  title,
  montage,
  size = 260,
}: {
  url: string | null
  tier: string
  title: string
  montage: string[]
  size?: number
}) {
  const [errored, setErrored] = useState(false)
  // Track dead montage thumbnails so an all-broken montage (common on reward
  // packs whose pool is depleted / whose thumbs are dead TS legacy URLs) falls
  // through to the branded letter tile instead of rendering black cells.
  const [deadThumbs, setDeadThumbs] = useState<Set<number>>(new Set())
  const chip = tierChip(tier)
  // Reward / tier-less packs get an RPC-branded tint rather than the near-black
  // default-slate backdrop, so the hero never reads as a solid black square.
  const tint = chip === TIER_DEFAULT
    ? "color-mix(in srgb, var(--rpc-red) 22%, transparent)"
    : chip.background
  const backdrop = `linear-gradient(135deg, ${tint} 0%, rgba(10,10,12,0.92) 74%)`

  if (url && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={title}
        width={size}
        height={size}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        onError={() => setErrored(true)}
        onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) setErrored(true) }}
        style={{ width: size, height: size, objectFit: "cover", display: "block" }}
      />
    )
  }

  const allThumbs = montage.filter(Boolean).slice(0, 4)
  const thumbs = allThumbs.filter((_, i) => !deadThumbs.has(i))
  if (thumbs.length > 0) {
    const single = allThumbs.length === 1
    return (
      <div
        style={{
          width: size,
          height: size,
          background: backdrop,
          display: "grid",
          gridTemplateColumns: single ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
          gridTemplateRows: allThumbs.length <= 2 ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
          gap: 2,
        }}
        aria-label={title}
      >
        {allThumbs.map((t, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={t}
            alt=""
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setDeadThumbs((s) => new Set(s).add(i))}
            onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) setDeadThumbs((s) => new Set(s).add(i)) }}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: deadThumbs.has(i) ? "none" : "block",
            }}
          />
        ))}
      </div>
    )
  }

  const initial = (title || "?").trim().charAt(0).toUpperCase() || "?"
  return (
    <div
      style={{
        width: size,
        height: size,
        background: backdrop,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-display)",
        fontWeight: 900,
        fontSize: Math.round(size * 0.4),
        color: chip.color,
      }}
      aria-label={title}
    >
      {initial}
    </div>
  )
}
