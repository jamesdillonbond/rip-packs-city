// lib/entity/checklist-plays.ts
//
// The team checklist's "Ignore parallels" mode (concierge feature request,
// 2026-09-29, on /nba-top-shot/team/detroit-pistons): a PLAY counts as collected
// when the wallet holds ANY version of it — the standard edition or any of its
// parallels — and cost-to-complete counts only the plays still missing.
//
// HOW A PARALLEL IS IDENTIFIED. By the edition key, never by collection slug. A
// Top Shot parallel printing is its own edition keyed `setID:playID::subID`; its
// standard edition is `setID:playID` (every one of the 4,739 parallel editions
// had its base in `editions`, measured 2026-09-29). Everything before the first
// "::" is the play key — the same convention lib/fmv-display-guard.ts and
// lib/market-sources.ts already fold on. A collection whose keys carry no "::"
// produces only one-version plays, so `hasParallels` is false and the toggle is
// hidden: the switch is derived from the DATA, not a slug list.
//
// PRICING RULE for a missing play: the CHEAPEST price among that play's versions
// in the checklist scope, where a version's price is the same one the "All
// moments" figure uses per edition — floor (lowest ask) when there is one,
// otherwise FMV (get_team_checklist_progress: COALESCE(floor_usd, fmv_usd)).
// Completing the play only needs one version, so the cheapest is the honest
// cost. A play with NO priced version is NOT counted as $0: it is excluded from
// the sum and reported in `unpriced_missing_count`, so the UI can say the total
// is a lower bound.
//
// Pure — no I/O. The route (app/api/entity/team-checklist-plays) fetches the
// complete scoped checklist and hands it here.

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

export interface PlayTile extends ChecklistEditionRow {
  /** The play key (edition key with any `::parallel` suffix removed). */
  play_key: string
  /** Editions of this play in scope (standard + parallels). */
  version_count: number
  /** Versions of this play the wallet holds (null without a wallet). */
  owned_versions: number | null
  /** Cheapest price among versions (floor, else FMV); null when none is priced. */
  play_cost_usd: number | null
}

export interface PlayTierBreakdown {
  tier: string
  total: number
  owned: number
  cost_usd: number
}

export interface PlayProgress {
  total: number
  owned: number
  locked_owned: number | null
  missing_count: number
  completion_pct: number | null
  cost_to_complete_usd: number
  /** Missing plays with no priced version — excluded from cost_to_complete_usd. */
  unpriced_missing_count: number
  stale_missing_pct: number | null
  by_tier: PlayTierBreakdown[]
}

const STALE_CONFIDENCE = new Set(["STALE", "LOW", "NO_DATA"])

/** The play an edition key belongs to: everything before the first "::". */
export function playKeyOf(editionKey: string): string {
  const i = editionKey.indexOf("::")
  return i === -1 ? editionKey : editionKey.slice(0, i)
}

/** True for a parallel printing's key (`setID:playID::subID`). */
export function isParallelKey(editionKey: string): boolean {
  return editionKey.includes("::")
}

/** True when any row in the list is a parallel of a play. */
export function checklistHasParallels(rows: readonly { route_slug: string }[]): boolean {
  return rows.some((r) => typeof r.route_slug === "string" && isParallelKey(r.route_slug))
}

/** A version's price under the "All moments" rule: floor, else FMV; null when neither is a positive number. */
export function versionPrice(r: Pick<ChecklistEditionRow, "floor_usd" | "fmv_usd">): number | null {
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
 * Group edition rows by play. The representative tile is the standard edition
 * (the key without "::"); if the scope holds only parallels of a play, the
 * lowest key stands in. `hasWallet` decides whether ownership is known at all:
 * without one every `owned*` field stays null, as in the per-edition read.
 */
export function groupChecklistByPlay(rows: readonly ChecklistEditionRow[], hasWallet: boolean): PlayTile[] {
  const groups = new Map<string, ChecklistEditionRow[]>()
  for (const r of rows) {
    if (typeof r.route_slug !== "string" || r.route_slug === "") continue
    const k = playKeyOf(r.route_slug)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }

  const out: PlayTile[] = []
  for (const [key, versions] of groups) {
    const sorted = [...versions].sort((a, b) => (a.route_slug < b.route_slug ? -1 : a.route_slug > b.route_slug ? 1 : 0))
    const rep = sorted.find((v) => !isParallelKey(v.route_slug)) ?? sorted[0]

    let cheapest: number | null = null
    let cheapestConfidence: string | null = null
    for (const v of sorted) {
      const p = versionPrice(v)
      if (p != null && (cheapest == null || p < cheapest)) {
        cheapest = p
        cheapestConfidence = typeof v.fmv_confidence === "string" ? v.fmv_confidence : null
      }
    }

    const ownedVersions = sorted.filter((v) => v.owned === true)
    const owned = hasWallet ? ownedVersions.length > 0 : null
    out.push({
      ...rep,
      play_key: key,
      version_count: sorted.length,
      owned,
      owned_versions: hasWallet ? ownedVersions.length : null,
      owned_count: hasWallet ? ownedVersions.reduce((s, v) => s + (typeof v.owned_count === "number" ? v.owned_count : 1), 0) : 0,
      owned_locked: hasWallet ? ownedVersions.some((v) => v.owned_locked === true) : null,
      play_cost_usd: cheapest,
      // The confidence that travels with the play is the one of the price it quotes.
      fmv_confidence: cheapest != null ? cheapestConfidence : (rep.fmv_confidence ?? null),
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
    return a.play_key < b.play_key ? -1 : a.play_key > b.play_key ? 1 : 0
  })
  return out
}

/** Header numbers for the play-level checklist, computed from grouped plays. */
export function computePlayProgress(plays: readonly PlayTile[], hasWallet: boolean): PlayProgress {
  const total = plays.length
  let owned = 0
  let locked = 0
  let cost = 0
  let unpriced = 0
  let stale = 0
  const tiers = new Map<string, { total: number; owned: number; cost: number }>()

  for (const p of plays) {
    const isOwned = hasWallet && p.owned === true
    const tier = typeof p.tier === "string" && p.tier ? p.tier : "UNKNOWN"
    const t = tiers.get(tier) ?? { total: 0, owned: 0, cost: 0 }
    t.total += 1
    if (isOwned) {
      owned += 1
      t.owned += 1
      if (p.owned_locked === true) locked += 1
    } else {
      if (p.play_cost_usd != null) {
        cost += p.play_cost_usd
        t.cost += p.play_cost_usd
      } else {
        unpriced += 1
      }
      if (p.play_cost_usd == null || (typeof p.fmv_confidence === "string" && STALE_CONFIDENCE.has(p.fmv_confidence))) stale += 1
    }
    tiers.set(tier, t)
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

/** URL value for the toggle: `?parallels=exclude` is "Ignore parallels"; anything else is "All moments". */
export type ParallelsMode = "all" | "exclude"
export function parseParallelsMode(v: string | null | undefined): ParallelsMode {
  return v === "exclude" ? "exclude" : "all"
}
