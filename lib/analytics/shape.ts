// Pure aggregation/shaping transforms for the per-collection analytics page
// (app/(collections)/[collection]/analytics/page.tsx). Extracted verbatim from
// the page's inline useMemo bodies + card enrichment blocks so this grouping /
// rounding / sort / percent-of-total math is exercised by the primary coverage
// gate (which measures lib/** but NOT the app/** page layer). Behaviour is
// byte-identical to the inline logic it replaced.
//
// Every function here is pure — deterministic, no hooks/JSX/fetch/DOM. The
// percent helpers all carry the divide-by-zero guard the page relied on (a
// missing guard silently renders NaN% where a real share belongs).

import { marketplaceLabel, marketplaceColor } from "@/lib/analytics/format"
import { seriesLabel } from "@/lib/series-label"
import { ownLookup } from "@/lib/safe-lookup"

// ── Acquisition-method → display bucket ─────────────────────────────────────
// get_acquisition_stats returns raw moment_acquisitions.acquisition_method
// values (CHECK-constrained to: marketplace, pack_pull, loan_default, gift,
// challenge_reward, airdrop, unknown, flowty_purchase, offer_accepted, mint).
// The Portfolio Origin Story only has four display buckets, so several methods
// have to be folded:
//   - `mint` is Pinnacle's primary-acquisition method (Pins are minted, not
//     pulled from a pack) — the same primary-drop concept as Top Shot's
//     `pack_pull`, so it belongs in the pack-pull bucket. Before this map it was
//     silently dropped, so every minted Pin vanished from the breakdown (a
//     Pinnacle wallet read "Packs Pulled: 0" while total_tracked still counted
//     the mints, so the numbers never reconciled).
//   - `flowty_purchase` / `offer_accepted` are both secondary-market buys.
//   - `trade` is Disney Pinnacle's peer-to-peer swap (see
//     lib/pinnacle/trade-classifier.ts). It gets its OWN bucket rather than
//     being folded into `marketplace`, because a trade has NO price: folding it
//     in would inflate "Marketplace Buys" with acquisitions nobody paid for, and
//     folding it into `gift` would claim the collector received it for nothing
//     when they in fact gave up Pins for it. Neither is true, so it is neither.
// `loan_default` / `airdrop` / `unknown` have no honest home among the buckets
// and are deliberately left uncategorized (counted in total_tracked, shown in
// none of the cards).
type AcquisitionBucket = "pack_pull" | "marketplace" | "challenge_reward" | "gift" | "trade"
const ACQUISITION_METHOD_BUCKET: Record<string, AcquisitionBucket> = {
  pack_pull: "pack_pull",
  mint: "pack_pull",
  marketplace: "marketplace",
  flowty_purchase: "marketplace",
  offer_accepted: "marketplace",
  challenge_reward: "challenge_reward",
  gift: "gift",
  trade: "trade",
}

export interface AcquisitionBucketCounts {
  pack_pull: number
  marketplace: number
  challenge_reward: number
  gift: number
  trade: number
}

// Fold a get_acquisition_stats `breakdown` array into the four display buckets.
// ACCUMULATES (not assigns) because multiple methods map to one bucket. Rows
// with an unmapped or malformed method are skipped; ownLookup keeps a crafted
// prototype-name method ("constructor", …) from resolving to a function.
export function bucketAcquisitionCounts(
  breakdown: Array<{ method?: string | null; count?: number | string | null }> | null | undefined
): AcquisitionBucketCounts {
  const counts: AcquisitionBucketCounts = { pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0 }
  for (const b of breakdown ?? []) {
    const bucket = ownLookup(ACQUISITION_METHOD_BUCKET, b?.method)
    if (bucket) counts[bucket] += Number(b?.count) || 0
  }
  return counts
}

// Per-moment acquisition badge label (the wallet-row / cost-basis "how acquired"
// chip). Same method vocabulary as bucketAcquisitionCounts — `mint` (Pinnacle),
// `flowty_purchase` and `offer_accepted` were all missing from the two inline
// copies of this map, so a minted Pin rendered NO badge. `unknown` and any
// unmapped method deliberately return null (no chip). ownLookup keeps a crafted
// prototype-name method from resolving to a function.
const ACQUISITION_METHOD_LABEL: Record<string, string | null> = {
  marketplace: "Bought",
  flowty_purchase: "Bought",
  offer_accepted: "Bought",
  pack_pull: "Pack",
  mint: "Pack",
  loan_default: "Loan",
  gift: "Gift",
  // ⚠ NOT "Bought". resolveMomentPnlBasis() trusts only "Bought"/"Loan" as a
  // cost basis, so labelling a trade "Bought" against its absent buy_price would
  // render a 100%-profit moment. "Traded" yields no P&L, which is the truth.
  trade: "Traded",
  challenge_reward: "Reward",
  airdrop: "Airdrop",
  unknown: null,
}
export function acquisitionMethodLabel(method: string | null | undefined): string | null {
  return ownLookup(ACQUISITION_METHOD_LABEL, method) ?? null
}

// volumeByTier — drop UNKNOWN/zero-volume tiers, round volume to cents, keep
// the tier name as the chart label.
export function buildVolumeByTier(
  rows: Array<{ tier: string; volume: number }> | null | undefined
): Array<{ name: string; value: number }> {
  if (!rows) return []
  return rows
    .filter((t) => t.tier && t.tier !== "UNKNOWN" && Number(t.volume) > 0)
    .map((t) => ({ name: t.tier, value: Math.round(Number(t.volume) * 100) / 100 }))
}

