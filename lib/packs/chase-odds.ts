// lib/packs/chase-odds.ts
//
// "Chase left" — where the high-tier moments of a Top Shot drop are STILL SEALED,
// and whether a pack bought today is richer or poorer in them than one bought at
// launch.
//
// WHY (2026-11-01). The Grails view prices a drop's whole POOL; the pack page shows
// one dist's live tier bars. Neither answers the collector's cross-pack question:
// "Rookie Year Royalty has 1 Legendary left inside 18 sealed packs — that is ~5.6
// per 100 packs, 14× the launch rate." Dapper's DistributionService (Atlas lane →
// topshot_atlas_dists) already reports remaining_by_tier / original_by_tier and the
// unopened / total pack counts for every dist, re-read every ~2 days.
//
// WHAT THE NUMBER IS — and is not.
//   per100Now    = 100 × remaining_T / unopened packs   (average, today)
//   per100Launch = 100 × original_T  / total packs      (average, at launch)
//   vsLaunch     = per100Now / per100Launch
// It is an AVERAGE density, not a per-pack probability: Dapper's slot rules decide
// how those moments are spread across packs (a pack may hold two, most hold none),
// so "5.6 per 100 packs" is never published as "5.6 % chance". The UI says so.
//
// HONESTY RULES (CLAUDE.md "Honesty"):
//   · The counts come from ONE source with ONE stamp and are validated by the same
//     floor the pack page uses (atlasTierCounts): a payload claiming FEWER packs
//     opened than we already watched open on chain (pack_rips, a lower bound) is
//     refuted and the row is DROPPED, never repaired or mixed with another source.
//   · A payload older than CHASE_MAX_AGE_DAYS is dropped, not shown as current;
//     every row carries its own as-of.
//   · remaining > original for the tier, or a tier with no launch supply, is an
//     internally inconsistent payload → dropped.
//   · "Buyable" is an affirmative claim: it needs an availability flag observed
//     inside EV_SNAPSHOT_MAX_AGE_HOURS (the same bar as the Grails view's filter).

import { atlasTierCounts, type AtlasDistCountsInput } from "@/lib/pack-dist/tier-counts"

export const CHASE_TIERS = ["ultimate", "legendary", "rare"] as const
export type ChaseTier = (typeof CHASE_TIERS)[number]

// Default "vsLaunch": ranked by "now" the head is every guaranteed-Legendary
// pack (2 per pack by design, read 2026-11-01) — true, and tells nobody anything.
export const CHASE_SORTS = ["vsLaunch", "now", "remaining"] as const
export type ChaseSort = (typeof CHASE_SORTS)[number]

/** Atlas re-reads every dist within ~3 days; a week-old payload is not "today". */
export const CHASE_MAX_AGE_DAYS = 7

export function parseChaseTier(v: string | null | undefined): ChaseTier {
  const t = (v ?? "").trim().toLowerCase()
  return (CHASE_TIERS as readonly string[]).includes(t) ? (t as ChaseTier) : "legendary"
}

export function parseChaseSort(v: string | null | undefined): ChaseSort {
  const s = (v ?? "").trim()
  return (CHASE_SORTS as readonly string[]).includes(s) ? (s as ChaseSort) : "vsLaunch"
}

export interface AtlasChaseInput extends AtlasDistCountsInput {
  dist_id: string
  title: string | null
}

export interface PackMetaInput {
  dist_id: string
  title: string | null
  image_url: string | null
  primary_available: boolean | null
  secondary_available: boolean | null
  ev_snapshotted_at: string | null
  observed_packs_opened: number | string | null
}

export interface ChaseRow {
  distId: string
  title: string
  imageUrl: string | null
  tier: ChaseTier
  remaining: number
  original: number
  unopened: number
  totalPacks: number
  per100Now: number
  per100Launch: number
  /** null only when the launch rate is 0 — which buildChaseRows already drops. */
  vsLaunch: number | null
  buyable: boolean
  asOf: string
}

export interface BuildChaseOptions {
  tier: ChaseTier
  sort: ChaseSort
  buyableOnly: boolean
  nowMs: number
  availabilityMaxAgeHours: number
}

