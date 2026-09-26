// lib/pack-dist/tier-counts.ts
//
// Which v20 tier-count metadata the pack page may publish.
//
// WHY (2026-09-25). compute-topshot-pack-ev v20 wrote per-pack counts into
// pack_distributions.metadata (total_pack_count, total_unopened,
// remaining_by_tier, original_counts_by_tier, tier_counts_updated_at) and its
// lane has been dead since 2026-08-28. Checked against the opens we observed
// on-chain (pack_rips — a LOWER bound), 42 of 823 dists' counts claim fewer
// opened than we had already watched open by the counts' own stamp; 13 claim
// NONE opened (dist 8643 rendered "6,000 of 6,000 remaining" with 5,727 opens
// before its stamp). pack_table_rows carries the verdict as
// `tier_counts_contradicted` (migration 20260926050031, refreshed daily).
//
// A contradicted payload is dropped WHOLE — the pack count, the unopened count,
// both tier maps and their stamp come from one write, so none of them is
// trustworthy once one is refuted. Nothing replaces it: the observed opens are
// a floor, never the count.

export interface TierCounts {
  updatedAt: string | null
  totalUnopened: unknown
  totalPackCount: unknown
  remainingByTier: Record<string, number> | null
  originalByTier: Record<string, number> | null
}

const NONE: TierCounts = {
  updatedAt: null,
  totalUnopened: null,
  totalPackCount: null,
  remainingByTier: null,
  originalByTier: null,
}

function tierMap(v: unknown): Record<string, number> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : null
}

/**
 * The tier-count payload to render, or all-null when there is none or when the
 * view says our observed opens contradict it. `contradicted` is the row's
 * `tier_counts_contradicted`; only `true` drops the payload (an absent column —
 * a synthesized row, an older view — keeps today's behaviour).
 */
export function readTierCounts(
  metadata: Record<string, unknown> | null | undefined,
  contradicted: boolean | null | undefined,
): TierCounts {
  if (!metadata || contradicted === true) return NONE
  return {
    updatedAt: typeof metadata.tier_counts_updated_at === "string" ? metadata.tier_counts_updated_at : null,
    totalUnopened: metadata.total_unopened ?? null,
    totalPackCount: metadata.total_pack_count ?? null,
    remainingByTier: tierMap(metadata.remaining_by_tier),
    originalByTier: tierMap(metadata.original_counts_by_tier),
  }
}

/**
 * Sub-label for the Packs remaining tile when the counts were dropped and we
 * still watched packs open: "5,877+ opened on-chain". A floor, stated as one.
 */
export function observedOpensFloorLabel(
  contradicted: boolean | null | undefined,
  observed: number | null | undefined,
): string | null {
  if (contradicted !== true || observed == null || !Number.isFinite(observed) || observed <= 0) return null
  return `${Math.trunc(observed).toLocaleString("en-US")}+ opened on-chain`
}
