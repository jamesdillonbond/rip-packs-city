// lib/insights/topshot-issuer-split.ts
//
// Top Shot's issuer-held supply, split into Moments inside unopened packs (sold or
// unsold) and reserve never put into any pack. Reads get_topshot_issuer_held_split()
// (migration 20261003224608) and get_topshot_issuer_held_split_edition()
// (20261003232935), which sum Atlas DistributionService pack data against
// badge_editions.hidden_in_packs. Types + display helpers: topshot-issuer-split-format.ts.
//
// ⚠ HONESTY — three states, never two:
//   · the read FAILED            → the fetchers throw; the caller says so;
//   · the read worked, split NOT provable yet (first walk under way, a drop with packs
//     left unread or > 48 h old) → split_status starts "pending:" and in_packs /
//     reserve are null. That is "not known yet", NOT zero — render the status;
//   · split_status "ok"          → in_packs and reserve are numbers.
// Every nullable numeric stays null through `numOrNull`; nothing defaults to 0.

import type { IssuerSplitEditionRow, IssuerSplitRow } from "@/lib/insights/topshot-issuer-split-format"

export type { IssuerSplitEditionRow, IssuerSplitRow }
export { isSplitKnown, splitStatusCopy, splitStatusShort, tierLabel } from "@/lib/insights/topshot-issuer-split-format"

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number {
  const n = Number(v)
  if (v === null || v === undefined || !Number.isFinite(n)) throw new Error(`issuer-split: non-numeric count ${String(v)}`)
  return n
}

function strOrNull(v: unknown): string | null {
  return v == null || v === "" ? null : String(v)
}

export function shapeIssuerSplitRow(r: Record<string, unknown>): IssuerSplitRow {
  return {
    tier: strOrNull(r.tier),
    editions: int(r.editions),
    hidden: numOrNull(r.hidden),
    in_packs: numOrNull(r.in_packs),
    reserve: numOrNull(r.reserve),
    editions_split_known: int(r.editions_split_known),
    editions_stale: int(r.editions_stale),
    hidden_stale: int(r.hidden_stale),
    packs_unopened: numOrNull(r.packs_unopened),
    packs_owned_by_collectors: numOrNull(r.packs_owned_by_collectors),
    split_status: String(r.split_status ?? ""),
    as_of: strOrNull(r.as_of),
  }
}

/**
 * `supabase` is the service-role client (typed any per the repo convention).
 * THROWS on a failed read, and on a row set with no collection-total row (the
 * function always returns one), so a broken answer never renders as "no split".
 */
export async function fetchTopShotIssuerSplit(
  supabase: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<IssuerSplitRow[]> {
  const { data, error } = await supabase.rpc("get_topshot_issuer_held_split")
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error("issuer-split: RPC returned no row set")
  const rows = (data as Record<string, unknown>[]).map(shapeIssuerSplitRow)
  if (!rows.some((r) => r.tier === null)) throw new Error("issuer-split: no collection-total row")
  return rows
}

/**
 * One Top Shot edition's split. `null` = the read worked and the id is not a Top
 * Shot edition (render nothing); a failed read THROWS.
 */
export async function fetchTopShotIssuerSplitEdition(
  supabase: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  externalId: string,
): Promise<IssuerSplitEditionRow | null> {
  const { data, error } = await supabase.rpc("get_topshot_issuer_held_split_edition", { p_external_id: externalId })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error("issuer-split: edition RPC returned no row set")
  const r = data[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    edition_external_id: String(r.edition_external_id ?? externalId),
    hidden: numOrNull(r.hidden),
    in_packs: numOrNull(r.in_packs),
    reserve: numOrNull(r.reserve),
    drops_with_packs: numOrNull(r.drops_with_packs),
    split_status: String(r.split_status ?? ""),
    as_of: strOrNull(r.as_of),
  }
}
