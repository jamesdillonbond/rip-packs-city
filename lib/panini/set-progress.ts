// lib/panini/set-progress.ts
//
// Row parsers for /api/panini-set-progress (Panini Sets tab, 2026-09-27) over
// `panini_set_progress_all(p_username)` (one row per product + set) and
// `panini_set_progress_products(p_username)` (one row per product, 2026-10-10). Pure, so the null-vs-zero rules are testable
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

/** 2026 Panini NFT Prizm World Cup Soccer — the tab's default product. */
export const PANINI_WC_SET_ID = 2332

export interface PaniniProductRow {
  setId: number
  /** Panini's product name; null until the registry names it. */
  name: string | null
  sport: string | null
  sets: number
  editionsSeen: number
  owned: number
  ownerLastSeenAt: string | null
}

export function parsePaniniProductRow(row: unknown): PaniniProductRow | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const setId = num(r.product_set_id)
  const sets = num(r.sets)
  const editionsSeen = num(r.editions_seen)
  const owned = num(r.owned)
  if (setId === null || !Number.isInteger(setId) || setId <= 0) return null
  // SQL count()/sum()s over at least one set row — never NULL on a well-formed row.
  if (sets === null || sets <= 0 || editionsSeen === null || owned === null) return null
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  return {
    setId,
    name: str(r.product_name),
    sport: str(r.sport),
    sets,
    editionsSeen,
    owned,
    ownerLastSeenAt: typeof r.owner_last_seen_at === "string" ? r.owner_last_seen_at : null,
  }
}

/** A product's display name: Panini's own when known, else an honest placeholder. */
export function paniniProductLabel(p: { setId: number; name: string | null }): string {
  return p.name ?? `Panini product ${p.setId} (name not yet known)`
}
