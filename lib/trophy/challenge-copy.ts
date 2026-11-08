// lib/trophy/challenge-copy.ts
//
// The link-preview line for a trophy challenge board (2026-11-07).
// ⚠ Never a zero we did not read: a missing count drops out of the sentence;
// a READ zero invites the first entry.

export function challengeDescription(p: { tagline: string | null; entryCount?: number | null } | null): string {
  if (!p) return "Collectors show off their trophy cases for a Rip Packs City challenge."
  const lead = p.tagline ? p.tagline.replace(/[.\s]+$/, "") + "." : "A Rip Packs City trophy case challenge."
  const n = p.entryCount
  if (n == null) return `${lead} Show off your six on Rip Packs City.`
  if (n === 0) return `${lead} No entries yet — be the first.`
  return `${lead} ${n} collector${n === 1 ? " has" : "s have"} entered — show off your six on Rip Packs City.`
}
