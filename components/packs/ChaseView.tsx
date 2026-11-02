'use client'

// components/packs/ChaseView.tsx
//
// "Chase left" view on the Top Shot packs board: where a tier's moments are
// still sealed, as an average per 100 sealed packs today vs at launch. Reads
// /api/packs/chase (Dapper's live per-tier counts via the Atlas lane). Math and
// honesty rules: lib/packs/chase-odds.ts.
//
// THREE STATES, never two (CLAUDE.md "Honesty"): a failed read says it failed
// and offers a retry; an ok-and-empty read says nothing matched; rows render
// only from an ok read. The discriminator is fetchJson's `ok`, never the body.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchJson } from '@/lib/analytics/fetch-json'
import { accentFill, labelOn } from '@/lib/accent-text'
import { tierColor } from '@/lib/grail-format'
import { relTimeShort } from '@/lib/pack-dist-format'
import { proxyIpfsImageUrl } from '@/lib/ipfs-media'
import PackThumb from './PackThumb'
import WatchChaseButton from './WatchChaseButton'
import {
  fmtPer100,
  fmtVsLaunch,
  type ChaseRow,
  type ChaseSort,
  type ChaseTier,
} from '@/lib/packs/chase-odds'

const TIER_OPTIONS: { key: ChaseTier; label: string }[] = [
  { key: 'legendary', label: 'Legendary' },
  { key: 'ultimate', label: 'Ultimate' },
  { key: 'rare', label: 'Rare' },
]

const SORT_OPTIONS: { key: ChaseSort; label: string }[] = [
  { key: 'vsLaunch', label: 'Richest vs launch' },
  { key: 'now', label: 'Most per pack now' },
  { key: 'remaining', label: 'Most left' },
]

interface ChaseResponse {
  rows: ChaseRow[]
  total: number
  refuted: number
}

// Each settled answer carries the request it answers; while it does not match
// the current request, the view is loading. Derived, so the effect never has to
// set a "loading" state synchronously (react-hooks/set-state-in-effect).
type Settled =
  | { key: string; kind: 'failed' }
  | { key: string; kind: 'ok'; rows: ChaseRow[]; total: number }

type LoadState = { kind: 'loading' } | Settled

interface Props {
  collection: string
  accent: string
}

export default function ChaseView({ collection, accent }: Props) {
  const [tier, setTier] = useState<ChaseTier>('legendary')
  const [sort, setSort] = useState<ChaseSort>('vsLaunch')
  const [buyableOnly, setBuyableOnly] = useState(true)
  const [settled, setSettled] = useState<Settled | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const params = new URLSearchParams({ collection, tier, sort, limit: '60' })
  if (buyableOnly) params.set('buyableOnly', 'true')
  const requestUrl = '/api/packs/chase?' + params.toString()
  const requestKey = `${requestUrl}#${reloadKey}`

  useEffect(() => {
    let cancelled = false
    void fetchJson<ChaseResponse>(requestUrl).then((res) => {
      if (cancelled) return
      if (!res.ok || !res.json || !Array.isArray(res.json.rows)) {
        setSettled({ key: requestKey, kind: 'failed' })
        return
      }
      setSettled({ key: requestKey, kind: 'ok', rows: res.json.rows, total: Number(res.json.total) || res.json.rows.length })
    })
    return () => { cancelled = true }
  }, [requestUrl, requestKey])

  const state: LoadState = settled && settled.key === requestKey ? settled : { kind: 'loading' }

  const tierLabel = TIER_OPTIONS.find((t) => t.key === tier)?.label ?? tier

  return (
    <div>
      <p className="mb-3 text-xs text-[color:var(--rpc-text-secondary)]" style={{ maxWidth: 720 }}>
        Where the {tierLabel} moments of each drop are still sealed, from Dapper&apos;s live pack counts. The figure is an
        average across the packs still unopened, compared with the same drop at launch. It is not a per-pack chance:
        Dapper&apos;s slot rules decide how those moments are spread, and most packs hold none.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--rpc-text-secondary)]">Tier</span>
        {TIER_OPTIONS.map((o) => (
          <ToggleButton key={o.key} active={tier === o.key} accent={accent} onClick={() => setTier(o.key)}>{o.label}</ToggleButton>
        ))}
        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--rpc-text-secondary)]">Sort</span>
        {SORT_OPTIONS.map((o) => (
          <ToggleButton key={o.key} active={sort === o.key} accent={accent} onClick={() => setSort(o.key)}>{o.label}</ToggleButton>
        ))}
        <ToggleButton active={buyableOnly} accent={accent} onClick={() => setBuyableOnly((v) => !v)} pressed>
          Buyable only
        </ToggleButton>
        <span className="ml-auto font-mono text-[10px] text-[color:var(--rpc-text-muted)]">
          {state.kind === 'loading'
            ? 'Loading…'
            : state.kind === 'ok'
              ? `${state.rows.length < state.total ? `Top ${state.rows.length} of ${state.total.toLocaleString('en-US')}` : state.total.toLocaleString('en-US')} pack${state.total === 1 ? '' : 's'}`
              : ''}
        </span>
      </div>

      {state.kind === 'failed' && (
        <div role="alert" className="mb-3 rounded-md border border-[color:var(--rpc-danger)] p-3 font-mono text-xs text-[color:var(--rpc-danger-text)]">
          Couldn&apos;t load the live pack counts, so nothing is shown here.{' '}
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="underline">Try again</button>
        </div>
      )}

      {state.kind === 'ok' && state.rows.length === 0 && (
        <div className="rounded-md border border-dashed border-[color:var(--rpc-border)] p-6 text-center font-mono text-xs text-[color:var(--rpc-text-muted)]">
          {buyableOnly
            ? `No buyable pack still holds a ${tierLabel} moment in Dapper's latest counts. Turn off "Buyable only" to include packs that are sealed but not listed.`
            : `No sealed pack still holds a ${tierLabel} moment in Dapper's latest counts.`}
        </div>
      )}

      {state.kind === 'ok' && state.rows.length > 0 && (
        <ol className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
          {state.rows.map((r, i) => (
            <ChaseCard key={r.distId} row={r} rank={i + 1} collection={collection} tierLabel={tierLabel} />
          ))}
        </ol>
      )}
    </div>
  )
}

