'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import React, { useMemo, useState } from 'react'
import { derivePackAvailability } from '@/lib/pack-availability'

// PackTable — unified pack listings/EV row renderer shared by Top Shot and
// NFL All Day packs pages.
//
// Columns: Pack (image + name), Tier, Slots, Price, Gross EV, EV Margin %,
// FMV Coverage, Depletion %, Action. Default sort is by valueRatio desc
// (the "EV margin %" column). All column headers are sortable.
//
// Below the 640px breakpoint, each row collapses to a card: thumbnail on
// the left, pack name + tier header, EV Margin % as the dominant right-
// aligned number, price + coverage + depletion on a secondary detail row.

// Whether anyone can actually buy this pack right now. Measured 2026-08-02:
// 3,394 of the 4,596 pack EVs we publish -- every All Day, Golazos and Pinnacle
// row -- describe a pack that is neither on sale nor listed on secondary. The EV
// is still worth showing (it is a real record of what the pack held), but without
// this marker a green EV margin on a retired pack reads as a buy signal.
function AvailabilityBadge({ row }: { row: PackRow }) {
  const info = derivePackAvailability({
    primary_available: row.primaryAvailable,
    secondary_available: row.secondaryAvailable,
  })
  if (info.status === 'primary') return null // the default, unremarkable state
  const retired = info.status === 'retired'
  return (
    <span
      title={info.note}
      className="inline-block flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={
        retired
          ? { border: '1px solid var(--rpc-border)', color: 'var(--rpc-text-secondary)', background: 'var(--rpc-surface)' }
          : { border: '1px solid var(--rpc-border)', color: 'var(--rpc-text-secondary)' }
      }
    >
      {info.label}
    </span>
  )
}

export interface PackRow {
  id: string
  title: string
  thumbnailUrl: string | null
  tier: string
  /** Slots is null/0 for some pack types (Bundle, Reward, Chance Hit) — render those as a label rather than a literal 0. */
  slots: number | null
  /** Source pack_type value (e.g. "pack", "box", "case") used as the slots fallback label. */
  packType?: string | null
  price: number
  grossEV: number | null
  /** Typical Pull EV = slots × weighted-MEDIAN moment value over the remaining
   *  pool — sits near the common floor. Actual EV (grossEV, the mean) overstates
   *  lottery-shaped packs where a rare grail is the jackpot. Null when the pool is
   *  incomplete (non-TS / not Atlas-harvested). */
  typicalEv?: number | null
  /** Grail premium = grossEV − typicalEv (only when positive). How lottery-shaped
   *  the pack is; drives the "Grail premium" sort. Null when either EV is missing. */
  grailPremium?: number | null
  /** EV margin as a fraction (0.12 for +12%). Null when EV data unavailable. */
  evMarginPct: number | null
  /** 0..1 share of the pull set that has FMV data. */
  fmvCoverage: number | null
  /** 0..1 share of the distribution opened so far. */
  depletionPct: number | null
  /** 0..1 share of the drop pool's editions that have remaining=0 — the
   *  "ghost pack" signal. Distinct from depletionPct (sealed packs sold).
   *  ≥0.7 surfaces a "🔥 X/N editions remain" warning chip on the EV cell. */
  poolDepletionPct?: number | null
  /** Total editions in the drop pool — used with poolDepletionPct to render
   *  surviving-edition count in the depletion chip. */
  editionCount?: number | null
  /** True when the pack draws from a single ultra-rare edition rather than a probabilistic pool. */
  isRareSinglePack?: boolean
  /** Cached `total_unopened` from pack_ev_latest — packs remaining in the
   *  distribution. Drives the "remaining" sort. Null when EV not yet computed. */
  totalUnopened?: number | null
  /** Cached `pack_ev` (gross_ev − pack_price) in absolute dollars from
   *  pack_ev_latest. Drives the "packEvDollar" sort. Null when EV not yet computed. */
  packEvDollar?: number | null
  /** Dual-price model (May 2026). priceSource = null means the EV cron hasn't
   *  yet populated the dual-price columns for this distribution; the row
   *  falls back to the single-price `price` field. */
  primaryPrice?: number | null
  secondaryAsk?: number | null
  /** The value actually rendered in the Price column — same fallback chain as
   *  DualPriceCell (primary if primaryAvailable && >0, else secondary if
   *  available, else `price`). Exposed so the Price column header sorts on
   *  the displayed value rather than the underlying retail. Computed in
   *  toPackRow (see PackPageClient.tsx) so the sort + display stay in sync. */
  displayPrice?: number | null
  /** Whether the secondaryAsk in this row came from live /api/pack-listings
   *  data (TS only) or from the cached pack_ev_latest snapshot. Drives the
   *  small "LIVE" pip rendered next to the secondary ask in DualPriceCell.
   *  'cached' when the value originated from pack_ev_latest.secondary_ask,
   *  'live' when overlaid from current Dapper Studio GraphQL listings,
   *  null when no secondary ask is known at all. */
  secondaryAskSource?: 'live' | 'cached' | null
  /** Number of currently-active listings backing the live secondaryAsk.
   *  Surfaced as a tooltip on the LIVE pip so the user can gauge market depth. */
  secondaryListingCount?: number | null
  priceSource?: 'primary' | 'secondary' | 'min' | 'none' | null
  primaryAvailable?: boolean | null
  secondaryAvailable?: boolean | null
  /** True when grossEV / packEvDollar / evMarginPct on this row are the
   *  reality-adjusted (calibrated) numbers — modeled EV blended toward the
   *  realized pull value of observed opens (≥10 opens). Drives the
   *  "reality-adjusted" badge. False/undefined = pure modeled EV. */
  calibrationApplied?: boolean
  /** NFL All Day only: the row's grossEV/packEvDollar/evMarginPct are the
   *  odds/median-corrected EV (from v_allday_pack_info), but ≥50% of pack value
   *  rests on stale/thin FMV. Renders a "⚠ thin FMV" caveat next to the EV. */
  lowConfidenceEv?: boolean
  /** Callback to pass through to the action column. */
  onAction?: () => void
  /** Button label; default 'Analyze'. */
  actionLabel?: string
  /** When set, the title cell links here (the pack detail page). */
  detailHref?: string
  /** Internal href to the rip simulator for this distribution. Always set
   *  when toPackRow runs over a row from /api/packs; used by the Action
   *  cell when no external Buy link is available. */
  simulatorHref?: string | null
  /** External marketplace URL for this pack. Set only when an active live
   *  secondary listing exists AND the collection has a known marketplace
   *  URL pattern (Top Shot today via nbatopshot.com/listings/p2p). When
   *  present, the Action cell renders a "Buy" link instead of "Simulate". */
  buyUrl?: string | null
}

