// lib/panini/sport-label.ts — Panini's grid sport names as headings (2026-10-26). A leaf module (no imports)
// so client components can use it. Panini's grid says "Womens Basketball"; RPC says "WNBA" everywhere else.

export function paniniSportLabel(sport: string): string {
  return sport === "Womens Basketball" ? "WNBA" : sport
}
