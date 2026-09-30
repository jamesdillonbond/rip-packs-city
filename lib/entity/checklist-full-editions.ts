// lib/entity/checklist-full-editions.ts
//
// The team checklist's "Full editions" view (Trevor, 2026-09-30, replacing the
// one-night "Ignore parallels" play grouping): the checklist is read at the FULL
// EDITION level, so every subedition parallel is removed from view. Each tile is
// one full edition; it is owned when the wallet holds THAT edition, and a
// missing one costs its own price. Nothing is folded together.
//
// HOW A PARALLEL IS IDENTIFIED. By the edition key, never by collection slug. A
// Top Shot subedition parallel is its own edition keyed `setID:playID::subID`;
// the full edition it is a parallel of is `setID:playID` (every one of the
// 4,739 parallel editions had its full edition in `editions`, measured
// 2026-09-29) — the same "::" convention lib/fmv-display-guard.ts and
// lib/market-sources.ts fold on. A collection whose keys carry no "::" has no
// parallels, so `hasParallels` is false and the toggle is hidden: the switch is
// derived from the DATA, not a slug list.
//
// PRICING RULE for a missing edition: the same one the "All moments" figure uses
// per edition — floor (lowest ask) when there is one, otherwise FMV
// (get_team_checklist_progress: COALESCE(floor_usd, fmv_usd)). An edition with
// NO price is NOT counted as $0: it is excluded from the sum and reported in
// `unpriced_missing_count`, so the UI can say the total is a lower bound.
//
// Pure — no I/O. The route (app/api/entity/team-checklist-full-editions)
// fetches the complete scoped checklist and hands it here.

export interface ChecklistEditionRow {
  route_slug: string
  tier?: string | null
  fmv_usd?: number | null
  floor_usd?: number | null
  fmv_confidence?: string | null
  owned?: boolean | null
  owned_count?: number | null
  owned_locked?: boolean | null
  [k: string]: unknown
}

export interface FullEditionTile extends ChecklistEditionRow {
  /** This edition's price (floor, else FMV); null when it has neither. */
  edition_cost_usd: number | null
}

export interface TierBreakdown {
  tier: string
  total: number
  owned: number
  cost_usd: number
}

export interface FullEditionProgress {
  total: number
  owned: number
  locked_owned: number | null
  missing_count: number
  completion_pct: number | null
  cost_to_complete_usd: number
  /** Missing editions with no price — excluded from cost_to_complete_usd. */
  unpriced_missing_count: number
  stale_missing_pct: number | null
  by_tier: TierBreakdown[]
}

const STALE_CONFIDENCE = new Set(["STALE", "LOW", "NO_DATA"])

/** True for a subedition parallel's key (`setID:playID::subID`). */
export function isParallelKey(editionKey: string): boolean {
  return editionKey.includes("::")
}

/** True when any row in the list is a subedition parallel. */
export function checklistHasParallels(rows: readonly { route_slug: string }[]): boolean {
  return rows.some((r) => typeof r.route_slug === "string" && isParallelKey(r.route_slug))
}

/** An edition's price under the "All moments" rule: floor, else FMV; null when neither is a positive number. */
export function editionPrice(r: Pick<ChecklistEditionRow, "floor_usd" | "fmv_usd">): number | null {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
  if (ok(r.floor_usd)) return r.floor_usd
  if (ok(r.fmv_usd)) return r.fmv_usd
  return null
}

const TIER_RANK: Record<string, number> = {
  ULTIMATE: 1, LEGENDARY: 2, CHAMPION: 3, CHALLENGER: 4, CONTENDER: 5,
  RARE: 6, UNCOMMON: 7, FANDOM: 8, COMMON: 9,
}

/**
 * The full editions in a checklist, parallels removed. `hasWallet` decides
 * whether ownership is known at all: without one `owned` stays null, as in the
 * per-edition read. Ownership is the edition's own — holding a parallel does
 * not check off its full edition.
 */
