'use client'

// components/alerts/PackChaseWatches.tsx
//
// "Pack chase watches" on /alerts: the reader's Top Shot pack-chase watches
// (/api/alerts/pack-chase), each with its CURRENT density vs launch. Three states
// per leg (CLAUDE.md "Honesty"): a failed list read never reads as "no watches",
// and a failed or unknowable reading never reads as a 0 — it says "unknown".

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { fmtPer100, fmtVsLaunch } from '@/lib/packs/chase-odds'
import { relTimeShort } from '@/lib/pack-dist-format'

interface Reading { remaining: number; unopened: number; per100Now: number; per100Launch: number; vsLaunch: number; asOf: string }
interface Watch {
  id: string
  dist_id: string
  title: string | null
  tier: string
  min_vs_launch: number
  armed: boolean
  last_fired_at: string | null
  reading: Reading | null
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ok'; watches: Watch[]; readingsOk: boolean }

function tierWord(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export default function PackChaseWatches() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [actionErr, setActionErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/alerts/pack-chase')
      .then(async (res) => {
        if (!res.ok || res.redirected) throw new Error(String(res.status))
        const j = (await res.json()) as { watches?: unknown; readings_ok?: unknown }
        if (!Array.isArray(j.watches)) throw new Error('shape')
        if (!cancelled) setState({ kind: 'ok', watches: j.watches as Watch[], readingsOk: j.readings_ok === true })
      })
      .catch(() => { if (!cancelled) setState({ kind: 'failed' }) })
    return () => { cancelled = true }
  }, [reload])

  async function remove(w: Watch) {
    setActionErr(null)
    try {
      const res = await fetch(`/api/alerts/pack-chase?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(String(res.status))
      setReload((k) => k + 1)
    } catch {
      setActionErr("Couldn't remove that watch. Try again.")
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 14px 0' }}>
        Pack chase watches
      </h2>
      <p style={{ color: 'var(--rpc-text-secondary)', fontSize: 13, marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
        Get told when a Top Shot pack&apos;s Legendary, Ultimate or Rare moments per sealed pack reach a multiple of its
        launch rate. Add one from the <Link href="/nba-top-shot/packs" style={{ textDecoration: 'underline' }}>packs board</Link>&apos;s
        “Chase left” view. Alerts go to the channels linked above, once a day at most per watch.
      </p>
      {actionErr && <p role="alert" style={{ color: 'var(--rpc-danger-text)', fontSize: 13 }}>{actionErr}</p>}
      {state.kind === 'loading' ? (
        <p style={{ color: 'var(--rpc-text-muted)' }}>Loading…</p>
      ) : state.kind === 'failed' ? (
        <p role="alert" style={{ color: 'var(--rpc-warning-text)' }}>
          Couldn&apos;t load your pack chase watches just now — this says nothing about what you are watching.{' '}
          <button type="button" onClick={() => { setState({ kind: 'loading' }); setReload((k) => k + 1) }} style={{ textDecoration: 'underline', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>
            Try again
          </button>
        </p>
      ) : state.watches.length === 0 ? (
        <p style={{ color: 'var(--rpc-text-muted)' }}>No pack chase watches yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {!state.readingsOk && (
            <p style={{ color: 'var(--rpc-warning-text)', fontSize: 12 }}>Current pack counts couldn&apos;t be loaded; readings show as unknown.</p>
          )}
          {state.watches.map((w) => (
            <div key={w.id} style={{ padding: 14, background: 'var(--rpc-surface)', border: '1px solid var(--rpc-border)', borderRadius: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{w.title ?? `Pack #${w.dist_id}`}</div>
                  <div style={{ fontSize: 12, color: 'var(--rpc-text-secondary)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    {tierWord(w.tier)} at ≥ {w.min_vs_launch}× launch ·{' '}
                    {w.reading
                      ? `now ${fmtPer100(w.reading.per100Now)} per 100 sealed packs (${fmtVsLaunch(w.reading.vsLaunch)}) · as of ${relTimeShort(w.reading.asOf)}`
                      : 'current reading unknown'}
                    {w.last_fired_at ? ` · last alert ${relTimeShort(w.last_fired_at)}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Link href={`/nba-top-shot/pack/dist/${encodeURIComponent(w.dist_id)}`} style={{ fontSize: 12, textDecoration: 'underline' }}>View</Link>
                  <button type="button" onClick={() => remove(w)} style={{ fontSize: 12, color: 'var(--rpc-red-text)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
