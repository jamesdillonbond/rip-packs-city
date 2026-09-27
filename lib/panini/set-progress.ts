// lib/panini/set-progress.ts
//
// Row parser for /api/panini-set-progress (Panini Sets tab, 2026-09-27) over
// `panini_set_progress(p_username)`. Pure, so the null-vs-zero rules are testable
// without a request: a missing numeric is null (never 0), and a row with no set
// name or no seen-edition count, or a null count, is dropped rather than rendered as an
// empty set or a zero.

export interface PaniniSetRow {
  setName: string
  editionsSeen: number
  playersSeen: number | null
  minMintCap: number | null
  maxMintCap: number | null
  stillInPacks: number | null
  owned: number
  missing: number
  missingAsked: number
  missingUnasked: number
  /** Sum of today's lowest confirmed asks over missing editions that have one; null when none do. */
  costUsd: number | null
  maxMissingAskUsd: number | null
  ownerLastSeenAt: string | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parsePaniniSetRow(row: unknown): PaniniSetRow | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const setName = typeof r.set_name === "string" && r.set_name.trim() ? r.set_name.trim() : null
  const editionsSeen = num(r.editions_seen)
  if (!setName || editionsSeen === null || editionsSeen <= 0) return null
  const owned = num(r.owned)
  const missing = num(r.missing)
  const missingAsked = num(r.missing_asked)
  const missingUnasked = num(r.missing_unasked)
  // These are SQL count()s — never NULL on a well-formed row. A null here is a
  // malformed row, and defaulting it to 0 would print a fabricated "0 missing".
  if (owned === null || missing === null || missingAsked === null || missingUnasked === null) return null
  return {
    setName,
    editionsSeen,
    playersSeen: num(r.players_seen),
    minMintCap: num(r.min_mint_cap),
    maxMintCap: num(r.max_mint_cap),
    stillInPacks: num(r.still_in_packs),
    owned,
    missing,
    missingAsked,
    missingUnasked,
    costUsd: num(r.cost_usd),
    maxMissingAskUsd: num(r.max_missing_ask_usd),
    ownerLastSeenAt: typeof r.owner_last_seen_at === "string" ? r.owner_last_seen_at : null,
  }
}
