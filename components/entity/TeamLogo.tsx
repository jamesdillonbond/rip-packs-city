"use client"

// components/entity/TeamLogo.tsx
// Team Hub Phase 1 (C1). Client island used by the server-rendered TeamHero.
// Renders the official team logo and swaps to an initials badge when the image
// fails to load. The onError fallback needs client JS, so it lives here rather
// than in TeamHero (which stays a server component).

import { useState } from "react"

export default function TeamLogo({
  logoUrl,
  abbreviation,
  secondaryColor,
}: {
  logoUrl: string | null
  abbreviation: string | null
  secondaryColor: string | null
}) {
  const [failed, setFailed] = useState(false)
  const initials = (abbreviation || "?").slice(0, 3).toUpperCase()

  if (logoUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        width={96}
        height={96}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        onError={() => setFailed(true)}
        style={{
          width: 96,
          height: 96,
          objectFit: "contain",
          flex: "0 0 auto",
          filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.45))",
        }}
      />
    )
  }

  return (
    <div
      aria-hidden="true"
      style={{
        width: 96,
        height: 96,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        background: "rgba(0,0,0,0.30)",
        border: `2px solid ${secondaryColor || "rgba(255,255,255,0.40)"}`,
        fontFamily: "var(--font-display)",
        fontWeight: 900,
        fontSize: 28,
        letterSpacing: "0.04em",
        color: "#fff",
      }}
    >
      {initials}
    </div>
  )
}
