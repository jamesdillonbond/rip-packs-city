// components/marketplace-status/MarketplaceUnavailablePill.tsx
//
// Drop-in replacement for a "Buy on Flowty" / "Buy now" CTA when the
// collection's `buy_ctas_enabled` flag is false. Renders a small
// disabled-state pill with a tooltip carrying the row's notes field.

"use client"

interface Props {
  /** Tooltip / aria-label text — usually the marketplace-status notes field. */
  notes?: string | null
  /** Shown inside the pill. Defaults to "MARKETPLACE UNAVAILABLE". */
  label?: string
  /** Optional override style — useful inside grid cells. */
  style?: React.CSSProperties
}

const DEFAULT_LABEL = "MARKETPLACE UNAVAILABLE"

export default function MarketplaceUnavailablePill({
  notes,
  label,
  style,
}: Props) {
  const tooltip = (notes ?? "Marketplace unavailable for this collection.").trim()
  return (
    <span
      role="button"
      aria-disabled="true"
      title={tooltip}
      className="rpc-chip"
      style={{
        background: "rgba(255,255,255,0.04)",
        borderColor: "rgba(255,255,255,0.15)",
        color: "var(--rpc-text-ghost)",
        textDecoration: "none",
        padding: "4px 12px",
        opacity: 0.65,
        cursor: "not-allowed",
        pointerEvents: "none",
        letterSpacing: "0.04em",
        ...(style ?? {}),
      }}
    >
      {label ?? DEFAULT_LABEL}
    </span>
  )
}
