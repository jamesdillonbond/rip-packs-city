import type { CSSProperties } from "react"

// SpecialSerialGlyph — small monochrome icon marking WHY a serial is special:
// first mint (#1), jersey match, or perfect serial (serial == last mint / #N/N).
// Drawn in currentColor so it inherits the surrounding pill color (RPC red accent
// or muted). Original RPC-brand glyphs (medal / jersey / bullseye) — NOT Dapper's
// proprietary art. Accepts either tag vocabulary used across the app:
//   tag form:        "#1" | "jersey" | "last_mint" | "perfect"
//   badge_type enum: "first_serial" | "jersey_match" | "perfect_mint" | "last_serial"
// Returns null for anything unrecognized. (2026-06-30)

type Category = "first" | "jersey" | "perfect"

function categorize(tag: string | null | undefined): Category | null {
  const t = (tag ?? "").toLowerCase().trim()
  if (t === "#1" || t === "first" || t === "first_serial") return "first"
  if (t === "jersey" || t === "jersey_match") return "jersey"
  if (t === "perfect" || t === "last_mint" || t === "perfect_mint" || t === "last_serial") return "perfect"
  return null
}

export default function SpecialSerialGlyph({
  tag,
  size = 13,
  className = "",
}: {
  tag: string | null | undefined
  size?: number
  className?: string
}) {
  const cat = categorize(tag)
  if (!cat) return null

  const style: CSSProperties = { flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }

  if (cat === "first") {
    // First-place medal: disc + ribbon tails (no numeral, so it reads at any size).
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
        <circle cx="12" cy="9" r="6" />
        <path d="M9 14 L8 22 L12 19 L16 22 L15 14" />
        <circle cx="12" cy="9" r="2.1" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (cat === "jersey") {
    // Jersey / kit silhouette.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round">
        <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
      </svg>
    )
  }

  // perfect — bullseye / target (serial lands on the exact last mint).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth={1.7}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