export interface BuildChaseResult {
  rows: ChaseRow[]
  /** Payloads dropped because our observed on-chain opens refute them. */
  refuted: number
  /** Payloads dropped because they were older than CHASE_MAX_AGE_DAYS. */
  stale: number
}

/** Fresh affirmative availability, never inferred from a null or an old stamp. */
export function isBuyableNow(meta: PackMetaInput | undefined, nowMs: number, maxAgeHours: number): boolean {
  if (!meta) return false
  if (meta.primary_available !== true && meta.secondary_available !== true) return false
  const t = meta.ev_snapshotted_at ? Date.parse(meta.ev_snapshotted_at) : NaN
  return Number.isFinite(t) && nowMs - t <= maxAgeHours * 3600 * 1000
}

export function buildChaseRows(
  atlas: readonly AtlasChaseInput[],
  metaById: ReadonlyMap<string, PackMetaInput>,
  opts: BuildChaseOptions,
): BuildChaseResult {
  const maxAgeMs = CHASE_MAX_AGE_DAYS * 86_400_000
  let refuted = 0
  let stale = 0
  const rows: ChaseRow[] = []

  for (const a of atlas) {
    const fetchedMs = typeof a.summary_fetched_at === "string" ? Date.parse(a.summary_fetched_at) : NaN
    if (!Number.isFinite(fetchedMs) || opts.nowMs - fetchedMs > maxAgeMs) {
      stale++
      continue
    }
    const meta = metaById.get(a.dist_id)
    const counts = atlasTierCounts(a, meta?.observed_packs_opened ?? null)
    if (!counts) {
      // atlasTierCounts returns null for an incomplete payload as well as a
      // refuted one; count only the refutation (opened < observed floor).
      const unopened = Number(a.unopened_count)
      const total = Number(a.total_pack_count)
      const observed = Number(meta?.observed_packs_opened ?? 0)
      if (Number.isFinite(unopened) && Number.isFinite(total) && total > 0 && Number.isFinite(observed) && total - unopened < observed) refuted++
      continue
    }
    const unopened = counts.totalUnopened as number
    const totalPacks = counts.totalPackCount as number
    const remaining = counts.remainingByTier?.[opts.tier]
    const original = counts.originalByTier?.[opts.tier]
    if (remaining == null || original == null) continue
    if (!(remaining > 0) || !(unopened > 0) || !(original > 0)) continue
    if (remaining > original || unopened > totalPacks) continue

    const buyable = isBuyableNow(meta, opts.nowMs, opts.availabilityMaxAgeHours)
    if (opts.buyableOnly && !buyable) continue

    const per100Now = (100 * remaining) / unopened
    const per100Launch = (100 * original) / totalPacks
    rows.push({
      distId: a.dist_id,
      title: (meta?.title || a.title || `Pack #${a.dist_id}`).trim(),
      imageUrl: meta?.image_url ?? null,
      tier: opts.tier,
      remaining,
      original,
      unopened,
      totalPacks,
      per100Now,
      per100Launch,
      vsLaunch: per100Launch > 0 ? per100Now / per100Launch : null,
      buyable,
      asOf: counts.updatedAt as string,
    })
  }

  const key = (r: ChaseRow): number =>
    opts.sort === "vsLaunch" ? (r.vsLaunch ?? -1) : opts.sort === "remaining" ? r.remaining : r.per100Now
  rows.sort((x, y) => key(y) - key(x) || y.per100Now - x.per100Now || x.distId.localeCompare(y.distId, "en", { numeric: true }))
  return { rows, refuted, stale }
}

/** "5.6", "0.42", "120" — enough precision to compare, never false precision. */
export function fmtPer100(v: number): string {
  if (!Number.isFinite(v)) return "—"
  if (v >= 10) return v.toFixed(0)
  if (v >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

/** "14× launch", "0.5× launch", "≈ launch". */
export function fmtVsLaunch(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—"
  if (v >= 0.9 && v <= 1.1) return "≈ launch rate"
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}× launch rate`
}
