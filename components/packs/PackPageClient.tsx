'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import PackTable, { type PackRow, type SortKey as TableSortKey } from './PackTable'
import { useWarmCache } from '@/lib/warmup/WarmupContext'

// Shared client component for the static pack pages (nba-top-shot,
// nfl-all-day, la-liga-golazos). Renders /api/packs (pack_table_rows view)
// into the unified <PackTable/> with a filter strip: search, tier chips,
// type chips, price-range min/max, and the +EV / Has chasers / Almost-sold-out
// quick toggles. Sorts include the standard set plus three EV-cache-derived
// keys: pool depletion, packs remaining, and pack EV in absolute dollars.

type SortKey =
  | 'value_ratio_desc'
  | 'ev_margin_pct_desc'
  | 'retail_price_asc'
  | 'title_asc'
  | 'pool_depletion_pct_desc'
  | 'total_unopened_asc'
  | 'pack_ev_dollar_desc'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'value_ratio_desc', label: 'Value ratio' },
  { key: 'ev_margin_pct_desc', label: 'EV margin %' },
  { key: 'pack_ev_dollar_desc', label: 'Pack EV ($)' },
  { key: 'retail_price_asc', label: 'Retail price (low→high)' },
  { key: 'pool_depletion_pct_desc', label: 'Pool depletion (high→low)' },
  { key: 'total_unopened_asc', label: 'Packs remaining (low→high)' },
  { key: 'title_asc', label: 'Title (A→Z)' },
]

interface ApiRow {
  dist_id: string
  title: string
  image_url: string | null
  tier: string
  pack_type: string | null
  slots: number | null
  retail_price_usd: number | null
  pack_ev: number | null
  gross_ev: number | null
  ev_margin_pct: number | null
  value_ratio: number | null
  fmv_coverage_pct: number | null
  depletion_pct: number | null
  /** Pool-level depletion: % of editions in the drop pool with remaining=0.
   *  Distinct from depletion_pct (sealed packs sold). High values flag a
   *  "ghost pack" pool dominated by a few high-FMV survivors. */
  ev_depletion_pct: number | null
  /** Total editions in the EV calculation — used with ev_depletion_pct to
   *  derive the surviving-edition count for the depletion chip. */
  edition_count: number | null
  total_unopened: number | null
  is_rare_single_pack?: boolean | null
}

interface ApiResponse {
  rows: ApiRow[]
  total: number
  collection_slug: string
}

interface Props {
  collection: 'nba-top-shot' | 'nfl-all-day'
  tiers: string[]
  title: string
  accent?: string
}

function pctFraction(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null
  return pct / 100
}

function toPackRow(r: ApiRow, collectionUrlSlug: string): PackRow {
  return {
    id: r.dist_id,
    title: r.title ?? `Pack #${r.dist_id}`,
    thumbnailUrl: r.image_url,
    tier: (r.tier ?? 'common').toUpperCase(),
    slots: r.slots,
    packType: r.pack_type,
    price: r.retail_price_usd == null ? 0 : Number(r.retail_price_usd),
    grossEV: r.gross_ev == null ? null : Number(r.gross_ev),
    evMarginPct: r.ev_margin_pct == null ? null : Number(r.ev_margin_pct),
    fmvCoverage: pctFraction(r.fmv_coverage_pct),
    depletionPct: pctFraction(r.depletion_pct),
    poolDepletionPct: pctFraction(r.ev_depletion_pct),
    editionCount: r.edition_count == null ? null : Number(r.edition_count),
    totalUnopened: r.total_unopened == null ? null : Number(r.total_unopened),
    packEvDollar: r.pack_ev == null ? null : Number(r.pack_ev),
    isRareSinglePack: r.is_rare_single_pack === true,
    detailHref: `/${collectionUrlSlug}/pack/${r.dist_id}`,
  }
}

