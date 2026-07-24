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
import { resolveBannerCopy } from "@/lib/marketplace-status-banner"

interface Props {
  /** Hyphen slug (e.g. "ufc", "laliga-golazos"). */
  collectionSlug: string
}

export default function MarketplaceStatusBanner({ collectionSlug }: Props) {
  const { status, loaded } = useMarketplaceStatus(collectionSlug)
  if (!loaded || !status) return null
  const copy = resolveBannerCopy(collectionSlug, status.status, status.notes)
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
