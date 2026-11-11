// app/giveaways/[slug]/MomentBadges.tsx
//
// A giveaway Moment's edition badges (Rookie Year, Rookie Premiere, Top Shot
// Debut…) and special serial (#1 / jersey match / perfect mint), drawn only
// when they apply (Trevor, 2026-11-10). Glyphs are the canonical monoline set
// (lib/badges/glyphs.ts) — the same art the trophy slabs and OG cards draw.
// `null` (not read) and `[]` (read, none) both draw nothing; nothing here
// claims a Moment has no badges.

import { badgeGlyphDataUri, specialGlyphDataUri, SPECIAL_CAT_LABEL, GOLD_HEX, type SpecialCat } from "@/lib/badges/glyphs"

const MONO = "var(--font-mono)"
const BADGE_HEX = "#93C5FD" // brand-exception: glyph colour is passed into an SVG data URI, which cannot read CSS variables

export default function MomentBadges({
  badges,
  special,
  compact = false,
}: {
  badges?: string[] | null
  special?: SpecialCat[] | null
  compact?: boolean
}) {
  const b = Array.isArray(badges) ? badges.filter((t) => typeof t === "string" && t.trim()) : []
  const s = Array.isArray(special) ? special : []
  if (b.length === 0 && s.length === 0) return null
  const size = compact ? 11 : 13
  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: compact ? "1px 6px" : "2px 7px",
    borderRadius: 999,
    fontFamily: MONO,
    fontSize: compact ? 10 : 11,
    lineHeight: 1.3,
    whiteSpace: "nowrap",
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }} data-testid="moment-badges">
      {s.map((c) => (
        <span key={c} title={SPECIAL_CAT_LABEL[c]} style={{ ...pill, border: `1px solid ${GOLD_HEX}`, color: GOLD_HEX }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={specialGlyphDataUri(c)} alt="" width={size} height={size} />
          {SPECIAL_CAT_LABEL[c]}
        </span>
      ))}
      {b.map((t) => (
        <span key={t} title={t} style={{ ...pill, border: `1px solid ${BADGE_HEX}`, color: BADGE_HEX }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={badgeGlyphDataUri(t, BADGE_HEX)} alt="" width={size} height={size} />
          {t}
        </span>
      ))}
    </div>
  )
}
