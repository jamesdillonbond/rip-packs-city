// lib/entity/checklist-full-editions.ts
//
// The team checklist's "Full editions" view (Trevor, 2026-09-30, replacing the
// one-night "Ignore parallels" play grouping): the checklist is read at the FULL
// EDITION level, so every subedition parallel is removed from view. Each tile is
// one full edition, and it is CHECKED OFF when the wallet holds that edition OR
// ANY of its subedition parallels (Trevor, 2026-09-30: "owning any parallel
// should check it off the checklist for that overall edition"). A missing one
// costs its CHEAPEST version, because buying any version completes it.
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
// PRICING RULE for a missing edition: the cheapest price among the full edition
// and its parallels in scope, each priced the way the "All moments" figure
// prices an edition — floor (lowest ask) when there is one, otherwise FMV
// (get_team_checklist_progress: COALESCE(floor_usd, fmv_usd)). An edition with
// NO priced version is NOT counted as $0: it is excluded from the sum and
// reported in `unpriced_missing_count`, so the UI can say the total is a lower
// bound. A parallel whose full edition is not in scope has no tile to check off
// and is dropped (measured 2026-09-29: every Top Shot parallel has its full
// edition).
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
  /** Cheapest price among this full edition and its parallels (floor, else FMV); null when none is priced. */
  edition_cost_usd: number | null
  /** Parallels of this full edition the wallet holds (null without a wallet). */
  owned_parallels: number | null
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

/** The full edition a key belongs to: everything before the first "::". */
export function fullEditionKeyOf(editionKey: string): string {
  const i = editionKey.indexOf("::")
  return i === -1 ? editionKey : editionKey.slice(0, i)
}

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

// Same order as get_team_checklist: missing before owned (with a wallet), then
// most valuable first, then a unique tiebreak so the order is deterministic.
function sortChecklistTiles<T extends ChecklistEditionRow>(out: T[], hasWallet: boolean): T[] {
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

/**
 * The COMPLETE "All moments" checklist as tiles (every edition and parallel,
 * nothing grouped), each priced the way the header sums it. The component reads
 * this when a tier or ownership filter is on: a filtered header is only correct
 * over the whole list, never over the 24-row page on screen (webz, 2026-10-01).
 */
export function allEditionTiles(rows: readonly ChecklistEditionRow[], hasWallet: boolean): FullEditionTile[] {
  const seen = new Set<string>()
  const out: FullEditionTile[] = []
  for (const r of rows) {
    if (typeof r.route_slug !== "string" || r.route_slug === "" || seen.has(r.route_slug)) continue
    seen.add(r.route_slug)
    out.push({
      ...r,
      owned: hasWallet ? r.owned === true : null,
      owned_locked: hasWallet ? r.owned === true && r.owned_locked === true : null,
      owned_count: r.owned_count ?? null,
      owned_parallels: null,
      edition_cost_usd: editionPrice(r),
    })
  }
  return sortChecklistTiles(out, hasWallet)
}

/**
 * The full editions in a checklist, parallels removed from view but COUNTED:
 * a full edition is owned when the wallet holds it or any of its parallels.
 * `hasWallet` decides whether ownership is known at all: without one `owned`
 * stays null, as in the per-edition read.
 */
export function fullEditionTiles(rows: readonly ChecklistEditionRow[], hasWallet: boolean): FullEditionTile[] {
  const full = new Map<string, ChecklistEditionRow>()
  const parallels = new Map<string, ChecklistEditionRow[]>()
  for (const r of rows) {
    if (typeof r.route_slug !== "string" || r.route_slug === "") continue
    if (isParallelKey(r.route_slug)) {
      const k = fullEditionKeyOf(r.route_slug)
      const g = parallels.get(k)
      if (g) g.push(r)
      else parallels.set(k, [r])
    } else if (!full.has(r.route_slug)) {
      full.set(r.route_slug, r)
    }
  }

  const out: FullEditionTile[] = []
  for (const [key, r] of full) {
    const pars = parallels.get(key) ?? []
    let cheapest = editionPrice(r)
    for (const p of pars) {
      const pr = editionPrice(p)
      if (pr != null && (cheapest == null || pr < cheapest)) cheapest = pr
    }
    const ownedPars = pars.filter((p) => p.owned === true)
    const ownsFull = r.owned === true
    out.push({
      ...r,
      owned: hasWallet ? ownsFull || ownedPars.length > 0 : null,
      owned_locked: hasWallet ? r.owned_locked === true || ownedPars.some((p) => p.owned_locked === true) : null,
      owned_count: hasWallet
        ? (ownsFull ? (typeof r.owned_count === "number" ? r.owned_count : 1) : 0) +
          ownedPars.reduce((n, p) => n + (typeof p.owned_count === "number" ? p.owned_count : 1), 0)
        : r.owned_count ?? null,
      owned_parallels: hasWallet ? ownedPars.length : null,
      edition_cost_usd: cheapest,
    })
  }

  return sortChecklistTiles(out, hasWallet)
}

/** Header numbers for the full-edition checklist. */
export type ProgressTile = Pick<ChecklistEditionRow, "tier" | "owned" | "owned_locked" | "fmv_confidence"> & { edition_cost_usd?: number | null }
export function computeFullEditionProgress(tiles: readonly ProgressTile[], hasWallet: boolean): FullEditionProgress {
  const total = tiles.length
  let owned = 0
  let locked = 0
  let cost = 0
  let unpriced = 0
  let stale = 0
  const tiers = new Map<string, { total: number; owned: number; cost: number }>()

  for (const t of tiles) {
    const isOwned = hasWallet && t.owned === true
    const tier = tierKey(t.tier)
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

// ── Reader filters (webz, 2026-10-01) ─────────────────────────────────────────
// "No chance I can collect all the Ultimates": a reader can leave whole tiers
// out of the checklist — tiles AND header (owned / % / cost-to-complete) — and
// can show only the ownership states they want ("only the ones I'm missing").

/** The tier a tile/breakdown row is grouped under; a missing tier is "UNKNOWN", as in the header. */
export function tierKey(tier: unknown): string {
  return typeof tier === "string" && tier ? tier : "UNKNOWN"
}

export type ChecklistOwnState = "locked" | "owned" | "missing"
export const CHECKLIST_OWN_STATES: readonly ChecklistOwnState[] = ["locked", "owned", "missing"]

/** A tile's ownership state. "locked" only where the collection has locking — elsewhere it reads as "owned". */
export function checklistOwnState(t: Pick<ChecklistEditionRow, "owned" | "owned_locked">, hasLocking: boolean): ChecklistOwnState {
  if (t.owned !== true) return "missing"
  return hasLocking && t.owned_locked === true ? "locked" : "owned"
}

/**
 * The tiles a reader asked to see. `shownStates` null = no ownership filter
 * (always the case without a wallet — ownership is unknown, so it cannot filter).
 */
export function filterChecklistTiles<T extends Pick<ChecklistEditionRow, "tier" | "owned" | "owned_locked">>(
  tiles: readonly T[],
  opts: { hiddenTiers: ReadonlySet<string>; shownStates: ReadonlySet<ChecklistOwnState> | null; hasLocking: boolean },
): T[] {
  return tiles.filter((t) => {
    if (opts.hiddenTiers.has(tierKey(t.tier))) return false
    if (opts.shownStates && !opts.shownStates.has(checklistOwnState(t, opts.hasLocking))) return false
    return true
  })
}

/** Hidden tiers as saved in localStorage (a JSON string array); anything else reads as none hidden. */
export function parseHiddenTiers(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))] : []
  } catch {
    return []
  }
}
