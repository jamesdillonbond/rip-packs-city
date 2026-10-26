// lib/panini/sport-label.ts — Panini's sport names as RPC shows them (2026-10-26). A leaf module (no
// imports) so client components can use it. Panini's grid says "Womens Basketball" and a collector's
// profile says "WOMENS BASKETBALL" / "FOOTBALL": RPC shows "WNBA" and Title Case for the rest, keeping
// league acronyms (WWE, NBA, …) upper-case — the vocabulary panini_holdings_breakdown uses too.

const ACRONYMS = new Set(["WWE", "NBA", "NFL", "MLB", "NASCAR", "UFC", "WNBA", "NHL", "MLS"])

export function paniniSportLabel(sport: string): string {
  const s = sport.trim()
  const up = s.toUpperCase()
  if (up === "WOMENS BASKETBALL" || up === "WOMEN'S BASKETBALL") return "WNBA"
  if (ACRONYMS.has(up)) return up
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (w.trim() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join("")
}
