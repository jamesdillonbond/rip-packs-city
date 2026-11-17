// Shared pure logic for the TOP SHOT pack-EV edge function
// (compute-topshot-pack-ev). This is the collection the P0 fabricated-pack-EV
// incident lived on (a $4.99 pack once published a $2,651 "Actual EV"), and it
// is the ONE pack-EV writer whose post-RPC shaping never got extracted — the
// AllDay/Golazos/Pinnacle writers share _shared/pack-ev-supply-weighted, but
// Top Shot has packOdds-driven survivor-pool weighting + its own inline EV
// shaping that nothing pinned.
//
// Top Shot delegates the weighted-mean/median EV itself to the DB RPC
// `compute_pack_ev_per_edition_weighted` (pinned separately by the SQL invariant
// supabase/tests/compute_pack_ev_per_edition_weighted.sql). What lives ONLY in
// the edge fn — and therefore what this module pins — is:
//
//   - survivorPoolWeight   — the remaining/totalUnopened drop_weight per edition
//   - mergeRemainingByEdition — the merge-by-edition-uuid (sum count + remaining)
//                               that de-dupes the one-node-per-slot packEditionsV3
//                               shape before the pool insert
//   - clampTopshotEv       — the [-10000, 1000000] clamp on every persisted $ value
//   - shapeTopshotEvRow    — the post-RPC shaping: pack_ev, is_positive_ev,
//                            value_ratio, depletion_pct, typical_ev — the exact
//                            arithmetic that decides what a collector SEES
//
// Ported VERBATIM from compute-topshot-pack-ev/index.ts (v23). The deployed edge
// function still carries the inline copies; rewiring it to import from here is a
// deploy-gated (Deno deploy) follow-up, and CLAUDE.md marks that function as
// deliberately un-redeployed, so until an operator chooses to redeploy it the
// source-drift guard in __tests__/edge-topshot-pack-ev.test.ts fails CI if an
// inline copy's canonical expression is edited without mirroring it here.

/**
 * Survivor-biased drop_weight for one edition in a Top Shot pack pool: the
 * edition's remaining (unpulled) share of the pack's total unopened supply.
 * Mirrors `weight = f.totalUnopened > 0 ? m.remaining / f.totalUnopened : 0`.
 * Returns 0 (never NaN/Infinity) when total unopened is 0/unknown, so an
 * exhausted pack can't emit a garbage weight.
 *
 * NOTE the RPC prefers each edition's ORIGINAL mint-time count (orig_drop_weight)
 * when present, computing EV over the honest fresh-pack distribution; this
 * survivor weight is the fallback. Both are pool inputs, not the EV itself.
 */
export function survivorPoolWeight(remaining: number, totalUnopened: number): number {
  return totalUnopened > 0 ? remaining / totalUnopened : 0
}

export interface EditionCountNode {
  /** resolved edition uuid — the merge key */
  edId: string
  /** original mint-time draw count for this node (→ orig_drop_weight) */
  count: number
  /** remaining (unpulled) count for this node (→ survivor weight numerator) */
  remaining: number
}

export interface MergedEditionCount {
  edId: string
  count: number
  remaining: number
}

/**
 * packEditionsV3 returns one node PER SLOT, so an edition drawn by multiple slots
 * appears multiple times. This sums count + remaining per resolved edition uuid
 * BEFORE the pool insert — duplicate edition_ids in one insert chunk violate
 * pack_drop_pool's PK (edition_id, slot_name='default') and would fail the whole
 * chunk, leaving the pool (and therefore the EV) empty. Preserves first-seen
 * order. `count`/`remaining` default to 0 for a node missing them.
 */
export function mergeRemainingByEdition(nodes: EditionCountNode[]): MergedEditionCount[] {
  const merged = new Map<string, MergedEditionCount>()
  for (const node of nodes) {
    const cur = merged.get(node.edId)
    if (cur) {
      cur.count += node.count ?? 0
      cur.remaining += node.remaining ?? 0
    } else {
      merged.set(node.edId, {
        edId: node.edId,
        count: node.count ?? 0,
        remaining: node.remaining ?? 0,
      })
    }
  }
  return [...merged.values()]
}

