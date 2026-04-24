'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import PackTable, { type PackRow, type SortKey as TableSortKey } from './PackTable'
import { getOwnerKey } from '@/lib/owner-key'
import { fetchSavedWalletForCollection } from '@/lib/profile/saved-wallet-for-collection'

// Shared client component for the two static pack pages (nba-top-shot,
// nfl-all-day). Does three things:
//   1. Loads rows from /api/packs?collection=<slug> with server-side sort,
//      tier filter, and title search.
//   2. Renders the unified <PackTable/>.
//   3. Keeps the "My Sealed Packs" wallet-query strip above the table
//      (auto-loads from localStorage owner key / saved wallet, falls back
//      to manual wallet input).

type SortKey = 'value_ratio_desc' | 'ev_margin_pct_desc' | 'retail_price_asc' | 'title_asc'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'value_ratio_desc', label: 'Value ratio' },
  { key: 'ev_margin_pct_desc', label: 'EV margin %' },
  { key: 'retail_price_asc', label: 'Retail price (low→high)' },
  { key: 'title_asc', label: 'Title (A→Z)' },
]

interface ApiRow {
  dist_id: string
  title: string
  image_url: string | null
  tier: string
  slots: number | null
  retail_price_usd: number | null
  gross_ev: number | null
  ev_margin_pct: number | null
  value_ratio: number | null
  fmv_coverage_pct: number | null
  depletion_pct: number | null
}

interface ApiResponse {
  rows: ApiRow[]
  total: number
  collection_slug: string
}

