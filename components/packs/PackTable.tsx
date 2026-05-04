'use client'

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
  slots: number
  price: number
  grossEV: number | null
  /** EV margin as a fraction (0.12 for +12%). Null when EV data unavailable. */
  evMarginPct: number | null
  /** 0..1 share of the pull set that has FMV data. */
  fmvCoverage: number | null
  /** 0..1 share of the distribution opened so far. */
  depletionPct: number | null
  /** True when the pack draws from a single ultra-rare edition rather than a probabilistic pool. */
  isRareSinglePack?: boolean
  /** Callback to pass through to the action column. */
  onAction?: () => void
  /** Button label; default 'Analyze'. */
  actionLabel?: string
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

function tierChip(tier: string): ChipStyle {
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

const RARE_SINGLE_TITLE =
  'EV represents one specific ultra-rare moment rather than a probabilistic pull across a pool.'

function SortArrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span className="text-zinc-700 ml-1">↕</span>
  return <span className="ml-1">{dir === 'desc' ? '↓' : '↑'}</span>
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
      const an = av == null ? -Infinity : typeof av === 'number' ? av : String(av).toLowerCase()
      const bn = bv == null ? -Infinity : typeof bv === 'number' ? bv : String(bv).toLowerCase()
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
                    {r.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.thumbnailUrl} alt={r.title} className="h-10 w-10 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-zinc-900 flex items-center justify-center text-zinc-700">?</div>
                    )}
                    <span className="font-medium text-white">{r.title}</span>
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
                <td className="p-3 text-zinc-300">{r.slots}</td>
                <td className="p-3 text-zinc-300 tabular-nums">{fmtPrice(r.price)}</td>
                <td className="p-3 text-zinc-300 tabular-nums">
                  <div className="flex items-center gap-2">
                    <span>{fmtPrice(r.grossEV)}</span>
                    {r.isRareSinglePack && (
                      <span
                        title={RARE_SINGLE_TITLE}
                        className="inline-block rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                      >
                        Single rare edition
                      </span>
                    )}
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
              {r.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.thumbnailUrl} alt={r.title} className="h-12 w-12 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="h-12 w-12 rounded bg-zinc-900 flex items-center justify-center text-zinc-700 flex-shrink-0">?</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate">{r.title}</div>
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
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
              <span className="tabular-nums">{fmtPrice(r.price)}</span>
              <span>·</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={coverageChipClass(r.fmvCoverage)}
              >
                Cov {r.fmvCoverage == null ? '—' : fmtPct(r.fmvCoverage)}
              </span>
              <span>·</span>
              <span className="tabular-nums">Depleted {fmtPct(r.depletionPct)}</span>
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