function parsePriceInput(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export default function PackPageClient({ collection, tiers, title, accent = '#E03A2F' }: Props) {
  const [sort, setSort] = useState<SortKey>('value_ratio_desc')
  const [tier, setTier] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [packType, setPackType] = useState<string>('all')
  const [priceMinInput, setPriceMinInput] = useState('')
  const [priceMaxInput, setPriceMaxInput] = useState('')
  // Quick-toggle chips. NULL values on any of the underlying columns fail the
  // filter (do NOT pass through) — surfacing not-yet-computed packs in a
  // "+EV only" view would mislead.
  const [posEvOnly, setPosEvOnly] = useState(false)
  const [hasChasers, setHasChasers] = useState(false)
  const [almostSoldOut, setAlmostSoldOut] = useState(false)

  // Debounce search input → search state
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // /api/packs accepts collection+sort+tier+search server-side. Sort keys
  // that aren't in /api/packs's ALLOWED_SORTS (the new pack-EV-derived ones)
  // are sorted client-side, so they all map to a single server fetch keyed
  // on value_ratio_desc to maximize cache reuse.
  const SERVER_SORTS = new Set(['value_ratio_desc', 'ev_margin_pct_desc', 'retail_price_asc', 'title_asc'])
  const serverSort = SERVER_SORTS.has(sort) ? sort : 'value_ratio_desc'
  const filterSuffix = (serverSort !== 'value_ratio_desc' || tier !== 'all' || search)
    ? ':' + serverSort + ':' + tier + ':' + search
    : ''
  const packsKey = 'pack-listings:' + collection + filterSuffix
  const packsFetcher = useCallback(async () => {
    const params = new URLSearchParams({ collection, sort: serverSort, limit: '500' })
    if (tier !== 'all') params.set('tier', tier)
    if (search) params.set('search', search)
    const res = await fetch('/api/packs?' + params.toString())
    const json = (await res.json()) as ApiResponse & { error?: string }
    if (!res.ok) throw new Error(json.error || 'Failed to load packs')
    return json
  }, [collection, serverSort, tier, search])

  const { data: packsData, loading: packsLoading, error: packsError } = useWarmCache<ApiResponse>(
    packsKey,
    packsFetcher,
    { ttlMs: 120_000 },
  )
  const rows: ApiRow[] = packsData?.rows ?? []
  const total = packsData?.total ?? 0
  const loading = packsLoading
  const error = packsError ? (packsError instanceof Error ? packsError.message : String(packsError)) : ''

  // Discover pack_type values present in the current result set so the chip
  // row only surfaces options that actually filter something (the column is
  // null for ~85% of TS rows; offering "all/pack/box/case" by default keeps
  // it useful without polluting collections that lack this dimension).
  const packTypeOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) {
      if (r.pack_type) seen.add(r.pack_type)
    }
    return Array.from(seen).sort()
  }, [rows])

  const filteredRows = useMemo(() => {
    const min = parsePriceInput(priceMinInput)
    const max = parsePriceInput(priceMaxInput)
    return rows.filter((r) => {
      if (packType !== 'all' && (r.pack_type ?? '') !== packType) return false
      if (min != null && (r.retail_price_usd == null || Number(r.retail_price_usd) < min)) return false
      if (max != null && (r.retail_price_usd == null || Number(r.retail_price_usd) > max)) return false
      // +EV only — uses the cached pack_ev column directly. NULL fails the
      // filter (we don't surface uncomputed packs as +EV).
      if (posEvOnly && (r.pack_ev == null || Number(r.pack_ev) <= 0)) return false
      // Has chasers proxy — value_ratio ≥ 1.0. Same NULL handling.
      if (hasChasers && (r.value_ratio == null || Number(r.value_ratio) < 1.0)) return false
      // Almost sold out — pool depletion ≥ 80%.
      if (almostSoldOut && (r.ev_depletion_pct == null || Number(r.ev_depletion_pct) < 80)) return false
      return true
    })
  }, [rows, packType, priceMinInput, priceMaxInput, posEvOnly, hasChasers, almostSoldOut])

  const packRows: PackRow[] = filteredRows.map((r) => toPackRow(r, collection))
  const tableSortDefault = tableSortFor(sort)
  const chipBase = 'rounded-lg px-2.5 py-1 text-xs font-semibold transition'
  const chipInactive = 'border border-zinc-700 text-zinc-400 hover:bg-zinc-900'

  return (
    <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-sm font-semibold text-white">{title}</h1>
          <div className="text-xs text-zinc-500">
            {loading ? 'Loading…' : packRows.length === total
              ? `${total.toLocaleString()} distributions`
              : `${packRows.length.toLocaleString()} of ${total.toLocaleString()} distributions`}
          </div>
        </div>
      </div>

      {/* Filters strip */}
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3 space-y-3">
        {/* Row 1: search + sort */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search packs by name…"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 flex-1 min-w-[200px]"
          />
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none"
            >
              {SORT_OPTIONS.map(({ key, label }) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: tier chips */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Tier</span>
          <button
            onClick={() => setTier('all')}
            className={chipBase + ' ' + (tier === 'all' ? 'text-white' : chipInactive)}
            style={tier === 'all' ? { backgroundColor: accent } : undefined}
          >
            All
          </button>
          {tiers.map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              className={chipBase + ' capitalize ' + (tier === t ? 'text-white' : chipInactive)}
              style={tier === t ? { backgroundColor: accent } : undefined}
            >
              {t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {/* Row 3: quick toggles — +EV / Has chasers / Almost sold out */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Quick</span>
          <button
            onClick={() => setPosEvOnly((v) => !v)}
            className={chipBase + ' ' + (posEvOnly ? 'text-white' : chipInactive)}
            style={posEvOnly ? { backgroundColor: '#10B981' } : undefined}
            title="Cached pack_ev > 0"
          >
            +EV only
          </button>
          <button
            onClick={() => setHasChasers((v) => !v)}
            className={chipBase + ' ' + (hasChasers ? 'text-white' : chipInactive)}
            style={hasChasers ? { backgroundColor: accent } : undefined}
            title="value_ratio ≥ 1.0 — proxy for chaser-heavy pools"
          >
            Has chasers <span className="ml-1 text-[9px] opacity-60">(beta)</span>
          </button>
          <button
            onClick={() => setAlmostSoldOut((v) => !v)}
            className={chipBase + ' ' + (almostSoldOut ? 'text-white' : chipInactive)}
            style={almostSoldOut ? { backgroundColor: '#F97316' } : undefined}
            title="Pool depletion ≥ 80% — most editions in the pool are sold out"
          >
            Almost sold out
          </button>
          {(posEvOnly || hasChasers || almostSoldOut) && (
            <button
              onClick={() => { setPosEvOnly(false); setHasChasers(false); setAlmostSoldOut(false) }}
              className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-white ml-1"
            >
              Clear
            </button>
          )}
        </div>

        {/* Row 4: type chips + price range */}
        <div className="flex flex-wrap items-center gap-3">
          {packTypeOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Type</span>
              <button
                onClick={() => setPackType('all')}
                className={chipBase + ' ' + (packType === 'all' ? 'text-white' : chipInactive)}
                style={packType === 'all' ? { backgroundColor: accent } : undefined}
              >
                All
              </button>
              {packTypeOptions.map((pt) => (
                <button
                  key={pt}
                  onClick={() => setPackType(pt)}
                  className={chipBase + ' capitalize ' + (packType === pt ? 'text-white' : chipInactive)}
                  style={packType === pt ? { backgroundColor: accent } : undefined}
                >
                  {pt}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Price</span>
            <input
              value={priceMinInput}
              onChange={(e) => setPriceMinInput(e.target.value)}
              placeholder="Min"
              inputMode="decimal"
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none placeholder:text-zinc-500 w-20"
            />
            <span className="text-[10px] text-zinc-600">–</span>
            <input
              value={priceMaxInput}
              onChange={(e) => setPriceMaxInput(e.target.value)}
              placeholder="Max"
              inputMode="decimal"
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none placeholder:text-zinc-500 w-20"
            />
            {(priceMinInput || priceMaxInput) && (
              <button
                onClick={() => { setPriceMinInput(''); setPriceMaxInput('') }}
                className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-300">{error}</div>
      )}

      <PackTable
        rows={packRows}
        defaultSort={tableSortDefault.key}
        defaultDir={tableSortDefault.dir}
        emptyMessage={loading ? 'Loading packs…' : 'No packs match your filters.'}
      />
    </div>
  )
}

// Align PackTable's internal default with the active sort key so the two
// don't fight each other on first paint. The four classic sorts map to
// existing PackTable columns; the three new EV-cache sorts map to PackRow
// fields that don't have dedicated columns yet — PackTable's comparator
// handles them via the raw [sortKey] lookup.
function tableSortFor(sort: SortKey): { key: TableSortKey; dir: 'asc' | 'desc' } {
  switch (sort) {
    case 'value_ratio_desc':
    case 'ev_margin_pct_desc':
      return { key: 'evMarginPct', dir: 'desc' }
    case 'retail_price_asc':
      return { key: 'price', dir: 'asc' }
    case 'title_asc':
      return { key: 'title', dir: 'asc' }
    case 'pool_depletion_pct_desc':
      return { key: 'poolDepletionPct', dir: 'desc' }
    case 'total_unopened_asc':
      return { key: 'totalUnopened', dir: 'asc' }
    case 'pack_ev_dollar_desc':
      return { key: 'packEvDollar', dir: 'desc' }
  }
}