function ToggleButton({ active, accent, onClick, pressed, children }: { active: boolean; accent: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed ? active : undefined}
      className={'rounded-md border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition ' + (active ? '' : 'border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)]')}
      style={active ? { backgroundColor: accentFill(accent), color: labelOn(accent), borderColor: accentFill(accent) } : undefined}
    >
      {children}
    </button>
  )
}

function ChaseCard({ row, rank, collection, tierLabel }: { row: ChaseRow; rank: number; collection: string; tierLabel: string }) {
  const color = tierColor(row.tier)
  const improved = row.vsLaunch != null && row.vsLaunch > 1.1
  const worse = row.vsLaunch != null && row.vsLaunch < 0.9
  const age = relTimeShort(row.asOf)
  return (
    <li className="flex min-w-0 gap-3 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="shrink-0" style={{ width: 64 }}>
        <PackThumb src={proxyIpfsImageUrl(row.imageUrl, 160) ?? row.imageUrl} alt={row.title} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className="font-mono text-[10px] text-[color:var(--rpc-text-muted)]">#{rank}</span>
          <Link
            href={`/${collection}/pack/dist/${encodeURIComponent(row.distId)}`}
            className="min-w-0 flex-1 truncate font-semibold text-[color:var(--rpc-text-primary)] hover:underline"
            title={row.title}
          >
            {row.title}
          </Link>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-xl font-extrabold text-[color:var(--rpc-text-primary)]">{fmtPer100(row.per100Now)}</span>
          <span className="text-xs text-[color:var(--rpc-text-secondary)]">{tierLabel} per 100 sealed packs</span>
        </div>
        <div className="mt-0.5 text-xs text-[color:var(--rpc-text-secondary)]">
          Launch {fmtPer100(row.per100Launch)} ·{' '}
          <span style={{ color: improved ? 'var(--rpc-success-text)' : worse ? 'var(--rpc-warning-text)' : undefined }}>
            {fmtVsLaunch(row.vsLaunch)}
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-[color:var(--rpc-text-muted)]">
          {row.remaining.toLocaleString('en-US')} of {row.original.toLocaleString('en-US')} {tierLabel} left in{' '}
          {row.unopened.toLocaleString('en-US')} of {row.totalPacks.toLocaleString('en-US')} packs
          {age ? ` · as of ${age}` : ''}
          {row.buyable ? ' · buyable' : ''}
        </div>
        <WatchChaseButton distId={row.distId} tier={row.tier} tierLabel={tierLabel} />
      </div>
    </li>
  )
}