export type SortKey =
  | 'title'
  | 'tier'
  | 'slots'
  | 'price'
  | 'displayPrice'
  | 'grossEV'
  | 'typicalEv'
  | 'grailPremium'
  | 'evMarginPct'
  | 'fmvCoverage'
  | 'depletionPct'
  // Sort-only keys (no dedicated table column — the existing Depletion column
  // already shows pack-distributions depletion). Added for the listings page
  // sort dropdown that wants pool depletion / packs remaining / pack EV $.
  | 'poolDepletionPct'
  | 'totalUnopened'
  | 'packEvDollar'

export interface PackTableProps {
  rows: PackRow[]
  defaultSort?: SortKey
  defaultDir?: 'asc' | 'desc'
  emptyMessage?: string
  className?: string
}

// Tier chip styling moved to lib/tier-style.ts so server components can
// import it (calling client-module exports from a server component throws
// at runtime). Re-exporting tierChip here so existing client callers keep
// working unchanged.
import { tierChip as _tierChip, type ChipStyle } from '@/lib/tier-style'
export const tierChip = _tierChip
export type { ChipStyle }

// Pure formatting/threshold/sort helpers live in lib/pack-table-format.ts so
// they land under the vitest coverage `include` (lib/**), which does not
// measure components/**. Behavior is identical to the previous inline code.
import {
  coverageChipClass,
  fmtPrice,
  fmtPct,
  marginClass,
  fmtSlots,
  depletionChip,
  comparePackValues,
  defaultSortDir,
} from '@/lib/pack-table-format'

const RARE_SINGLE_TITLE =
  'EV represents one specific ultra-rare moment rather than a probabilistic pull across a pool.'

const CALIBRATED_TITLE =
  'Reality-adjusted: the modeled EV has been blended toward what this pack actually pulled across observed opens (≥10 opens), so the headline reflects realized value, not just the forecast.'

