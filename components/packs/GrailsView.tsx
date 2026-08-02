'use client'

// components/packs/GrailsView.tsx
//
// "Grails" card grid for the packs page. Pulls /api/packs/grails (joined
// pack_grail_metrics_mv + pack_table_rows) and renders the chase player, the
// per-pack at-least-once probability strip, and a CTA to the simulator.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { tierColor, fmtUsd, fmtPct, atLeastOnce, selectPackPrice } from '@/lib/grail-format'
import { tierColorAlpha } from '@/lib/tier-color'

interface GrailRow {
  collection_id: string
  dist_id: string
  edition_count_pullable: number
  fmv_coverage_pct: number | null
  max_pull_fmv: number | null
  max_pull_player: string | null
  max_pull_set: string | null
  max_pull_tier: string | null
  max_pull_thumbnail: string | null
  grails_25: number
  grails_100: number
  grails_500: number
  grails_1000: number
  ultimate_count: number
  legendary_count: number
  rare_count: number
  weighting_method: string
  weighted_grail_value_100plus: number | null
  ev_per_slot: number | null
  prob_grail_100_per_slot: number | null
  prob_grail_1000_per_slot: number | null
  prob_ultimate_per_slot: number | null
  meta: {
    title: string | null
    image_url: string | null
    primary_price: number | null
    secondary_ask: number | null
    pack_ev: number | null
    value_ratio: number | null
    total_sealed: number | null
    depletion_pct: number | null
    slots: number | null
    primary_available: boolean | null
    secondary_available: boolean | null
  } | null
}

type SortKey = 'maxPull' | 'evPerSlot' | 'weightedGrailValue'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'weightedGrailValue', label: 'Weighted grail value' },
  { key: 'maxPull', label: 'Max pull' },
  { key: 'evPerSlot', label: 'EV per slot' },
]

const SLOT_DEFAULT = 5

interface Props {
  collection: string
  accent: string
}

