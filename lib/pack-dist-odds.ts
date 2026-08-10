// Pure pull-odds math for the pack-distribution page's "Pull odds by tier" panel
// (app/(collections)/[collection]/pack/dist/[distId]/page.tsx — the ~2,740-line
// server monolith neither coverage gate measures). This is the fabricated-data
// class: a wrong denominator or ordering here prints false pull odds on a public
// pack page, so it's worth pinning. Bodies are byte-identical to the page's
// TierOddsPanel; the page imports these.

import { splitEditionName } from "@/lib/pack-dist-format"

/** Rarity display order (Top Shot + cross-collection tiers). */
export const TIER_RARITY_ORDER = ["ultimate", "legendary", "anthology", "autograph", "rare", "fandom", "common"]

/** Denominator for pull odds: total remaining POOL ENTRIES across all tiers. */
export function sumPoolRemaining(remainingByTier: Record<string, number>): number {
  return Object.values(remainingByTier).reduce<number>((s, v) => s + (Number(v) || 0), 0)
}

/** Tiers to render, in rarity order, then any non-standard tiers with supply
 * appended in their original key order — only tiers whose ORIGINAL count > 0. */
export function orderedTiersWithSupply(
  originalByTier: Record<string, number>,
  order: string[] = TIER_RARITY_ORDER,
): string[] {
  const tiers = order.filter((t) => Number(originalByTier[t] ?? 0) > 0)
  for (const k of Object.keys(originalByTier)) {
    if (!order.includes(k) && Number(originalByTier[k] ?? 0) > 0) tiers.push(k)
  }
  return tiers
}

/** The "% of pool" cell label. null pool -> "—"; a positive sub-0.1% share ->
 * "<0.1%"; otherwise 0 decimals at/above 10%, 1 decimal below. */
export function pctOfPoolLabel(remaining: number, poolRemaining: number): string {
  const pctOfPool = poolRemaining > 0 ? (remaining / poolRemaining) * 100 : null
  if (pctOfPool === null) return "—"
  if (pctOfPool < 0.1 && pctOfPool > 0) return "<0.1%"
  return `${pctOfPool.toFixed(pctOfPool >= 10 ? 0 : 1)}%`
}

// ── Dual-price KPI derivation (DualPriceKpi) ────────────────────────────────

export type PriceSource = "primary" | "secondary" | "min" | "none" | null

export interface DualPriceInput {
  primaryPrice: number | null
  secondaryAsk: number | null
  priceSource: PriceSource
  primaryAvailable: boolean
  secondaryAvailable: boolean
}

export interface DualPriceDerived {
  /** priceSource === null → the legacy single-line fallback KPI. */
  legacy: boolean
  /** Primary leg has a real, positive, available price (else "SOLD OUT"). */
  primaryLive: boolean
  /** Secondary ask has a real, positive, available price (else "—"). */
  secondaryLive: boolean
  /** Primary is (one of) the chosen anchor(s) — the red-highlighted leg. */
  primaryAnchor: boolean
  /** Secondary is (one of) the chosen anchor(s). */
  secondaryAnchor: boolean
}

/** Decide which pack-price legs are live and which is the anchor. Byte-identical
 * to DualPriceKpi's inline derivation. */
export function deriveDualPrice(input: DualPriceInput): DualPriceDerived {
  const { primaryPrice, secondaryAsk, priceSource, primaryAvailable, secondaryAvailable } = input
  if (priceSource === null) {
    return { legacy: true, primaryLive: false, secondaryLive: false, primaryAnchor: false, secondaryAnchor: false }
  }
  const primaryLive = primaryAvailable && primaryPrice != null && primaryPrice > 0
  const secondaryLive = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
  const primaryAnchor = priceSource === "primary" || priceSource === "min"
  const secondaryAnchor = priceSource === "secondary" || priceSource === "min"
  return { legacy: false, primaryLive, secondaryLive, primaryAnchor, secondaryAnchor }
}

