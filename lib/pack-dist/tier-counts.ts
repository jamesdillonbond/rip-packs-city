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

// ── Atlas (live) tier counts ─────────────────────────────────────────────────
//
// WHY (2026-10-14). The v20 payload above froze on 2026-08-28 (823 dists, the
// newest 47 days old), so every Top Shot pack page published month-old
// "packs remaining" and pull odds. The Atlas pack-supply lane
// (topshot_pack_supply_tick → topshot_atlas_dists) has re-read Dapper's own
// DistributionService for every Top Shot dist since 10-03: 3,169 dists, all
// summarised within 3 days. Dist 5048 rendered "142 of 22,068 · as of 48d ago"
// while Atlas read 134 that morning. The page now prefers the Atlas payload
// whenever it is the newer of the two.
//
// The same floor guards it as guards v20: a payload claiming FEWER packs opened
// than we had already watched open on chain (pack_rips, a lower bound) is
// refuted and dropped WHOLE (measured: 9 of 3,169). Nothing is mixed — the
// counts and the stamp always come from one source.

export interface AtlasDistCountsInput {
  summary_fetched_at: string | null
  unopened_count: number | string | null
  total_pack_count: number | string | null
  remaining_by_tier: unknown
  original_by_tier: unknown
}

function finiteNum(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function numericTierMap(v: unknown): Record<string, number> | null {
  const m = tierMap(v)
  if (!m) return null
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(m)) {
    const n = finiteNum(raw)
    if (n == null) return null
    out[k] = n
  }
  return out
}

/** The Atlas payload as TierCounts, or null when it is absent, incomplete, or
 * contradicted by the opens we observed on chain. */
export function atlasTierCounts(
  atlas: AtlasDistCountsInput | null | undefined,
  observedPacksOpened: number | string | null | undefined,
): TierCounts | null {
  if (!atlas || typeof atlas.summary_fetched_at !== "string" || !Number.isFinite(Date.parse(atlas.summary_fetched_at))) return null
  const unopened = finiteNum(atlas.unopened_count)
  const total = finiteNum(atlas.total_pack_count)
  const remainingByTier = numericTierMap(atlas.remaining_by_tier)
  const originalByTier = numericTierMap(atlas.original_by_tier)
  // unopened > total needs no check of its own: it makes the opened count
  // negative, which the floor below refutes.
  if (unopened == null || total == null || total <= 0 || unopened < 0) return null
  if (!remainingByTier || !originalByTier) return null
  const observed = finiteNum(observedPacksOpened) ?? 0
  if (total - unopened < observed) return null
  return {
    updatedAt: atlas.summary_fetched_at,
    totalUnopened: unopened,
    totalPackCount: total,
    remainingByTier,
    originalByTier,
  }
}

/**
 * Which tier-count payload the page renders: the Atlas one when it is valid and
 * at least as new as the v20 one, else readTierCounts' answer (which may be the
 * all-null NONE). `contradicted` is the v20 verdict and applies only to v20.
 */
export function pickTierCounts(
  metadata: Record<string, unknown> | null | undefined,
  contradicted: boolean | null | undefined,
  atlas: AtlasDistCountsInput | null | undefined,
  observedPacksOpened: number | string | null | undefined,
): TierCounts {
  const v20 = readTierCounts(metadata, contradicted)
  const live = atlasTierCounts(atlas, observedPacksOpened)
  if (!live) return v20
  if (v20.updatedAt && Date.parse(v20.updatedAt) > Date.parse(live.updatedAt!)) return v20
  return live
}