// marketplaceBreakdown — fold the per-day rows into one row per marketplace
// (case-normalized key, "unknown" fallback), round volume to cents, drop empty
// marketplaces, sort by volume desc.
export function aggregateMarketplaceDaily(
  daily: Array<{ marketplace: string; saleCount: number; volume: number }> | null | undefined
): Array<{ marketplace: string; volume: number; transactions: number }> {
  if (!daily || daily.length === 0) return []
  const acc = new Map<string, { volume: number; transactions: number }>()
  for (const row of daily) {
    const mp = (row.marketplace || "unknown").toLowerCase()
    const slot = acc.get(mp) ?? { volume: 0, transactions: 0 }
    slot.volume += Number(row.volume ?? 0)
    slot.transactions += Number(row.saleCount ?? 0)
    acc.set(mp, slot)
  }
  return Array.from(acc.entries())
    .map(([marketplace, vals]) => ({
      marketplace,
      volume: Math.round(vals.volume * 100) / 100,
      transactions: vals.transactions,
    }))
    .filter((r) => r.volume > 0 || r.transactions > 0)
    .sort((a, b) => b.volume - a.volume)
}

// seriesVolumeBars — label each series row, round volume to cents, drop
// zero-volume series, sort by volume desc.
export function buildSeriesVolumeBars(
  rows:
    | Array<{ series: number | null; volume: number; avg_price: number; sale_count: number }>
    | null
    | undefined
): Array<{ name: string; volume: number; avg_price: number; sale_count: number }> {
  if (!rows) return []
  return rows
    .map((s) => ({
      name: seriesLabel(s.series),
      volume: Math.round(Number(s.volume) * 100) / 100,
      avg_price: Number(s.avg_price) || 0,
      sale_count: Number(s.sale_count) || 0,
    }))
    .filter((s) => s.volume > 0)
    .sort((a, b) => b.volume - a.volume)
}

// MarketplaceBreakdownCard enrichment — attach label/color + share-of-total
// percentages to each already-aggregated marketplace row.
export function enrichMarketplaceRows(
  rows: Array<{ marketplace: string; volume: number; transactions: number }>
): Array<{
  marketplace: string
  volume: number
  transactions: number
  label: string
  color: string
  volumePct: number
  txPct: number
}> {
  const totalVolume = rows.reduce((s, r) => s + r.volume, 0)
  const totalTx = rows.reduce((s, r) => s + r.transactions, 0)
  return rows.map((r) => ({
    ...r,
    label: marketplaceLabel(r.marketplace),
    color: marketplaceColor(r.marketplace),
    volumePct: totalVolume > 0 ? (r.volume / totalVolume) * 100 : 0,
    txPct: totalTx > 0 ? (r.transactions / totalTx) * 100 : 0,
  }))
}

// FmvHealthCard totals — sum the per-tier confidence/edition/fmv counts, then
// derive HIGH/LOW confidence share (guarded against a zero denominator).
export function computeFmvHealth(
  rows:
    | Array<{
        high_conf_count: number
        low_conf_count: number
        edition_count: number
        total_fmv_usd: number
      }>
    | null
    | undefined
): { high: number; low: number; edition: number; fmv: number; total: number; highPct: number; lowPct: number } {
  const out = { high: 0, low: 0, edition: 0, fmv: 0 }
  for (const r of rows ?? []) {
    out.high += Number(r.high_conf_count) || 0
    out.low += Number(r.low_conf_count) || 0
    out.edition += Number(r.edition_count) || 0
    out.fmv += Number(r.total_fmv_usd) || 0
  }
  const total = out.high + out.low
  const highPct = total > 0 ? (out.high / total) * 100 : 0
  const lowPct = total > 0 ? (out.low / total) * 100 : 0
  return { ...out, total, highPct, lowPct }
}

// Acquisition breakdown — the pack-pull / marketplace / reward / gift / trade
// split as share-of-total percentages, plus the "not indexed" flag (no acq
// object, or total_tracked 0 — the honesty gate that hides a zeroed breakdown).
//
// ⚠ `trade_count` is OPTIONAL on the input and defaults to 0, because this
// function is called with payloads built before the Pinnacle trade lane existed.
// The default is safe here — and only here — because a caller that omits the
// field is one whose acquisitions genuinely carry no trades, so the 0 is a real
// count rather than a failed read standing in for one. It must NOT be copied to
// a path where the field could be absent because a READ failed.
export function computeAcquisitionBreakdown(
  acq:
    | {
        pack_pull_count: number
        marketplace_count: number
        challenge_reward_count: number
        gift_count: number
        trade_count?: number
        total_tracked: number
      }
    | null
): {
  acqTotal: number
  pctPack: number
  pctMarket: number
  pctReward: number
  pctGift: number
  pctTrade: number
  acquisitionNotIndexed: boolean
} {
  const tradeCount = acq?.trade_count ?? 0
  const acqTotal = acq
    ? acq.pack_pull_count + acq.marketplace_count + acq.challenge_reward_count + acq.gift_count + tradeCount
    : 0
  const pctPack = acq && acqTotal > 0 ? (acq.pack_pull_count / acqTotal) * 100 : 0
  const pctMarket = acq && acqTotal > 0 ? (acq.marketplace_count / acqTotal) * 100 : 0
  const pctReward = acq && acqTotal > 0 ? (acq.challenge_reward_count / acqTotal) * 100 : 0
  const pctGift = acq && acqTotal > 0 ? (acq.gift_count / acqTotal) * 100 : 0
  const pctTrade = acq && acqTotal > 0 ? (tradeCount / acqTotal) * 100 : 0
  const acquisitionNotIndexed = !acq || (acq.total_tracked ?? 0) === 0
  return { acqTotal, pctPack, pctMarket, pctReward, pctGift, pctTrade, acquisitionNotIndexed }
}