interface WalletResponse {
  owned?: Record<string, number>
  walletAddress?: string
  totalSealedPacks?: number
  error?: string
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

function toPackRow(r: ApiRow): PackRow {
  return {
    id: r.dist_id,
    title: r.title ?? `Pack #${r.dist_id}`,
    thumbnailUrl: r.image_url,
    tier: (r.tier ?? 'common').toUpperCase(),
    slots: r.slots ?? 0,
    price: r.retail_price_usd == null ? 0 : Number(r.retail_price_usd),
    grossEV: r.gross_ev == null ? null : Number(r.gross_ev),
    evMarginPct: r.ev_margin_pct == null ? null : Number(r.ev_margin_pct),
    fmvCoverage: pctFraction(r.fmv_coverage_pct),
    depletionPct: pctFraction(r.depletion_pct),
  }
}

export default function PackPageClient({ collection, tiers, title, accent = '#E03A2F' }: Props) {
  const [rows, setRows] = useState<ApiRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<SortKey>('value_ratio_desc')
  const [tier, setTier] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const [walletInput, setWalletInput] = useState('')
  const [walletQuery, setWalletQuery] = useState('')
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState('')
  const [ownedPacks, setOwnedPacks] = useState<Record<string, number>>({})
  const [walletAddress, setWalletAddress] = useState('')
  const autoWalletFired = useRef(false)

  // Debounce search input → search state
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ collection, sort, limit: '500' })
      if (tier !== 'all') params.set('tier', tier)
      if (search) params.set('search', search)
      const res = await fetch('/api/packs?' + params.toString())
      const json = (await res.json()) as ApiResponse & { error?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to load packs')
      setRows(json.rows ?? [])
      setTotal(json.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packs')
    } finally {
      setLoading(false)
    }
  }, [collection, sort, tier, search])

  useEffect(() => { loadRows() }, [loadRows])

  const loadWallet = useCallback(async (source: string) => {
    setWalletQuery(source)
    setWalletLoading(true)
    setWalletError('')
    setOwnedPacks({})
    setWalletAddress('')
    try {
      const res = await fetch('/api/wallet-packs?wallet=' + encodeURIComponent(source))
      const json = (await res.json().catch(() => ({}))) as WalletResponse
      if (!res.ok) throw new Error(json.error || 'Failed to load wallet')
      setOwnedPacks(json.owned ?? {})
      setWalletAddress(json.walletAddress ?? '')
      if (json.totalSealedPacks === 0) setWalletError('No sealed packs found for this wallet.')
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setWalletLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoWalletFired.current) return
    autoWalletFired.current = true
    const key = getOwnerKey()
    if (key) {
      setWalletInput(key)
      loadWallet(key)
      return
    }
    fetchSavedWalletForCollection(collection).then((addr) => {
      if (!addr) return
      setWalletInput(addr)
      loadWallet(addr)
    })
  }, [collection, loadWallet])

  const handleWalletSearch = () => {
    const q = walletInput.trim()
    if (q) loadWallet(q)
  }

  const packRows: PackRow[] = rows.map((r) => toPackRow(r))

  // "My Sealed Packs" — rows from the current catalog that the wallet owns.
  const ownedDistIds = Object.keys(ownedPacks)
  const ownedRows = ownedDistIds
    .map((id) => {
      const match = rows.find((r) => r.dist_id === id)
      return match ? { ...match, __count: ownedPacks[id] ?? 1 } : null
    })
    .filter((x): x is ApiRow & { __count: number } => x !== null)
  const hasOwned = ownedRows.length > 0

  return (
    <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-sm font-semibold text-white">{title}</h1>
          <div className="text-xs text-zinc-500">
            {loading ? 'Loading…' : `${total.toLocaleString()} distributions`}
          </div>
        </div>
      </div>

      {/* My Sealed Packs strip */}
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">My sealed packs</span>
          <input
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleWalletSearch() }}
            placeholder="Username or 0x wallet"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 flex-1 min-w-[180px]"
          />
          <button
            onClick={handleWalletSearch}
            disabled={walletLoading || !walletInput.trim()}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
          >
            {walletLoading ? 'Loading…' : 'Show owned'}
          </button>
          {walletAddress && <span className="text-xs text-emerald-400">{walletQuery}</span>}
          {walletError && <span className="text-xs text-red-400">{walletError}</span>}
        </div>
        {hasOwned && (
          <div className="mt-3 flex flex-wrap gap-2">
            {ownedRows.map((r) => (
              <span
                key={r.dist_id}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
              >
                {r.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.image_url} alt="" className="h-6 w-6 rounded object-cover" />
                ) : null}
                <span className="max-w-[140px] truncate text-white">{r.title}</span>
                {r.__count > 1 && (
                  <span className="rounded bg-emerald-950 px-1 text-[10px] font-semibold text-emerald-300">
                    x{r.__count}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Controls: search + tier filter + sort */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search packs…"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 w-44"
        />

        {/* Tier chips */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-600 mr-1">Tier</span>
          <button
            onClick={() => setTier('all')}
            className={
              'rounded-lg px-2.5 py-1 text-xs font-semibold transition ' +
              (tier === 'all' ? 'text-white' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-900')
            }
            style={tier === 'all' ? { backgroundColor: accent } : undefined}
          >
            All
          </button>
          {tiers.map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              className={
                'rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition ' +
                (tier === t ? 'text-white' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-900')
              }
              style={tier === t ? { backgroundColor: accent } : undefined}
            >
              {t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {/* Sort: pill row (desktop), dropdown (mobile) */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-600">Sort</span>
          <div className="hidden sm:flex items-center gap-1">
            {SORT_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                className={
                  'rounded-lg px-2.5 py-1 text-xs font-semibold transition ' +
                  (sort === key ? 'text-white' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-900')
                }
                style={sort === key ? { backgroundColor: accent } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="sm:hidden rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none"
          >
            {SORT_OPTIONS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-300">{error}</div>
      )}

      <PackTable
        rows={packRows}
        defaultSort={tableSortFor(sort).key}
        defaultDir={tableSortFor(sort).dir}
        emptyMessage={loading ? 'Loading packs…' : 'No packs match your filters.'}
      />
    </div>
  )
}

// Align PackTable's internal default with the server-side /api/packs sort so
// the two don't fight each other on first paint. value_ratio and
// ev_margin_pct produce identical orderings (differ by a constant), so both
// map to PackTable's evMarginPct column.
function tableSortFor(sort: SortKey): { key: TableSortKey; dir: 'asc' | 'desc' } {
  switch (sort) {
    case 'value_ratio_desc':
    case 'ev_margin_pct_desc':
      return { key: 'evMarginPct', dir: 'desc' }
    case 'retail_price_asc':
      return { key: 'price', dir: 'asc' }
    case 'title_asc':
      return { key: 'title', dir: 'asc' }
  }
}
