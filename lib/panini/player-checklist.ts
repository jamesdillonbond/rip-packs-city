// lib/panini/player-checklist.ts
//
// Types, the one read and the pure labels behind the Panini player checklist (2026-11-23, Panini parity pass —
// the parity matrix's "Player checklists: Panini —" cell). The data comes from
// /api/entity/panini-player-checklist (get_panini_player_checklist, migration 20261124013251).
//
// Honesty rules the labels carry:
//  - every card's price says what it IS: a live ask, an FMV estimate, an ask on a card RPC has never priced,
//    or "Unpriced" — never a bare number and never $0;
//  - the headline cost sums ONLY asks (within 3x FMV) and FMV estimates; asks on unpriced cards and unpriced
//    cards are counted beside it, never folded in;
//  - ownership from the "seen" source is a lower bound (cards RPC has read under the name), and a username RPC
//    has never seen is "not seen", never "owns none".
// No FMV confidence anywhere (internal only, 10-18).

import { fmtCount, fmtUsd } from "@/components/entity/_shared"

export type PaniniCostSource = "ask" | "fmv" | "ask_no_fmv" | null

export interface PaniniChecklistCard {
  external_id: string
  name: string | null
  /** Set on a franchise checklist (several players); absent on a player's own. */
  player_name?: string | null
  set_name: string | null
  parallel: string | null
  product_name: string | null
  tier: string | null
  mint_cap: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  low_ask_usd: number | null
  cost_usd: number | null
  cost_source: PaniniCostSource
  owned_count: number | null
}

export interface PaniniChecklistData {
  /** The player's name (player checklist); absent on a franchise checklist, which carries franchise_key. */
  player?: string
  franchise_key?: string
  username: string | null
  /** "profile" = the public profile a collector walk read; "seen" = serials read under the name. */
  source: "profile" | "seen" | null
  username_seen: boolean | null
  profile_read_at: string | null
  total: number
  owned: number | null
  missing: number | null
  cost_at_ask_usd: number
  priced_at_ask: number
  cost_at_fmv_usd: number
  priced_at_fmv: number
  cost_ask_no_fmv_usd: number
  priced_ask_no_fmv: number
  unpriced: number
  cards: PaniniChecklistCard[]
}

export type PaniniChecklistLoad = { kind: "error" } | { kind: "none" } | { kind: "ok"; data: PaniniChecklistData }

/** What a checklist is OF: one player (by page slug) or one franchise (hub league + team slug). */
export type PaniniChecklistSubject =
  | { kind: "player"; slug: string }
  | { kind: "franchise"; league: string; team: string }

/** The route a subject reads. */
export function paniniChecklistUrl(subject: PaniniChecklistSubject, username: string | null): string {
  const qs = subject.kind === "player"
    ? new URLSearchParams({ slug: subject.slug })
    : new URLSearchParams({ league: subject.league, team: subject.team })
  if (username) qs.set("username", username)
  return subject.kind === "player"
    ? `/api/entity/panini-player-checklist?${qs}`
    : `/api/entity/panini-franchise-checklist?${qs}`
}

/** One read. A 404 ("no Panini cards") is told apart from a failure; never throws. */
export async function fetchPaniniChecklist(subject: PaniniChecklistSubject, username: string | null): Promise<PaniniChecklistLoad> {
  try {
    const res = await fetch(paniniChecklistUrl(subject, username))
    if (res.status === 404) return { kind: "none" }
    if (!res.ok) return { kind: "error" }
    const json = (await res.json()) as PaniniChecklistData
    if (!json || !Array.isArray(json.cards)) return { kind: "error" }
    return { kind: "ok", data: json }
  } catch {
    return { kind: "error" }
  }
}

/** The player checklist's read (kept for callers that name a player slug). */
export function fetchPaniniPlayerChecklist(slug: string, username: string | null): Promise<PaniniChecklistLoad> {
  return fetchPaniniChecklist({ kind: "player", slug }, username)
}

/** The label for one card's price — what the figure IS, never a bare number. */
export function paniniCardPriceLabel(c: Pick<PaniniChecklistCard, "cost_usd" | "cost_source">): string {
  if (c.cost_usd == null || c.cost_source == null) return "Unpriced"
  if (c.cost_source === "ask") return `Ask ${fmtUsd(c.cost_usd)}`
  if (c.cost_source === "fmv") return `FMV ${fmtUsd(c.cost_usd)}`
  return `Ask ${fmtUsd(c.cost_usd)} · no FMV`
}

/** The cost-to-complete sentence. `null` headline when nothing priced is left to buy. */
export function paniniCostSummary(d: Pick<PaniniChecklistData,
  "cost_at_ask_usd" | "priced_at_ask" | "cost_at_fmv_usd" | "priced_at_fmv" | "cost_ask_no_fmv_usd" | "priced_ask_no_fmv" | "unpriced">): {
  headline: number | null
  parts: string[]
} {
  const n = d.priced_at_ask + d.priced_at_fmv
  const headline = n > 0 ? Math.round((d.cost_at_ask_usd + d.cost_at_fmv_usd) * 100) / 100 : null
  const parts: string[] = []
  if (d.priced_at_ask > 0) parts.push(`${fmtCount(d.priced_at_ask)} at live asks`)
  if (d.priced_at_fmv > 0) parts.push(`${fmtCount(d.priced_at_fmv)} at FMV (no listing near FMV)`)
  if (d.priced_ask_no_fmv > 0) {
    parts.push(`+ ${fmtCount(d.priced_ask_no_fmv)} ${d.priced_ask_no_fmv === 1 ? "card" : "cards"} RPC hasn't priced, listed at ${fmtUsd(d.cost_ask_no_fmv_usd)}, not included`)
  }
  if (d.unpriced > 0) parts.push(`${fmtCount(d.unpriced)} unpriced, not included`)
  return { headline, parts }
}

/** Where the owned flags come from, in one sentence — a "seen" read is a lower bound and says so. */
export function paniniOwnershipNote(d: Pick<PaniniChecklistData, "username" | "source" | "username_seen" | "profile_read_at">, ptDateTime: (iso: string | null) => string): string | null {
  if (!d.username) return null
  if (d.source === "profile") {
    return `Owned cards from ${d.username}'s public Panini profile, read ${ptDateTime(d.profile_read_at)}.`
  }
  if (d.username_seen === false) return null
  return `Owned cards are the ones RPC has read under ${d.username} on Panini's marketplace — a lower bound, not the whole collection. Link the username on your dashboard for a full profile read.`
}