// ── Top-Pulls edition-EV engine (fetchTopPulls' pure core) ──────────────────
// The dist page fetches the top-50 pool rows, their editions, and per-edition
// FMV, then computes each edition's contribution to one pack's gross EV. That
// math is the fabricated-data class too: the denominator choice and the
// EV formula must reconcile with the cached Gross EV KPI, and a wrong sort
// mis-orders the public "Top Pulls" table. This is the page's inline core,
// byte-identical; the page passes in the already-fetched rows.

/** A pack_drop_pool row (edition_id + its drop weight). */
export interface TopPullPoolRow {
  edition_id: string
  drop_weight: string | number | null
}

/** The subset of `editions` columns the Top-Pulls table reads. */
export interface TopPullEdition {
  id: string
  name: string | null
  tier: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
}

/** A per-edition FMV row (from get_fmv_for_editions). */
export interface TopPullFmvRow {
  edition_id: string
  fmv_usd: string | number | null
}

export interface TopPull {
  editionId: string
  player: string
  setName: string
  tier: string | null
  dropWeight: number
  probabilityPct: number | null
  fmvUsd: number | null
  editionEv: number | null
  externalId: string | null
}

/**
 * Compute the "Top Pulls" rows for a pack distribution from already-fetched data.
 *
 * Probability denominator: prefer the cached `totalUnopened` (true contents
 * remaining); otherwise the full-pool drop_weight sum. Never sum only the
 * top-50 weights — that inflates % (Pack audit B2) — so probability is null when
 * neither denominator is available.
 *
 *   probabilityPct = drop_weight / denom × 100
 *   editionEv      = FMV × (drop_weight / denom) × slots
 *
 * editionEv reconciles with the cached pack_ev_history Gross EV KPI (slots ×
 * Σ per-edition probability × FMV over the full pool) — NOT the raw
 * fmv × drop_weight that Pack D3 removed. Sorted by editionEv desc (null last),
 * tie-broken by drop_weight desc, then sliced to `limit` (default 10).
 */
export function computeTopPulls(opts: {
  pool: TopPullPoolRow[]
  editions: TopPullEdition[]
  fmv: TopPullFmvRow[]
  fullPoolWeight: number
  totalUnopened: number | null
  slots: number | null
  limit?: number
}): TopPull[] {
  const { pool, editions, fmv, fullPoolWeight, totalUnopened, slots } = opts
  const limit = opts.limit ?? 10

  const editionsById = new Map<string, TopPullEdition>()
  for (const e of editions) editionsById.set(e.id, e)

  const fmvById = new Map<string, number>()
  for (const r of fmv) {
    const v = r.fmv_usd == null ? null : Number(r.fmv_usd)
    if (v !== null && Number.isFinite(v) && v > 0) fmvById.set(r.edition_id, v)
  }

  const denom = totalUnopened && totalUnopened > 0
    ? totalUnopened
    : fullPoolWeight > 0
      ? fullPoolWeight
      : null

  const pulls: TopPull[] = pool.map((r) => {
    const ed = editionsById.get(r.edition_id)
    const dropWeight = Number(r.drop_weight ?? 0)
    const fmvVal = fmvById.get(r.edition_id) ?? null
    const probPct = denom ? (dropWeight / denom) * 100 : null
    const ev = fmvVal !== null && denom && denom > 0 && slots && slots > 0
      ? fmvVal * (dropWeight / denom) * slots
      : null
    // Prefer the clean denormalized columns. editions.name glues the series
    // number onto the set name for some Top Shot rows ("Base Set6"), so
    // splitting it gives a corrupted set cell (Pack 1e) — only fall back to
    // the split when the denorm columns are empty.
    const split = splitEditionName(ed?.name ?? null)
    const player = ed?.player_name?.trim() || split.player
    const setName = ed?.set_name?.trim() || split.setName
    return {
      editionId: r.edition_id,
      player,
      setName,
      tier: ed?.tier ?? null,
      dropWeight,
      probabilityPct: probPct,
      fmvUsd: fmvVal,
      editionEv: ev,
      externalId: ed?.external_id ?? null,
    }
  })

  pulls.sort((a, b) => {
    const ae = a.editionEv == null ? -Infinity : a.editionEv
    const be = b.editionEv == null ? -Infinity : b.editionEv
    if (ae !== be) return be - ae
    return b.dropWeight - a.dropWeight
  })

  return pulls.slice(0, limit)
}
