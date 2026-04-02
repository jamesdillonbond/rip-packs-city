"use client"

import type { PinnacleEdition } from "@/lib/pinnacle/types"

// ── Variant Color Map ────────────────────────────────────────────
// Disney magic aesthetic — gold accents for premium, purples for mid-tier
const VARIANT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  "Standard":          { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.25)", text: "#94A3B8" },
  "Silver Sparkle":    { bg: "rgba(192,192,191,0.10)", border: "rgba(192,192,191,0.30)", text: "#BFC0BF" },
  "Brushed Silver":    { bg: "rgba(169,169,169,0.10)", border: "rgba(169,169,169,0.30)", text: "#A9A9A9" },
  "Radiant Chrome":    { bg: "rgba(200,200,255,0.10)", border: "rgba(200,200,255,0.30)", text: "#C8C8FF" },
  "Luxe Marble":       { bg: "rgba(168,85,247,0.10)",  border: "rgba(168,85,247,0.30)",  text: "#A855F7" },
  "Golden":            { bg: "rgba(255,215,0,0.12)",   border: "rgba(255,215,0,0.35)",   text: "#FFD700" },
  "Digital Display":   { bg: "rgba(59,130,246,0.10)",  border: "rgba(59,130,246,0.30)",  text: "#3B82F6" },
  "Color Splash":      { bg: "rgba(236,72,153,0.10)",  border: "rgba(236,72,153,0.30)",  text: "#EC4899" },
  "Colored Enamel":    { bg: "rgba(52,211,153,0.10)",  border: "rgba(52,211,153,0.30)",  text: "#34D399" },
  "Embellished Enamel":{ bg: "rgba(251,191,36,0.10)",  border: "rgba(251,191,36,0.30)",  text: "#FBBF24" },
  "Apex":              { bg: "rgba(255,107,53,0.12)",  border: "rgba(255,107,53,0.35)",  text: "#FF6B35" },
  "Quartis":           { bg: "rgba(129,140,248,0.10)", border: "rgba(129,140,248,0.30)", text: "#818CF8" },
  "Quinova":           { bg: "rgba(168,85,247,0.12)",  border: "rgba(168,85,247,0.35)",  text: "#A855F7" },
  "Xenith":            { bg: "rgba(255,215,0,0.15)",   border: "rgba(255,215,0,0.40)",   text: "#FFD700" },
}

// ── Edition Type Badge Colors ────────────────────────────────────
const EDITION_COLORS: Record<string, string> = {
  "Open Edition":          "#94A3B8",
  "Open Event Edition":    "#34D399",
  "Limited Edition":       "#818CF8",
  "Limited Event Edition": "#A855F7",
  "Legendary Edition":     "#FFD700",
  "Starter Edition":       "#64748B",
}

const BUY_URL = "https://disneypinnacle.com/marketplace"

export default function PinnacleListingCard({
  edition,
}: {
  edition: PinnacleEdition
}) {
  const variantStyle = VARIANT_COLORS[edition.variant] ?? VARIANT_COLORS["Standard"]
  const editionColor = EDITION_COLORS[edition.edition_type] ?? "#94A3B8"

  return (
    <div
      className="rpc-card"
      style={{
        position: "relative",
        overflow: "hidden",
        background: "linear-gradient(135deg, rgba(15,23,42,0.95), rgba(10,10,30,0.98))",
        borderColor: variantStyle.border,
      }}
    >
      {/* Top accent stripe */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, ${variantStyle.text}, transparent)`,
          opacity: 0.7,
        }}
      />

      <div style={{ padding: "14px 16px 12px" }}>
        {/* Header: pin emoji + set name */}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              background: `linear-gradient(135deg, ${variantStyle.bg}, rgba(15,23,42,0.5))`,
              border: `1px solid ${variantStyle.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              flexShrink: 0,
            }}
          >
            📌
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Characters */}
            <div
              style={{
                fontSize: "var(--text-base)",
                fontWeight: 700,
                color: "var(--rpc-text-primary)",
                fontFamily: "var(--font-display)",
                letterSpacing: "0.02em",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {edition.characters || edition.set_name}
            </div>

            {/* Set + Series */}
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--rpc-text-secondary)",
                fontFamily: "var(--font-mono)",
                marginTop: 2,
              }}
            >
              {edition.set_name}
              {edition.series_name ? ` · ${edition.series_name}` : ""}
            </div>

            {/* Studios */}
            {edition.studios && (
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--rpc-text-muted)",
                  fontFamily: "var(--font-mono)",
                  marginTop: 2,
                }}
              >
                {edition.studios}
              </div>
            )}
          </div>

          {/* Price */}
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {edition.floor_price_usd !== null ? (
              <div
                style={{
                  fontSize: "var(--text-lg)",
                  fontWeight: 700,
                  color: "var(--rpc-text-primary)",
                  fontFamily: "var(--font-display)",
                }}
              >
                ${edition.floor_price_usd.toFixed(2)}
              </div>
            ) : (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--rpc-text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                No listing
              </div>
            )}
          </div>
        </div>

        {/* Badges row */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 10,
            alignItems: "center",
          }}
        >
          {/* Variant badge with shimmer effect */}
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              padding: "3px 8px",
              borderRadius: 3,
              background: variantStyle.bg,
              border: `1px solid ${variantStyle.border}`,
              color: variantStyle.text,
              textTransform: "uppercase",
            }}
          >
            {edition.variant}
          </span>

          {/* Edition type badge */}
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              padding: "3px 8px",
              borderRadius: 3,
              background: `${editionColor}15`,
              border: `1px solid ${editionColor}40`,
              color: editionColor,
              textTransform: "uppercase",
            }}
          >
            {edition.edition_type}
          </span>

          {/* Chaser indicator */}
          {edition.is_chaser && (
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.08em",
                padding: "3px 8px",
                borderRadius: 3,
                background: "rgba(255,215,0,0.12)",
                border: "1px solid rgba(255,215,0,0.35)",
                color: "#FFD700",
                textTransform: "uppercase",
              }}
            >
              ⭐ Chaser
            </span>
          )}
        </div>

        {/* Footer: buy button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.06em",
            }}
          >
            {edition.royalty_codes}
          </span>

          <a
            href={BUY_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "linear-gradient(135deg, #1e3a5f, #0f2744)",
              border: "1px solid rgba(168,85,247,0.3)",
              color: "#E0E7FF",
              padding: "5px 14px",
              borderRadius: "var(--radius-sm)",
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              cursor: "pointer",
              textDecoration: "none",
              transition: "all var(--transition-fast)",
            }}
          >
            BUY
          </a>
        </div>
      </div>
    </div>
  )
}
