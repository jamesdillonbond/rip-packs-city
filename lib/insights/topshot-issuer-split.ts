// lib/insights/topshot-issuer-split.ts
//
// Top Shot's issuer-held supply, split into Moments inside unopened packs (sold or
// unsold) and reserve never put into any pack. Reads get_topshot_issuer_held_split()
// (migration 20261003224608), which sums Atlas DistributionService pack summaries
// against badge_editions.hidden_in_packs.
//
// ⚠ HONESTY — three states, never two:
//   · the read FAILED            → fetchTopShotIssuerSplit throws; the page says so;
//   · the read worked, split NOT provable yet (first walk under way, a drop with packs
//     left unread or > 48 h old) → split_status starts "pending:" and in_packs /
//     reserve are null. That is "not known yet", NOT zero — render the status;
//   · split_status "ok"          → in_packs and reserve are numbers.
// Every nullable numeric stays null through `numOrNull`; nothing defaults to 0.

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

export function shapeIssuerSplitRow(r: Record<string, unknown>): IssuerSplitRow {
  return {
    tier: r.tier == null || r.tier === "" ? null : String(r.tier),
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
    as_of: r.as_of == null || r.as_of === "" ? null : String(r.as_of),
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

export function isSplitKnown(r: IssuerSplitRow): boolean {
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
