// lib/insights/topshot-issuer-split-format.ts
//
// Pure types + display helpers for Top Shot's issuer-held split (inside unopened
// packs vs reserve never packed). No DB client and no RPC read in this module, so
// any server component (the entity market-cap tile included) can import it without
// gaining a path to an unbounded read. The reads live in topshot-issuer-split.ts.

export interface IssuerSplitRow {
  /** null on the collection-total row. */
  tier: string | null
  editions: number
  hidden: number | null
  in_packs: number | null
  reserve: number | null
  editions_split_known: number
  /** Issuer-held rows older than 36 h, EXCLUDED from `hidden` and disclosed here. */
  editions_stale: number
  hidden_stale: number
  packs_unopened: number | null
  packs_owned_by_collectors: number | null
  split_status: string
  /** Oldest summary read among drops with packs left — the split is no newer than this. */
  as_of: string | null
}

/** One edition's split (get_topshot_issuer_held_split_edition). */
export interface IssuerSplitEditionRow {
  edition_external_id: string
  hidden: number | null
  in_packs: number | null
  reserve: number | null
  drops_with_packs: number | null
  split_status: string
  as_of: string | null
}

export function isSplitKnown(r: { split_status: string; in_packs: number | null; reserve: number | null }): boolean {
  return r.split_status === "ok" && r.in_packs != null && r.reserve != null
}

/** "Common", "Legendary"… for the tier key Atlas uses (COMMON, LEGENDARY…). */
export function tierLabel(tier: string | null): string {
  if (tier == null) return "All tiers"
  return tier.charAt(0) + tier.slice(1).toLowerCase()
}

/** Reader-facing status line for a split that is not "ok". */
export function splitStatusCopy(status: string): string {
  if (status === "ok") return ""
  if (status.startsWith("pending:")) {
    return `Not known yet — the pack-supply walk is still reading Top Shot's drops (${status.slice("pending:".length).trim()}).`
  }
  if (status.startsWith("contradicted:")) return "Not shown — the pack count and the issuer-held count disagree."
  return `Unknown — ${status.replace(/^unknown:\s*/, "")}.`
}

/** Short form for a tile sub-line. */
export function splitStatusShort(status: string): string {
  if (status === "ok") return ""
  if (status.startsWith("pending:")) return "pack / reserve split not known yet"
  if (status.startsWith("contradicted:")) return "pack and issuer counts disagree"
  return "pack / reserve split unknown"
}