export default function GrailsView({ collection, accent }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [rows, setRows] = useState<GrailRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('weightedGrailValue')
  const [buyableOnly, setBuyableOnly] = useState<boolean>(
    (searchParams?.get('buyableOnly') ?? '').toLowerCase() === 'true'
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ collection, sort, limit: '50', minGrails100: '1' })
      if (buyableOnly) params.set('buyableOnly', 'true')
      const res = await fetch('/api/packs/grails?' + params.toString())
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? 'Failed to load grail metrics')
        setRows([])
      } else {
        setRows(json.rows ?? [])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [collection, sort, buyableOnly])

  useEffect(() => { load() }, [load])

  // Server-side filter does the heavy lifting; client-side filter is a
  // belt-and-suspenders pass that handles stale-cached responses where the
  // toggle state and the response shape are out of sync.
  const displayRows = useMemo(() => {
    if (!buyableOnly) return rows
    return rows.filter((r) => r.meta?.primary_available === true || r.meta?.secondary_available === true)
  }, [rows, buyableOnly])

  const sortLabel = useMemo(() => SORT_OPTIONS.find((o) => o.key === sort)?.label ?? sort, [sort])

  const toggleBuyable = useCallback(() => {
    const next = !buyableOnly
    setBuyableOnly(next)
    // Sticky in URL so the leaderboard is shareable in either state. Use
    // replace + scroll:false to avoid history pollution and scroll jumps.
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    if (next) params.set('buyableOnly', 'true')
    else params.delete('buyableOnly')
    const qs = params.toString()
    router.replace(qs.length > 0 ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [buyableOnly, pathname, router, searchParams])

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Sort</span>
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => setSort(o.key)}
            style={{
              padding: '6px 12px',
              background: sort === o.key ? accent : '#0d0d0d',
              color: sort === o.key ? '#fff' : 'rgba(255,255,255,0.75)',
              border: `1px solid ${sort === o.key ? accent : '#27272a'}`,
              borderRadius: 5,
              cursor: 'pointer',
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {o.label}
          </button>
        ))}
        <button
          onClick={toggleBuyable}
          aria-pressed={buyableOnly}
          style={{
            padding: '6px 12px',
            background: buyableOnly ? 'var(--rpc-red)' : '#0d0d0d',
            color: buyableOnly ? '#fff' : 'rgba(255,255,255,0.75)',
            border: `1px solid ${buyableOnly ? 'var(--rpc-red)' : '#27272a'}`,
            borderRadius: 5,
            cursor: 'pointer',
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Buyable only
        </button>
        <span style={{ marginLeft: 'auto', fontFamily: "var(--font-mono)", fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
          {loading ? 'Loading…' : `${displayRows.length} packs · sorted by ${sortLabel}`}
        </span>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(127,29,29,0.2)', border: '1px solid #7f1d1d', borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: '#F87171', marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {displayRows.map((r) => (
          <GrailCard key={r.dist_id} row={r} accent={accent} collection={collection} />
        ))}
        {!loading && displayRows.length === 0 && !error && (
          <div style={{ padding: 24, fontFamily: "var(--font-mono)", fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center', border: '1px dashed #27272a', borderRadius: 6, gridColumn: '1 / -1' }}>
            {buyableOnly
              ? 'No buyable packs match these grail filters — try toggling Buyable only off to see sold-out chase packs too.'
              : 'No grail-bearing packs matched. Try lowering the filters.'}
          </div>
        )}
      </div>
    </div>
  )
}

function GrailCard({ row, accent, collection }: { row: GrailRow; accent: string; collection: string }) {
  const slots = row.meta?.slots ?? SLOT_DEFAULT
  const slotsApprox = row.meta?.slots == null
  const pAtLeast100 = atLeastOnce(row.prob_grail_100_per_slot, slots)
  const pAtLeast1000 = atLeastOnce(row.prob_grail_1000_per_slot, slots)
  const pAtLeastUlt = atLeastOnce(row.prob_ultimate_per_slot, slots)
  const tierBorder = tierColor(row.max_pull_tier)

  const { price, priceLabel } = selectPackPrice(row.meta?.primary_price, row.meta?.secondary_ask)

  return (
    <article style={{ background: '#0d0d0d', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', aspectRatio: '5 / 7', background: '#080808' }}>
        {row.meta?.image_url ? (
          <img src={row.meta.image_url} alt={row.meta?.title ?? row.dist_id} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontFamily: "var(--font-mono)", fontSize: 28 }}>?</div>
        )}
        {/* Chase ribbon */}
        {row.max_pull_fmv != null && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, right: 8, background: 'var(--rpc-red)', color: '#fff', padding: '6px 9px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.5)' }}>
            {row.max_pull_thumbnail && (
              <img src={row.max_pull_thumbnail} alt={row.max_pull_player ?? 'Chase moment'} style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 2, border: `2px solid ${tierBorder}`, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.9 }}>CHASE</div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.max_pull_player ?? '—'}
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>{fmtUsd(row.max_pull_fmv)}</div>
          </div>
        )}
      </div>

      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.04em', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.meta?.title ?? `Pack #${row.dist_id}`}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
            {row.max_pull_set ?? '—'}
          </div>
        </div>

        {/* Stat pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <Pill label={`Grails $100+: ${row.grails_100}`} accent={accent} />
          {/* Tier pills read the SAME `--tier-*` tokens as lib/grail-format's
              tierColor (used for the chase border a few lines up) and as the
              dashboard / simulator / trophy-picker. Until 2026-08-02 they were
              the RETIRED hexes #EC4899 / #F59E0B, so an Ultimate chip rendered
              pink here and orange on /dashboard — and this very card mixed the
              two, token border beside old-hex pill. "Grails $1K+" is a VALUE
              threshold, not a tier, so it takes --rpc-warning (byte-identical
              #F59E0B — no visual change), not a tier token. */}
          {row.grails_1000 > 0 && <Pill label={`Grails $1K+: ${row.grails_1000}`} accent="var(--rpc-warning)" />}
          {row.ultimate_count > 0 && <Pill label={`Ultimate: ${row.ultimate_count}`} accent="var(--tier-ultimate)" />}
          {row.legendary_count > 0 && row.ultimate_count === 0 && <Pill label={`Legendary: ${row.legendary_count}`} accent="var(--tier-legendary)" />}
        </div>

        {/* Probability strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
          <ProbCell label="$100+/pack" value={pAtLeast100} approx={slotsApprox} />
          <ProbCell label="$1K+/pack" value={pAtLeast1000} approx={slotsApprox} />
          <ProbCell label="Ult/pack" value={pAtLeastUlt} approx={slotsApprox} />
        </div>

        {/* Price + CTA */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{priceLabel ?? 'PRICE'}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 800, color: '#fff' }}>{fmtUsd(price)}</div>
          </div>
          <Link
            href={`/${collection}/packs/simulator/${encodeURIComponent(row.dist_id)}`}
            style={{
              padding: '8px 12px',
              background: accent,
              color: '#fff',
              borderRadius: 5,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            Run Simulator
          </Link>
        </div>
      </div>
    </article>
  )
}

// `accent` may now be a CSS variable (a --tier-* token, or the `var(--rpc-red)`
// PackPageClient default), so the old `accent + '22'` / `${accent}55` alpha
// concatenation is unusable — `var(--tier-ultimate)22` is invalid CSS and Chrome
// drops the whole declaration SILENTLY, blanking the chip. tierColorAlpha emits
// color-mix(), which is valid for both hex and var() inputs. Percentages match
// the old hex alphas: 0x22 = 34/255 ~= 13%, 0x55 = 85/255 ~= 33%.
function Pill({ label, accent }: { label: string; accent: string }) {
  return (
    <span style={{ padding: '3px 8px', background: tierColorAlpha(accent, 13), border: `1px solid ${tierColorAlpha(accent, 33)}`, color: accent, borderRadius: 999, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
      {label}
    </span>
  )
}

function ProbCell({ label, value, approx }: { label: string; value: number | null; approx: boolean }) {
  return (
    <div style={{ background: '#080808', border: '1px solid #1f1f22', borderRadius: 4, padding: '5px 6px', textAlign: 'center' }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 8, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}{approx && <span style={{ marginLeft: 3, color: 'var(--rpc-warning)' }}>~</span>}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 800, color: '#fff', marginTop: 1 }}>{fmtPct(value)}</div>
    </div>
  )
}
