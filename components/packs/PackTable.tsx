'use client'

import Link from 'next/link'
import React, { useMemo, useState } from 'react'

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
  /** Callback to pass through to the action column. */
  onAction?: () => void
  /** Button label; default 'Analyze'. */
  actionLabel?: string
  /** When set, the title cell links here (the pack detail page). */
  detailHref?: string
}

export type SortKey =
  | 'title'
  | 'tier'
  | 'slots'
  | 'price'
  | 'grossEV'
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

type ChipStyle = {
  background: string
  color: string
  border: string
}

const TIER_STYLE: Record<string, ChipStyle> = {
  ULTIMATE: { background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.4)', color: 'rgb(253,224,71)' },
  LEGENDARY: { background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.4)', color: 'rgb(253,186,116)' },
  RARE: { background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.4)', color: 'rgb(216,180,254)' },
  EPIC: { background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: 'rgb(165,180,252)' },
  UNCOMMON: { background: 'rgba(20,184,166,0.15)', border: '1px solid rgba(20,184,166,0.4)', color: 'rgb(94,234,212)' },
  FANDOM: { background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: 'rgb(147,197,253)' },
  COMMON: { background: 'rgba(100,116,139,0.15)', border: '1px solid rgba(100,116,139,0.4)', color: 'rgb(203,213,225)' },
}

const TIER_DEFAULT: ChipStyle = {
  background: 'rgba(100,116,139,0.15)',
  border: '1px solid rgba(100,116,139,0.4)',
  color: 'rgb(203,213,225)',
}

export function tierChip(tier: string): ChipStyle {
  const t = tier.toUpperCase().replace('MOMENT_TIER_', '')
  return TIER_STYLE[t] ?? TIER_DEFAULT
}

const COVERAGE_NULL: ChipStyle = {
  background: 'rgba(100,116,139,0.15)',
  border: '1px solid rgba(100,116,139,0.4)',
  color: 'rgb(148,163,184)',
}
const COVERAGE_LOW: ChipStyle = {
  background: 'rgba(249,115,22,0.15)',
  border: '1px solid rgba(249,115,22,0.4)',
  color: 'rgb(253,186,116)',
}
const COVERAGE_HIGH: ChipStyle = {
  background: 'rgba(16,185,129,0.15)',
  border: '1px solid rgba(16,185,129,0.4)',
  color: 'rgb(110,231,183)',
}

