// lib/trophy/challenge-copy.ts
//
// The link-preview line for a trophy challenge board (2026-11-07).
// ⚠ Never a zero we did not read: a missing count drops out of the sentence;
// a READ zero invites the first entry.

import { pinsToken } from "@/lib/og/card-url"

/**
 * The board card's content token (known-issues #239): what the card draws — the
 * entry count and the first six entries' pins — so a new or changed entry is a
 * NEW card URL for every cache (same idea as a case's pinsToken). Null when the
 * payload is unreadable: no token, never a token of a failed read.
 */
export function challengeBoardToken(raw: unknown): string | null {
  const d = raw as { entries?: unknown; entry_count?: unknown } | null
  if (!d || !Array.isArray(d.entries)) return null
  const pins: { slot: number; moment_id: string }[] = []
  ;(d.entries as any[]).slice(0, 6).forEach((e, i) => {
    for (const s of Array.isArray(e?.slabs) ? e.slabs : []) {
      pins.push({ slot: i * 10 + Number(s?.slot ?? 0), moment_id: `${String(e?.username ?? "")}:${String(s?.moment_id ?? "")}` })
    }
  })
  pins.push({ slot: 999, moment_id: `n${typeof d.entry_count === "number" ? d.entry_count : d.entries.length}` })
  return pinsToken(pins)
}

export function challengeDescription(p: { tagline: string | null; entryCount?: number | null } | null): string {
  if (!p) return "Collectors show off their trophy cases for a Rip Packs City challenge."
  const lead = p.tagline ? p.tagline.replace(/[.\s]+$/, "") + "." : "A Rip Packs City trophy case challenge."
  const n = p.entryCount
  if (n == null) return `${lead} Show off your six on Rip Packs City.`
  if (n === 0) return `${lead} No entries yet — be the first.`
  return `${lead} ${n} collector${n === 1 ? " has" : "s have"} entered — show off your six on Rip Packs City.`
}