export function fullEditionTiles(rows: readonly ChecklistEditionRow[], hasWallet: boolean): FullEditionTile[] {
  const seen = new Set<string>()
  const out: FullEditionTile[] = []
  for (const r of rows) {
    if (typeof r.route_slug !== "string" || r.route_slug === "") continue
    if (isParallelKey(r.route_slug) || seen.has(r.route_slug)) continue
    seen.add(r.route_slug)
    out.push({
      ...r,
      owned: hasWallet ? r.owned === true : null,
      owned_locked: hasWallet ? r.owned_locked === true : null,
      edition_cost_usd: editionPrice(r),
    })
  }

  // Same order as get_team_checklist: missing before owned (with a wallet), then
  // most valuable first, then a unique tiebreak so the order is deterministic.
  out.sort((a, b) => {
    if (hasWallet) {
      const ao = a.owned === true ? 1 : 0
      const bo = b.owned === true ? 1 : 0
      if (ao !== bo) return ao - bo
    }
    const af = typeof a.fmv_usd === "number" ? a.fmv_usd : null
    const bf = typeof b.fmv_usd === "number" ? b.fmv_usd : null
    if (af !== bf) {
      if (af == null) return 1
      if (bf == null) return -1
      return bf - af
    }
    return a.route_slug < b.route_slug ? -1 : a.route_slug > b.route_slug ? 1 : 0
  })
  return out
}

/** Header numbers for the full-edition checklist. */
export function computeFullEditionProgress(tiles: readonly FullEditionTile[], hasWallet: boolean): FullEditionProgress {
  const total = tiles.length
  let owned = 0
  let locked = 0
  let cost = 0
  let unpriced = 0
  let stale = 0
  const tiers = new Map<string, { total: number; owned: number; cost: number }>()

  for (const t of tiles) {
    const isOwned = hasWallet && t.owned === true
    const tier = typeof t.tier === "string" && t.tier ? t.tier : "UNKNOWN"
    const agg = tiers.get(tier) ?? { total: 0, owned: 0, cost: 0 }
    agg.total += 1
    if (isOwned) {
      owned += 1
      agg.owned += 1
      if (t.owned_locked === true) locked += 1
    } else {
      if (t.edition_cost_usd != null) {
        cost += t.edition_cost_usd
        agg.cost += t.edition_cost_usd
      } else {
        unpriced += 1
      }
      if (t.edition_cost_usd == null || (typeof t.fmv_confidence === "string" && STALE_CONFIDENCE.has(t.fmv_confidence))) stale += 1
    }
    tiers.set(tier, agg)
  }

  const missing = total - owned
  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    total,
    owned,
    locked_owned: hasWallet ? locked : null,
    missing_count: missing,
    completion_pct: total > 0 ? Math.round((1000 * owned) / total) / 10 : null,
    cost_to_complete_usd: round2(cost),
    unpriced_missing_count: unpriced,
    stale_missing_pct: missing > 0 ? Math.round((100 * stale) / missing) : null,
    by_tier: [...tiers.entries()]
      .sort((a, b) => (TIER_RANK[a[0]] ?? 99) - (TIER_RANK[b[0]] ?? 99) || b[1].total - a[1].total)
      .map(([tier, t]) => ({ tier, total: t.total, owned: t.owned, cost_usd: round2(t.cost) })),
  }
}

/**
 * The checklist view from the URL: `?view=full` is "Full editions"; anything
 * else is "All moments". The one-night `?parallels=exclude` link (2026-09-29)
 * still opens the full-edition view, so a link shared from it is not broken.
 */
export type ChecklistView = "all" | "full"
export function parseChecklistView(view: string | null | undefined, legacyParallels?: string | null): ChecklistView {
  if (view === "full") return "full"
  if (view == null && legacyParallels === "exclude") return "full"
  return "all"
}
