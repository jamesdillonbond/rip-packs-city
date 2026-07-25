// sniper-serial-badge — pure classification/label logic lifted out of
// components/sniper/SerialBadge.tsx so it lands under the vitest coverage
// `include` (lib/**), which does NOT measure components/**. No React/JSX — the
// component keeps only rendering; these decide visibility, glyph category, and
// the pill label. Behavior is identical to the inline code it replaced.

// Map the feed's serialSignal vocabulary ("#1", "Jersey #12", "Jersey Serial",
// "Last #499") onto the glyph categories the SpecialSerialGlyph understands.
// Case-insensitive; anything unrecognized (or null) returns null (no glyph).
export function serialSignalTag(signal: string | null | undefined): "#1" | "jersey" | "last_mint" | null {
  const s = (signal ?? "").toLowerCase()
  if (s.startsWith("#1")) return "#1"
  if (s.startsWith("jersey")) return "jersey"
  if (s.startsWith("last")) return "last_mint"
  return null
}

// The badge only renders when the deal is a special serial OR its serial
// multiplier is above the neutral 1×. A plain (non-special, ≤1× mult) deal
// shows nothing.
export function shouldRenderSerialBadge(deal: {
  isSpecialSerial: boolean
  serialMult: number
}): boolean {
  return deal.isSpecialSerial || deal.serialMult > 1
}

// Pill label: the human serialSignal when present, otherwise the multiplier
// rendered as "×N.N".
export function serialBadgeLabel(deal: {
  serialSignal: string | null
  serialMult: number
}): string {
  return deal.serialSignal ?? `×${deal.serialMult.toFixed(1)}`
}
