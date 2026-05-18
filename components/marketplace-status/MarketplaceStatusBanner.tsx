// components/marketplace-status/MarketplaceStatusBanner.tsx
//
// Top-of-page banner shown on /[collection]/overview when the collection's
// marketplace is in a non-healthy state. Copy varies per status:
//   shutdown → hard sunset language (UFC migrated to Aptos)
//   unknown  → softer "investigating venue" tone (Golazos)
//   dormant / degraded → generic informational variant
//
// Healthy collections render nothing.

"use client"

import { useMarketplaceStatus } from "./useMarketplaceStatus"

interface Props {
  /** Hyphen slug (e.g. "ufc", "laliga-golazos"). */
  collectionSlug: string
}

function bannerCopy(slug: string, status: string, notes: string | null): {
  title: string
  body: string
  accent: string
  background: string
  border: string
} | null {
  if (status === "shutdown") {
    if (slug === "ufc") {
      return {
        title: "UFC Strike has no active Flow marketplace",
        body:
          "Moments migrated to Aptos on 2025-07-30. Trade activity below is historical — buy flows are disabled on Flow.",
        accent: "#E03A2F",
        background: "rgba(224,58,47,0.08)",
        border: "rgba(224,58,47,0.35)",
      }
    }
    return {
      title: "Marketplace shut down",
      body:
        notes ??
        "This collection no longer has an active Flow marketplace. Historical data remains accessible; buy flows are disabled.",
      accent: "#E03A2F",
      background: "rgba(224,58,47,0.08)",
      border: "rgba(224,58,47,0.35)",
    }
  }
  if (status === "unknown") {
    if (slug === "laliga-golazos") {
      return {
        title: "Status uncertain",
        body:
          "Buy flow temporarily unavailable while we investigate venue. Portfolio and FMV tools below still work normally.",
        accent: "#F59E0B",
        background: "rgba(245,158,11,0.08)",
        border: "rgba(245,158,11,0.35)",
      }
    }
    return {
      title: "Marketplace status uncertain",
      body:
        notes ??
        "Buy flow temporarily unavailable while we investigate venue. Other tools still work normally.",
      accent: "#F59E0B",
      background: "rgba(245,158,11,0.08)",
      border: "rgba(245,158,11,0.35)",
    }
  }
  if (status === "dormant" || status === "degraded") {
    return {
      title: status === "dormant" ? "Marketplace dormant" : "Marketplace degraded",
      body:
        notes ??
        "Trade activity has slowed significantly. Buy flows remain enabled but listings may be sparse.",
      accent: "#F59E0B",
      background: "rgba(245,158,11,0.06)",
      border: "rgba(245,158,11,0.25)",
    }
  }
  return null
}

export default function MarketplaceStatusBanner({ collectionSlug }: Props) {
  const { status, loaded } = useMarketplaceStatus(collectionSlug)
  if (!loaded || !status) return null
  if (status.status === "healthy") return null
  const copy = bannerCopy(collectionSlug, status.status, status.notes)
  if (!copy) return null

  return (
    <section
      role="status"
      aria-live="polite"
      className="rpc-card"
      style={{
        padding: "12px 16px",
        background: copy.background,
        border: "1px solid " + copy.border,
        borderLeft: "3px solid " + copy.accent,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: "var(--text-base)",
          color: copy.accent,
          letterSpacing: "0.04em",
          marginBottom: 4,
          textTransform: "uppercase",
        }}
      >
        {copy.title}
      </div>
      <div
        className="rpc-mono"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--rpc-text-secondary)",
          lineHeight: 1.6,
        }}
      >
        {copy.body}
      </div>
    </section>
  )
}