const LOW_CONFIDENCE_TITLE =
  'This EV is odds-corrected (tiers valued by median FMV, weighted by pull odds), but ≥50% of the pack value rests on stale or no-data FMV. Treat it as a rough estimate.'

const GRAIL_PREMIUM_TITLE =
  'Grail premium = Actual EV − Typical Pull. Actual EV (the mean) is inflated by rare grails; a typical pull is worth ~the Typical Pull figure. A large gap means the pack is lottery-shaped.'

const POOL_DEPLETION_TITLE =
  'Pool depletion: most editions in this pack are sold out. The remaining ones skew toward high-FMV survivors, so EV is high but variance is huge — a typical pull is far from average.'

function SortArrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span className="text-[color:var(--rpc-text-ghost)] ml-1">↕</span>
  return <span className="ml-1">{dir === 'desc' ? '↓' : '↑'}</span>
}

// PriceCell — renders a single price line. Strategy:
//   primary if it's still on sale (primaryAvailable && primaryPrice > 0),
//   otherwise the secondary low ask. Most packs have sold their primary
//   inventory out, so secondary is the dominant display. When the value
//   came from the live /api/pack-listings overlay (TS or AllDay), a small
//   green LIVE pip renders next to the number with a hover-title showing
//   active listing count.
//
// Renamed from DualPriceCell on 2026-05-19; the old Primary/Secondary
// stacked layout was noisy and didn't add information since primary is
// universally NULL in pack_ev_latest today and most TS rows display SOLD OUT
// on the primary line. Component is still exported as DualPriceCell for
// backward compat with existing imports.
export function DualPriceCell({
  row,
}: {
  row: Pick<PackRow, 'price' | 'primaryPrice' | 'secondaryAsk' | 'priceSource' | 'primaryAvailable' | 'secondaryAvailable' | 'secondaryAskSource' | 'secondaryListingCount'>
  // `layout` prop retained-but-ignored so callers don't break. Single-line
  // layout looks the same in both stacked and inline contexts now.
  layout?: 'inline' | 'stacked'
}) {
  const src = row.priceSource ?? null
  const primaryLive = row.primaryAvailable === true && row.primaryPrice != null && row.primaryPrice > 0
  const secondaryLive = row.secondaryAvailable === true && row.secondaryAsk != null && row.secondaryAsk > 0

  // Legacy fallback when no dual-price columns are populated yet (priceSource
  // null AND no primary/secondary numbers). Fall back to the single-price
  // string from the row.
  if (src === null && !primaryLive && !secondaryLive) {
    // A zero legacy price means "no price data" (e.g. Golazos primary ended,
    // no secondary indexed) — show an honest dash, not $0.00.
    return <span style={{ color: 'var(--rpc-text)', fontVariantNumeric: 'tabular-nums' }}>{row.price > 0 ? fmtPrice(row.price) : '\u2014'}</span>
  }

  // Pick the display price: primary takes precedence while inventory lasts,
  // then secondary takes over.
  const displayPrimary = primaryLive
  const displayValue = displayPrimary ? fmtPrice(row.primaryPrice) : (secondaryLive ? fmtPrice(row.secondaryAsk) : '—')

  // LIVE pip applies only when we're displaying a live secondary value.
  // No count: secondaryListingCount is structurally always 1 (the Dapper Studio
  // aggregation returns one node per dist — see lib/packs/live-pack-listings.ts),
  // so the pip asserts liveness only, not a listing tally. (Field kept on the
  // row shape for other consumers per the b8233f0 comment.)
  const isLive = !displayPrimary && row.secondaryAskSource === 'live' && secondaryLive
  const livePipTitle = 'Live secondary low ask'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--rpc-text, var(--rpc-text-primary))',
          fontWeight: 600,
        }}
      >
        {displayValue}
      </span>
      {isLive && (
        <span
          title={livePipTitle}
          style={{
            fontSize: 8,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.12em',
            fontWeight: 700,
            color: '#10B981',
            border: '1px solid rgba(16,185,129,0.5)',
            padding: '1px 4px',
            borderRadius: 3,
            lineHeight: 1,
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          LIVE
        </span>
      )}
    </div>
  )
}

