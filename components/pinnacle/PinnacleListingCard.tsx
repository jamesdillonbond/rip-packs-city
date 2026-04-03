"use client"

// ─── Variant badge colors ────────────────────────────────────────────────────

const VARIANT_COLORS: Record<string, { bg: string; text: string; glow?: string }> = {
  "Standard":          { bg: "#1e293b", text: "#94a3b8" },
  "Silver Sparkle":    { bg: "#334155", text: "#e2e8f0", glow: "#94a3b8" },
  "Brushed Silver":    { bg: "#475569", text: "#f1f5f9", glow: "#cbd5e1" },
  "Radiant Chrome":    { bg: "#374151", text: "#f9fafb", glow: "#9ca3af" },
  "Luxe Marble":       { bg: "#44403c", text: "#fafaf9", glow: "#a8a29e" },
  "Golden":            { bg: "#713f12", text: "#fef3c7", glow: "#f59e0b" },
  "Digital Display":   { bg: "#1e1b4b", text: "#c7d2fe", glow: "#818cf8" },
  "Color Splash":      { bg: "#831843", text: "#fce7f3", glow: "#f472b6" },
  "Colored Enamel":    { bg: "#14532d", text: "#dcfce7", glow: "#4ade80" },
  "Embellished Enamel":{ bg: "#1e3a5f", text: "#bfdbfe", glow: "#60a5fa" },
  "Apex":              { bg: "#4c1d95", text: "#ede9fe", glow: "#a78bfa" },
  "Quartis":           { bg: "#701a75", text: "#fae8ff", glow: "#e879f9" },
  "Quinova":           { bg: "#7c2d12", text: "#ffedd5", glow: "#fb923c" },
  "Xenith":            { bg: "#0f172a", text: "#fef08a", glow: "#facc15" },
}

const EDITION_TYPE_COLORS: Record<string, string> = {
  "Open Edition":          "#475569",
  "Open Event Edition":    "#4f46e5",
  "Limited Edition":       "#b45309",
  "Limited Event Edition": "#9333ea",
  "Legendary Edition":     "#dc2626",
  "Starter Edition":       "#0d9488",
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PinnacleListingCardProps {
  editionKey: string
  setName: string
  characters: string
  variant: string
  editionType: string
  seriesName: string
  franchise: string
  floorPrice: number | null
  serial: number | null
  isSerialized: boolean
  isChaser: boolean
  isLocked: boolean
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PinnacleListingCard({
  setName,
  characters,
  variant,
  editionType,
  seriesName,
  franchise,
  floorPrice,
  serial,
  isSerialized,
  isChaser,
  isLocked,
}: PinnacleListingCardProps) {
  const vc = VARIANT_COLORS[variant] ?? VARIANT_COLORS["Standard"]
  const etc = EDITION_TYPE_COLORS[editionType] ?? "#475569"

  return (
    <div
      className="group"
      style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)",
        border: "1px solid rgba(139, 92, 246, 0.2)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        transition: "border-color 0.2s, box-shadow 0.2s",
        cursor: "default",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.5)"
        e.currentTarget.style.boxShadow = "0 0 20px rgba(139, 92, 246, 0.15)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.2)"
        e.currentTarget.style.boxShadow = "none"
      }}
    >
      {/* SVG pushpin */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 64,
        }}
      >
        <svg width="32" height="56" viewBox="0 0 32 56" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Pin body (slate) */}
          <rect x="14" y="20" width="4" height="28" rx="2" fill="#94a3b8" />
          <path d="M10 18 L22 18 L19 28 L13 28 Z" fill="#94a3b8" />
          {/* Pin tip */}
          <path d="M15 48 L16 56 L17 48" fill="#94a3b8" />
          {/* Gold circle head */}
          <circle cx="16" cy="10" r="10" fill="#fbbf24" />
          <circle cx="16" cy="10" r="6" fill="#f59e0b" opacity="0.5" />
        </svg>
      </div>

      {/* Characters (title) */}
      <p
        style={{
          color: "#f1f5f9",
          fontWeight: 600,
          fontSize: 15,
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {characters.replace(/^\[|\]$/g, "")}
      </p>

      {/* Set + Series */}
      <p
        style={{
          color: "#94a3b8",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        {setName} &middot; {seriesName}
      </p>

      {/* Badges row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {/* Variant badge */}
        <span
          style={{
            background: vc.bg,
            color: vc.text,
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 6,
            boxShadow: vc.glow ? `0 0 8px ${vc.glow}40` : undefined,
          }}
        >
          {variant}
        </span>

        {/* Edition type badge */}
        <span
          style={{
            background: `${etc}30`,
            color: etc,
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 6,
          }}
        >
          {editionType}
        </span>

        {/* Chaser badge */}
        {isChaser && (
          <span
            style={{
              background: "#dc262630",
              color: "#ef4444",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 6,
            }}
          >
            CHASER
          </span>
        )}

        {/* Locked indicator */}
        {isLocked && (
          <span
            style={{
              background: "#f59e0b20",
              color: "#f59e0b",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 6,
            }}
          >
            LOCKED
          </span>
        )}
      </div>

      {/* Studio */}
      <p style={{ color: "#64748b", fontSize: 11 }}>{franchise}</p>

      {/* Serial (LE only) */}
      {isSerialized && serial !== null && (
        <p style={{ color: "#a78bfa", fontSize: 12, fontWeight: 500 }}>
          Serial #{serial}
        </p>
      )}

      {/* Price + Buy */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "auto",
          paddingTop: 8,
          borderTop: "1px solid rgba(139, 92, 246, 0.1)",
        }}
      >
        <span
          style={{
            color: "#fef08a",
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          {floorPrice !== null ? `$${floorPrice.toFixed(2)}` : "—"}
        </span>

        <a
          href="https://disneypinnacle.com/marketplace"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 14px",
            borderRadius: 8,
            textDecoration: "none",
            transition: "opacity 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "0.85"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "1"
          }}
        >
          Buy
        </a>
      </div>
    </div>
  )
}
