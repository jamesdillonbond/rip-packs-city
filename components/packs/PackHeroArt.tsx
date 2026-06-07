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
import { tierChip } from "@/lib/tier-style"

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
  const chip = tierChip(tier)
  const backdrop = `linear-gradient(135deg, ${chip.background} 0%, rgba(0,0,0,0.55) 75%)`

  if (url && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={title}
        width={size}
        height={size}
        loading="eager"
        decoding="async"
        onError={() => setErrored(true)}
        style={{ width: size, height: size, objectFit: "cover", display: "block" }}
      />
    )
  }

  const thumbs = montage.filter(Boolean).slice(0, 4)
  if (thumbs.length > 0) {
    const single = thumbs.length === 1
    return (
      <div
        style={{
          width: size,
          height: size,
          background: backdrop,
          display: "grid",
          gridTemplateColumns: single ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
          gridTemplateRows: thumbs.length <= 2 ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
          gap: 2,
        }}
        aria-label={title}
      >
        {thumbs.map((t, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={t}
            alt=""
            loading="eager"
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
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