// Tier-aware fallback when a pack thumbnail 404s or is null. Renders a
// solid square with the tier color and the pack title's first letter so
// the row stays visually anchored even without a real image.
//
// width/height set on BOTH inline style AND HTML attributes — iOS Safari
// skips img layout when only one is present, which broke pack thumbnails
// in the table on mobile.
export function PackThumb({ url, tier, title, size = 40 }: { url: string | null; tier: string; title: string; size?: number }) {
  const [errored, setErrored] = useState(false)
  const chip = tierChip(tier)
  if (!url || errored) {
    const initial = (title || '?').trim().charAt(0).toUpperCase() || '?'
    return (
      <div
        className="rounded flex items-center justify-center flex-shrink-0 font-semibold"
        style={{
          width: size,
          height: size,
          background: chip.background,
          border: chip.border,
          color: chip.color,
          fontSize: size >= 48 ? 16 : 13,
        }}
        aria-label={title}
      >
        {initial}
      </div>
    )
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={url}
      alt={title}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="rounded object-cover flex-shrink-0"
      style={{ width: size, height: size }}
      onError={() => setErrored(true)}
    />
  )
}

export default function PackTable({
  rows,
  defaultSort = 'evMarginPct',
  defaultDir = 'desc',
  emptyMessage = 'No packs to display.',
  className = '',
}: PackTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultSort)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultDir)
  const router = useRouter()

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = (a as unknown as Record<SortKey, unknown>)[sortKey]
      const bv = (b as unknown as Record<SortKey, unknown>)[sortKey]
      return comparePackValues(av, bv, sortKey === 'tier', sortDir)
    })
    return arr
  }, [rows, sortKey, sortDir])

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir(defaultSortDir(key))
    }
  }

  if (!rows.length) {
    return (
      <div className={`rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-10 text-center text-sm text-[color:var(--rpc-text-muted)] ${className}`}>
        {emptyMessage}
      </div>
    )
  }

  const HeaderCell = ({ k, label, className: thClass = '' }: { k: SortKey; label: string; className?: string }) => (
    <th
      onClick={() => setSort(k)}
      className={`rpc-label cursor-pointer select-none ${thClass}`}
      style={{ textAlign: 'left', padding: '10px 12px' }}
    >
      {label}
      <SortArrow active={sortKey === k} dir={sortDir} />
    </th>
  )

  return (
    <>
      {/* Desktop / tablet: full table */}
      <div
        className={`hidden md:block rpc-card ${className}`}
        style={{ overflow: 'auto', borderRadius: 'var(--radius-md)' }}
      >
        <table
          className="w-full min-w-[1000px] border-collapse"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        >
          <thead>
            <tr style={{ background: 'var(--rpc-surface)', borderBottom: '1px solid var(--rpc-border)' }}>
              <HeaderCell k="title" label="Pack" />
              <HeaderCell k="tier" label="Tier" />
              <HeaderCell k="slots" label="Slots" />
              <HeaderCell k="displayPrice" label="Price" />
              <HeaderCell k="grossEV" label="Actual EV" />
              <HeaderCell k="typicalEv" label="Typical Pull" />
              <HeaderCell k="evMarginPct" label="EV Margin %" />
              <HeaderCell k="fmvCoverage" label="FMV Coverage" />
              <HeaderCell k="depletionPct" label="Depletion %" />
              <th className="rpc-label" style={{ textAlign: 'left', padding: '10px 12px' }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                onClick={(e) => { const t = e.target as HTMLElement; if (t.closest('a,button')) return; if (r.detailHref) router.push(r.detailHref) }}
                style={{ borderBottom: '1px solid var(--rpc-border)', transition: 'background var(--transition-fast)', cursor: r.detailHref ? 'pointer' : 'default' }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'var(--rpc-surface-hover)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    {r.detailHref ? (
                      <Link href={r.detailHref} prefetch={false} aria-label={r.title} className="flex-shrink-0">
                        <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={40} />
                      </Link>
                    ) : (
                      <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={40} />
                    )}
                    {r.detailHref ? (
                      <Link href={r.detailHref} prefetch={false} className="font-medium text-[color:var(--rpc-text-primary)] hover:underline">
                        {r.title}
                      </Link>
                    ) : (
                      <span className="font-medium text-[color:var(--rpc-text-primary)]">{r.title}</span>
                    )}
                    <AvailabilityBadge row={r} />
                  </div>
                </td>
                <td className="p-3">
                  <span
                    className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold capitalize"
                    style={tierChip(r.tier)}
                  >
                    {r.tier.replace('MOMENT_TIER_', '').replace(/_/g, ' ').toLowerCase()}
                  </span>
                </td>
                <td className="p-3 text-[color:var(--rpc-text-secondary)]">{fmtSlots(r.slots, r.packType)}</td>
                <td className="p-3">
                  <DualPriceCell row={r} layout="inline" />
                </td>
                <td className="p-3 text-[color:var(--rpc-text-secondary)] tabular-nums">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{fmtPrice(r.grossEV)}</span>
                    {r.calibrationApplied && (
                      <span
                        title={CALIBRATED_TITLE}
                        className="inline-block rounded border border-[color:var(--rpc-red-border)] bg-[color:var(--rpc-red-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--rpc-red)]"
                      >
                        reality-adjusted
                      </span>
                    )}
                    {r.lowConfidenceEv && (
                      <span
                        title={LOW_CONFIDENCE_TITLE}
                        className="inline-block rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                      >
                        ⚠ thin FMV
                      </span>
                    )}
                    {r.isRareSinglePack && (
                      <span
                        title={RARE_SINGLE_TITLE}
                        className="inline-block rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                      >
                        Single rare edition
                      </span>
                    )}
                    {(() => {
                      const chip = depletionChip(r.poolDepletionPct, r.editionCount)
                      if (!chip) return null
                      return (
                        <span
                          title={POOL_DEPLETION_TITLE}
                          className="inline-block rounded border border-orange-900 bg-orange-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300"
                        >
                          {chip.label}
                        </span>
                      )
                    })()}
                  </div>
                </td>
                <td className="p-3 text-[color:var(--rpc-text-secondary)] tabular-nums">
                  {r.typicalEv == null ? (
                    <span className="text-[color:var(--rpc-text-ghost)]">—</span>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{fmtPrice(r.typicalEv)}</span>
                      {(() => {
                        const gp = r.grailPremium
                        const lottery =
                          gp != null && r.grossEV != null && r.grossEV > 0 &&
                          gp >= 0.5 && gp >= 0.15 * r.grossEV
                        if (!lottery) return null
                        return (
                          <span
                            title={GRAIL_PREMIUM_TITLE}
                            className="inline-block rounded border border-fuchsia-900 bg-fuchsia-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-300"
                          >
                            🎰 +{fmtPrice(gp)}
                          </span>
                        )
                      })()}
                    </div>
                  )}
                </td>
                <td className={`p-3 font-semibold tabular-nums ${marginClass(r.evMarginPct, r.poolDepletionPct)}`}>{fmtPct(r.evMarginPct)}</td>
                <td className="p-3">
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={coverageChipClass(r.fmvCoverage)}
                  >
                    {r.fmvCoverage == null ? '—' : fmtPct(r.fmvCoverage)}
                  </span>
                </td>
                <td className="p-3 text-[color:var(--rpc-text-secondary)] tabular-nums">{fmtPct(r.depletionPct)}</td>
                <td className="p-3">
                  {r.onAction ? (
                    <button
                      onClick={r.onAction}
                      className="rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-3 py-1 text-xs font-semibold text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)] transition"
                    >
                      {r.actionLabel ?? 'Analyze'}
                    </button>
                  ) : r.buyUrl ? (
                    <a
                      href={r.buyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/70 transition inline-block"
                      title="Open active listing on the marketplace"
                    >
                      Buy ↗
                    </a>
                  ) : r.simulatorHref ? (
                    <Link
                      href={r.simulatorHref}
                      prefetch={false}
                      className="rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-3 py-1 text-xs font-semibold text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)] transition inline-block"
                      title="Rip simulator — sample pulls weighted by drop probability"
                    >
                      Simulate
                    </Link>
                  ) : (
                    <span className="text-xs text-[color:var(--rpc-text-ghost)]">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile + small tablet: card layout */}
      <div className={`md:hidden space-y-2 ${className}`}>
        {sorted.map((r) => (
          <div key={r.id} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest('a,button')) return; if (r.detailHref) router.push(r.detailHref) }} className={'rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3' + (r.detailHref ? ' cursor-pointer' : '')}>
            <div className="flex items-start gap-3">
              {r.detailHref ? (
                <Link href={r.detailHref} prefetch={false} aria-label={r.title} className="flex-shrink-0">
                  <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={48} />
                </Link>
              ) : (
                <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={48} />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[color:var(--rpc-text-primary)] truncate">
                  {r.detailHref ? (
                    <Link href={r.detailHref} prefetch={false} className="hover:underline">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span
                    className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize"
                    style={tierChip(r.tier)}
                  >
                    {r.tier.replace('MOMENT_TIER_', '').replace(/_/g, ' ').toLowerCase()}
                  </span>
                  <AvailabilityBadge row={r} />
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className={`text-xl font-black tabular-nums ${marginClass(r.evMarginPct, r.poolDepletionPct)}`}>{fmtPct(r.evMarginPct)}</div>
                <div className="text-[10px] uppercase tracking-wide text-[color:var(--rpc-text-muted)]">EV margin</div>
                {r.calibrationApplied && (
                  <div
                    title={CALIBRATED_TITLE}
                    className="mt-1 inline-block rounded border border-[color:var(--rpc-red-border)] bg-[color:var(--rpc-red-bg)] px-1.5 py-0.5 text-[9px] font-semibold text-[color:var(--rpc-red)]"
                  >
                    reality-adjusted
                  </div>
                )}
                {r.lowConfidenceEv && (
                  <div
                    title={LOW_CONFIDENCE_TITLE}
                    className="mt-1 inline-block rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300"
                  >
                    ⚠ thin FMV
                  </div>
                )}
                {r.isRareSinglePack && (
                  <div
                    title={RARE_SINGLE_TITLE}
                    className="mt-1 inline-block rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300"
                  >
                    Single rare edition
                  </div>
                )}
                {(() => {
                  const chip = depletionChip(r.poolDepletionPct, r.editionCount)
                  if (!chip) return null
                  return (
                    <div
                      title={POOL_DEPLETION_TITLE}
                      className="mt-1 inline-block rounded border border-orange-900 bg-orange-950/40 px-1.5 py-0.5 text-[9px] font-semibold text-orange-300"
                    >
                      {chip.label}
                    </div>
                  )
                })()}
              </div>
            </div>
            <div className="mt-2">
              <DualPriceCell row={r} layout="stacked" />
            </div>
            {(r.grossEV != null || r.typicalEv != null) && (
              <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-[color:var(--rpc-text-secondary)] tabular-nums">
                <span>Actual EV <span className="font-semibold text-[color:var(--rpc-text-primary)]">{fmtPrice(r.grossEV)}</span></span>
                {r.typicalEv != null && (
                  <>
                    <span className="text-[color:var(--rpc-text-ghost)]">·</span>
                    <span>Typical <span className="font-semibold text-[color:var(--rpc-text-primary)]">{fmtPrice(r.typicalEv)}</span></span>
                  </>
                )}
                {(() => {
                  const gp = r.grailPremium
                  const lottery =
                    gp != null && r.grossEV != null && r.grossEV > 0 &&
                    gp >= 0.5 && gp >= 0.15 * r.grossEV
                  if (!lottery) return null
                  return (
                    <span
                      title={GRAIL_PREMIUM_TITLE}
                      className="inline-block rounded border border-fuchsia-900 bg-fuchsia-950/40 px-1.5 py-0.5 text-[9px] font-semibold text-fuchsia-300"
                    >
                      🎰 +{fmtPrice(gp)}
                    </span>
                  )
                })()}
              </div>
            )}
            <div className="mt-2 flex items-center gap-3 text-xs text-[color:var(--rpc-text-secondary)]">
              <span className="tabular-nums">{fmtSlots(r.slots, r.packType)} slots</span>
              <span>·</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={coverageChipClass(r.fmvCoverage)}
              >
                Cov {r.fmvCoverage == null ? '—' : fmtPct(r.fmvCoverage)}
              </span>
              {r.onAction ? (
                <button
                  onClick={r.onAction}
                  className="ml-auto rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)] transition"
                >
                  {r.actionLabel ?? 'Analyze'}
                </button>
              ) : r.buyUrl ? (
                <a
                  href={r.buyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto rounded border border-emerald-700 bg-emerald-900/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-900/70 transition"
                >
                  Buy ↗
                </a>
              ) : r.simulatorHref ? (
                <Link
                  href={r.simulatorHref}
                  prefetch={false}
                  className="ml-auto rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)] transition"
                >
                  Simulate
                </Link>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
