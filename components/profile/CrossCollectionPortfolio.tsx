'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCollection } from '@/lib/collections'
import { formatClosedOn } from '@/lib/market-closed'

type CollectionRow = {
  collection_name: string
  collection_slug: string
  total_moments: number
  wallet_fmv: number
  locked_fmv: number
  unlocked_fmv: number
  locked_count: number
  unlocked_count: number
  cost_basis: number | null
  pnl: number | null
  // ISO date the collection's market closed, or null for a live market. When
  // set, this collection's moments are counted but its dead-market value is
  // excluded from Total FMV — the card shows a count + note, not a dollar.
  market_closed_at?: string | null
}

type PortfolioResponse = {
  wallet?: string
  total_moments?: number
  total_fmv?: number
  total_locked_fmv?: number
  total_unlocked_fmv?: number
  total_locked?: number
  total_unlocked?: number
  total_cost_basis?: number | null
  total_pnl?: number | null
  collections?: CollectionRow[]
  collection_count?: number
}

const monoFont = "var(--font-mono)"
const condensedFont = "var(--font-display)"

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—'
  // Place the sign BEFORE the $ so a negative P&L reads "-$1,500", not "$-1,500".
  // (Math.abs previously only picked the k/plain branch, leaking the minus inside.)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1000) return sign + '$' + Math.round(abs).toLocaleString()
  return sign + '$' + abs.toFixed(2)
}

export default function CrossCollectionPortfolio({ wallet, walletQuery }: { wallet: string; walletQuery: string }) {
  const router = useRouter()
  const [data, setData] = useState<PortfolioResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!wallet) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/portfolio?wallet=${encodeURIComponent(wallet)}`)
      .then(r => r.json())
      .then(json => { if (!cancelled) { setData(json); setLoading(false) } })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [wallet])

  if (loading || !data || !data.collections || data.collections.length === 0) return null

  const totalFmv = Number(data.total_fmv ?? 0)
  const totalMoments = Number(data.total_moments ?? 0)
  const collectionCount = Number(data.collection_count ?? data.collections.length)
  const totalPnl = data.total_pnl != null ? Number(data.total_pnl) : null
  const pnlColor = totalPnl == null ? 'rgba(255,255,255,0.5)' : totalPnl >= 0 ? '#10B981' : '#EF4444'
  // Closed markets are excluded from Total FMV (a closed market has no current
  // value). Scale the bars over live collections only so a dead-market row
  // doesn't distort the live ones.
  const closedRows = data.collections.filter(c => c.market_closed_at)
  const maxFmv = Math.max(...data.collections.filter(c => !c.market_closed_at).map(c => Number(c.wallet_fmv ?? 0)), 1)
  const closedDisclosure =
    closedRows.length > 0
      ? `${closedRows.map(c => c.collection_name).join(', ')} ${closedRows.length === 1 ? 'market is' : 'markets are'} closed — moments are counted but excluded from Total FMV.`
      : null

  return (
    <section style={{ marginBottom: 18, padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700 }}>
          ◇ Cross-Collection Portfolio
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <Stat label="Total FMV" value={fmtUsd(totalFmv)} accent="var(--rpc-red)" big />
        <Stat label="Moments" value={totalMoments.toLocaleString()} accent="#A855F7" />
        <Stat label="Collections" value={String(collectionCount)} accent="#4F94D4" />
        <Stat label="Total P&L" value={totalPnl == null ? '—' : (totalPnl >= 0 ? '+' : '') + fmtUsd(totalPnl)} accent={pnlColor} />
      </div>

      {closedDisclosure && (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, marginBottom: 14, padding: '8px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6 }}>
          {closedDisclosure}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
        {data.collections.map(c => {
          const meta = getCollection(c.collection_slug)
          const accent = meta?.accent ?? 'var(--rpc-red)'
          const icon = meta?.icon ?? '◇'
          const isClosed = !!c.market_closed_at
          const fmv = Number(c.wallet_fmv ?? 0)
          const lockedPct = fmv > 0 ? Math.round((Number(c.locked_fmv ?? 0) / fmv) * 100) : 0
          const barPct = fmv > 0 ? Math.max(4, Math.round((fmv / maxFmv) * 100)) : 0
          return (
            <button
              key={c.collection_slug}
              onClick={() => router.push(`/${c.collection_slug}/collection?q=${encodeURIComponent(walletQuery)}`)}
              style={{
                textAlign: 'left',
                background: 'rgba(13,13,13,0.85)',
                border: `1px solid ${accent}33`,
                borderRadius: 8,
                padding: 12,
                cursor: 'pointer',
                color: '#fff',
                transition: 'border-color 120ms',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${accent}AA` }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${accent}33` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#fff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.collection_name}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontFamily: monoFont, color: 'rgba(255,255,255,0.5)' }}>{Number(c.total_moments ?? 0).toLocaleString()} moments</span>
                <span style={{ fontSize: 10, fontFamily: monoFont, color: isClosed ? 'rgba(255,255,255,0.4)' : accent, fontWeight: 700 }}>{isClosed ? 'market closed' : fmtUsd(fmv)}</span>
              </div>
              {isClosed ? (
                <div style={{ fontSize: 9, fontFamily: monoFont, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em', lineHeight: 1.4 }}>
                  closed {formatClosedOn(String(c.market_closed_at).slice(0, 10))} · not in total
                </div>
              ) : (
                <>
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}>
                    <div style={{ width: `${barPct}%`, height: '100%', background: accent }} />
                  </div>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em' }}>
                    {lockedPct}% locked
                  </div>
                </>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function Stat({ label, value, accent, big }: { label: string; value: string; accent: string; big?: boolean }) {
  return (
    <div style={{ background: 'rgba(13,13,13,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 8, fontFamily: monoFont, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: big ? 24 : 18, color: accent, lineHeight: 1 }}>{value}</div>
    </div>
  )
}
