// lib/league-split.ts
//
// A collector's Panini or Candy cards BY LEAGUE / BRAND (2026-11-26) — the line under the dashboard's Panini
// and Candy tiles ("NFL 3,647 · NBA 1,556 · +11 more"). Client-safe: the parse and the one-line summary.
// Data: /api/league-split (panini_owner_property_split / candy_wallet_property_split, migration 20261126214413).

export interface LeagueSplitRow {
  slug: string
  name: string
  cards: number
}

export interface LeagueSplit {
  cards_total: number
  /** Cards RPC could not place under a league / brand — counted, never folded into one. */
  unplaced: number
  leagues: LeagueSplitRow[]
}

/** Pure parse; null = not the expected shape (a failed read — the line is then left out, not shown empty). */
export function toLeagueSplit(json: unknown): LeagueSplit | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const d = json as Record<string, unknown>
  if (!Array.isArray(d.leagues)) return null
  const total = Number(d.cards_total)
  if (!Number.isFinite(total)) return null
  const leagues: LeagueSplitRow[] = []
  for (const r of d.leagues as Array<Record<string, unknown>>) {
    const cards = Number(r?.cards)
    if (typeof r?.slug !== "string" || typeof r?.name !== "string" || !Number.isFinite(cards) || cards <= 0) continue
    leagues.push({ slug: r.slug, name: r.name, cards })
  }
  leagues.sort((a, b) => b.cards - a.cards || a.name.localeCompare(b.name))
  const unplaced = Number(d.unplaced)
  return { cards_total: total, unplaced: Number.isFinite(unplaced) ? unplaced : 0, leagues }
}

/**
 * "NFL 3,647 · NBA 1,556 · FIFA World Cup 1,153 · +11 more". Null when there is nothing to split: no cards
 * placed, or everything under ONE league (the tile's own count already says that).
 */
export function leagueSplitLine(split: LeagueSplit, max = 3): string | null {
  if (split.leagues.length < 2) return null
  const shown = split.leagues.slice(0, max).map((l) => `${l.name} ${l.cards.toLocaleString("en-US")}`)
  const rest = split.leagues.length - shown.length
  return shown.join(" · ") + (rest > 0 ? ` · +${rest} more` : "")
}