function coverageChipClass(cov: number | null): ChipStyle {
  if (cov == null) return COVERAGE_NULL
  if (cov < 0.6) return COVERAGE_LOW
  return COVERAGE_HIGH
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `$${n.toFixed(2)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function marginClass(pct: number | null): string {
  if (pct == null) return 'text-zinc-500'
  if (pct > 0) return 'text-emerald-400'
  if (pct < 0) return 'text-red-400'
  return 'text-zinc-400'
}

// Slots cell: render the integer when meaningful, otherwise fall back to the
// pack_type label (Bundle, Reward, Chance Hit, etc) or an em-dash. Several
// pack types in the catalog (Grail Seeker, certain Fast Break runs) ship a
// legitimate null/0 from the source — rendering "0" is misleading.
function fmtSlots(slots: number | null, packType?: string | null): string {
  if (slots != null && slots > 0) return String(slots)
  const label = (packType ?? '').trim()
  if (label) return label.charAt(0).toUpperCase() + label.slice(1)
  return '—'
}

const RARE_SINGLE_TITLE =
  'EV represents one specific ultra-rare moment rather than a probabilistic pull across a pool.'

const POOL_DEPLETION_THRESHOLD = 0.7
const POOL_DEPLETION_TITLE =
  'Pool depletion: most editions in this pack are sold out. The remaining ones skew toward high-FMV survivors, so EV is high but variance is huge — a typical pull is far from average.'

// Surface pool depletion as a "🔥 X/N remain" chip when ≥70% of the drop
// pool's editions have remaining=0. Mathematically EV is correct, but it's
// dominated by a few survivors — sophisticated buyers want to know.
function depletionChip(poolDepletionPct: number | null | undefined, editionCount: number | null | undefined): { label: string; surviving: number; total: number } | null {
  if (poolDepletionPct == null || !Number.isFinite(poolDepletionPct)) return null
  if (poolDepletionPct < POOL_DEPLETION_THRESHOLD) return null
  if (editionCount == null || editionCount <= 0) return null
  const surviving = Math.max(1, Math.round(editionCount * (1 - poolDepletionPct)))
  return { label: `🔥 ${surviving}/${editionCount} remain`, surviving, total: editionCount }
}

function SortArrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span className="text-zinc-700 ml-1">↕</span>
  return <span className="ml-1">{dir === 'desc' ? '↓' : '↑'}</span>
}

// DualPriceCell — renders PRIMARY + SECONDARY stacked rows with a red accent
// on whichever side EV is anchored against. When `priceSource` is null, the
// EV cron hasn't populated the dual-price columns yet, so fall back to the
// single-price string. When `priceSource === 'none'`, the pack is not buyable
// on either market — render both sides empty and let upstream verdict UI hide.
export function DualPriceCell({
  row,
  layout = 'inline',
}: {
  row: Pick<PackRow, 'price' | 'primaryPrice' | 'secondaryAsk' | 'priceSource' | 'primaryAvailable' | 'secondaryAvailable' | 'secondaryAskSource' | 'secondaryListingCount'>
  layout?: 'inline' | 'stacked'
}) {
  const src = row.priceSource ?? null

  // Legacy fallback: no dual-price columns yet → single price string
  if (src === null) {
    return <span style={{ color: 'var(--rpc-text)', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(row.price)}</span>
  }

  const primaryLive = row.primaryAvailable === true && row.primaryPrice != null && row.primaryPrice > 0
  const secondaryLive = row.secondaryAvailable === true && row.secondaryAsk != null && row.secondaryAsk > 0

  // Both anchors when price_source === 'min'; otherwise just the chosen one
  const primaryAnchor = src === 'primary' || src === 'min'
  const secondaryAnchor = src === 'secondary' || src === 'min'

  const primaryText = primaryLive ? fmtPrice(row.primaryPrice) : 'SOLD OUT'
  const secondaryText = secondaryLive ? fmtPrice(row.secondaryAsk) : '—'

  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--rpc-text-muted, rgba(255,255,255,0.45))',
    fontFamily: 'var(--font-mono)',
    minWidth: layout === 'stacked' ? 60 : 56,
    display: 'inline-block',
  }
  const valueBase: React.CSSProperties = {
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-mono)',
    fontSize: layout === 'stacked' ? 13 : 12,
  }

  const Row = ({
    label,
    value,
    anchor,
    muted,
  }: {
    label: string
    value: string
    anchor: boolean
    muted: boolean
  }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, lineHeight: 1.2 }}>
      <span style={labelStyle}>{label}</span>
      <span
        style={{
          ...valueBase,
          color: anchor ? 'var(--rpc-red)' : muted ? 'var(--rpc-text-muted, rgba(255,255,255,0.45))' : 'var(--rpc-text, #fff)',
          fontWeight: anchor ? 700 : 500,
        }}
      >
        {value}
      </span>
      {anchor && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--rpc-red)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
      )}
    </div>
  )

  // LIVE pip — appears next to the secondary ask when the value came from the
  // current /api/pack-listings overlay rather than the cached pack_ev_latest
  // snapshot. Hover-title carries the listing count for market-depth context.
  const isLive = row.secondaryAskSource === 'live' && secondaryLive
  const listingCount = row.secondaryListingCount ?? null
  const livePipTitle = listingCount != null
    ? `Live secondary low ask · ${listingCount} active listing${listingCount === 1 ? '' : 's'}`
    : 'Live secondary low ask'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Row label="Primary" value={primaryText} anchor={primaryAnchor && primaryLive} muted={!primaryLive} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Row label="Secondary" value={secondaryText} anchor={secondaryAnchor && secondaryLive} muted={!secondaryLive} />
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

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = (a as unknown as Record<SortKey, unknown>)[sortKey]
      const bv = (b as unknown as Record<SortKey, unknown>)[sortKey]
      // Null/undefined values always sort to the end regardless of direction
      // — the asymmetry the previous comparator had (-Infinity sorted to the
      // top in asc order) made packs missing EV crowd the top of the
      // "EV margin asc" / "remaining asc" views, which isn't useful.
      const aNull = av == null
      const bNull = bv == null
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      const an = typeof av === 'number' ? av : String(av).toLowerCase()
      const bn = typeof bv === 'number' ? bv : String(bv).toLowerCase()
      if (an === bn) return 0
      if (sortDir === 'desc') return an > bn ? -1 : 1
      return an < bn ? -1 : 1
    })
    return arr
  }, [rows, sortKey, sortDir])

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'title' || key === 'tier' ? 'asc' : 'desc')
    }
  }

  if (!rows.length) {
    return (
      <div className={`rounded-xl border border-zinc-800 bg-zinc-950 p-10 text-center text-sm text-zinc-500 ${className}`}>
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
        className={`hidden sm:block rpc-card ${className}`}
        style={{ overflow: 'auto', borderRadius: 'var(--radius-md)' }}
      >
        <table
          className="w-full min-w-[900px] border-collapse"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        >
          <thead>
            <tr style={{ background: 'var(--rpc-surface)', borderBottom: '1px solid var(--rpc-border)' }}>
              <HeaderCell k="title" label="Pack" />
              <HeaderCell k="tier" label="Tier" />
              <HeaderCell k="slots" label="Slots" />
              <HeaderCell k="price" label="Price" />
              <HeaderCell k="grossEV" label="Gross EV" />
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
                style={{ borderBottom: '1px solid var(--rpc-border)', transition: 'background var(--transition-fast)' }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'var(--rpc-surface-hover)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={40} />
                    {r.detailHref ? (
                      <Link href={r.detailHref} prefetch={false} className="font-medium text-white hover:underline">
                        {r.title}
                      </Link>
                    ) : (
                      <span className="font-medium text-white">{r.title}</span>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  <span
                    className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold capitalize"
                    style={tierChip(r.tier)}
                  >
                    {r.tier.replace('MOMENT_TIER_', '').toLowerCase()}
                  </span>
                </td>
                <td className="p-3 text-zinc-300">{fmtSlots(r.slots, r.packType)}</td>
                <td className="p-3">
                  <DualPriceCell row={r} layout="inline" />
                </td>
                <td className="p-3 text-zinc-300 tabular-nums">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{fmtPrice(r.grossEV)}</span>
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
                <td className={`p-3 font-semibold tabular-nums ${marginClass(r.evMarginPct)}`}>{fmtPct(r.evMarginPct)}</td>
                <td className="p-3">
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={coverageChipClass(r.fmvCoverage)}
                  >
                    {r.fmvCoverage == null ? '—' : fmtPct(r.fmvCoverage)}
                  </span>
                </td>
                <td className="p-3 text-zinc-300 tabular-nums">{fmtPct(r.depletionPct)}</td>
                <td className="p-3">
                  {r.onAction ? (
                    <button
                      onClick={r.onAction}
                      className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-semibold text-white hover:bg-zinc-700 transition"
                    >
                      {r.actionLabel ?? 'Analyze'}
                    </button>
                  ) : (
                    <span className="text-xs text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: card layout */}
      <div className={`sm:hidden space-y-2 ${className}`}>
        {sorted.map((r) => (
          <div key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex items-start gap-3">
              <PackThumb url={r.thumbnailUrl} tier={r.tier} title={r.title} size={48} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate">
                  {r.detailHref ? (
                    <Link href={r.detailHref} prefetch={false} className="hover:underline">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </div>
                <span
                  className="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize"
                  style={tierChip(r.tier)}
                >
                  {r.tier.replace('MOMENT_TIER_', '').toLowerCase()}
                </span>
              </div>
              <div className="text-right flex-shrink-0">
                <div className={`text-xl font-black tabular-nums ${marginClass(r.evMarginPct)}`}>{fmtPct(r.evMarginPct)}</div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">EV margin</div>
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
            <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
              <span className="tabular-nums">{fmtSlots(r.slots, r.packType)} slots</span>
              <span>·</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={coverageChipClass(r.fmvCoverage)}
              >
                Cov {r.fmvCoverage == null ? '—' : fmtPct(r.fmvCoverage)}
              </span>
              {r.onAction && (
                <button
                  onClick={r.onAction}
                  className="ml-auto rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-700 transition"
                >
                  {r.actionLabel ?? 'Analyze'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