/**
 * The clamp applied to every persisted dollar value (gross_ev, pack_ev,
 * typical_ev). Bounds to [-10000, 1000000] — the same window as
 * compute_pack_ev_per_edition_weighted / pack_ev_history's BETWEEN filter, so a
 * runaway value can never land in the table (the row is clamped, not dropped).
 * Bound ORDER here mirrors the Top Shot inline copy exactly
 * (Math.max(-10000, Math.min(1000000, v))); it is numerically identical to the
 * supply-weighted module's clampEv but kept literal for the drift guard.
 */
export function clampTopshotEv(v: number): number {
  return Math.max(-10000, Math.min(1000000, v))
}

export type PriceSource = "primary" | "secondary" | "min" | "none"

export interface TopshotEvShapeInput {
  /** RPC gross_ev (Actual EV = slots × weighted-MEAN moment value) */
  grossEv: number
  /** the dual-resolved pack price the EV was computed against */
  packPrice: number
  /** dual-price source; "none" must suppress is_positive_ev */
  priceSource: PriceSource
  /** total packs ever minted for this dist (depletion denominator) */
  totalPackCount: number
  /** packs still sealed (depletion numerator = total - this) */
  totalUnopened: number
  /** RPC typical_pull_ev (Typical Pull EV = slots × weighted-MEDIAN); may be null */
  typicalPullEv: number | null | undefined
}

export interface TopshotEvShape {
  /** gross_ev clamped for persistence */
  grossEv: number
  /** pack_ev = gross_ev − packPrice, rounded 2dp, then clamped */
  packEv: number
  /** true only when a real price exists AND pack_ev > 0 */
  isPositiveEv: boolean
  /** gross_ev / packPrice, 3dp; null when packPrice is 0 (no false ∞) */
  valueRatio: number | null
  /** sold %, clamped [0,100]; null when total supply unknown (never a false 0%) */
  depletionPct: number | null
  /** typical_ev clamped, or null when the RPC returned no median */
  typicalEv: number | null
}

/**
 * The post-RPC EV shaping, ported verbatim from compute-topshot-pack-ev
 * (lines ~1417–1447 of index.ts). This is the arithmetic that decides what a
 * collector actually sees on the pack page / /packs board, so its invariants are
 * the ones the P0 was about:
 *
 *   - pack_ev is gross_ev − packPrice (2dp), NOT whatever the RPC returned — the
 *     edge fn overrides the RPC's pack_ev so the anchor is always the persisted
 *     dual price.
 *   - is_positive_ev is false whenever price_source is "none" (an unpriced pack
 *     is never "positive EV"), regardless of a raw positive gross_ev.
 *   - value_ratio is null when there's no price (division guard), so the UI shows
 *     "—" instead of a fabricated multiple.
 *   - every dollar value is clamped to [-10000, 1e6] before it can be persisted.
 */
export function shapeTopshotEvRow(input: TopshotEvShapeInput): TopshotEvShape {
  const grossEv = Number(input.grossEv)
  const packEv = Math.round((grossEv - input.packPrice) * 100) / 100
  const isPositiveEv = input.priceSource !== "none" && packEv > 0
  const valueRatio = input.packPrice > 0
    ? Math.round((grossEv / input.packPrice) * 1000) / 1000
    : null

  const depletionPct = input.totalPackCount > 0
    ? Math.min(100, Math.max(0, Math.round(((input.totalPackCount - input.totalUnopened) / input.totalPackCount) * 100)))
    : null

  const typicalEv = input.typicalPullEv != null
    ? clampTopshotEv(Number(input.typicalPullEv))
    : null

  return {
    grossEv: clampTopshotEv(grossEv),
    packEv: clampTopshotEv(packEv),
    isPositiveEv,
    valueRatio,
    depletionPct,
    typicalEv,
  }
}
