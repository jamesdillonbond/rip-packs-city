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

const TIER_CLASS: Record<string, string> = {
  ULTIMATE: 'text-yellow-400 border-yellow-900 bg-yellow-950/30',
  LEGENDARY: 'text-orange-400 border-orange-900 bg-orange-950/30',
  RARE: 'text-purple-400 border-purple-900 bg-purple-950/30',
  EPIC: 'text-indigo-400 border-indigo-900 bg-indigo-950/30',
  UNCOMMON: 'text-teal-400 border-teal-900 bg-teal-950/30',
  FANDOM: 'text-blue-400 border-blue-900 bg-blue-950/30',
  COMMON: 'text-slate-400 border-zinc-800 bg-zinc-900',
}

function tierChip(tier: string): string {
  const t = tier.toUpperCase().replace('MOMENT_TIER_', '')
  return TIER_CLASS[t] ?? 'text-zinc-400 border-zinc-800 bg-zinc-900'
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

function coverageChipClass(cov: number | null): string {
  if (cov == null) return 'bg-zinc-900 text-zinc-500 border-zinc-800'
  if (cov < 0.6) return 'bg-orange-950 text-orange-300 border-orange-800'
  return 'bg-emerald-950 text-emerald-300 border-emerald-900'
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
      className={`cursor-pointer select-none p-3 text-left text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 ${thClass}`}
    >
      {label}
      <SortArrow active={sortKey === k} dir={sortDir} />
    </th>
  )

  return (
    <>
      {/* Desktop / tablet: full table */}
      <div className={`hidden sm:block overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 ${className}`}>
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="bg-zinc-900 border-b border-zinc-800">
            <tr>
              <HeaderCell k="title" label="Pack" />
              <HeaderCell k="tier" label="Tier" />
              <HeaderCell k="slots" label="Slots" />
              <HeaderCell k="price" label="Price" />
              <HeaderCell k="grossEV" label="Gross EV" />
              <HeaderCell k="evMarginPct" label="EV Margin %" />
              <HeaderCell k="fmvCoverage" label="FMV Coverage" />
              <HeaderCell k="depletionPct" label="Depletion %" />
              <th className="p-3 text-left text-[11px] uppercase tracking-wide text-zinc-500">Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-b border-zinc-800 hover:bg-zinc-900/50">
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
                  <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold capitalize ${tierChip(r.tier)}`}>
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
                  <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${coverageChipClass(r.fmvCoverage)}`}>
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
                <span className={`mt-0.5 inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${tierChip(r.tier)}`}>
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
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${coverageChipClass(r.fmvCoverage)}`}>
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
