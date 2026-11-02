'use client'

// components/packs/WatchChaseButton.tsx
//
// "Alert me" on a Chase left card: POSTs a pack-chase watch to
// /api/alerts/pack-chase (owner resolved from the session server-side). As with
// WatchEditionButton, a signed-out POST is 307'd by the proxy to /login and the
// fetch follows it (405 / res.redirected) — that means "sign in", never "failed".

import Link from 'next/link'
import { useState } from 'react'
import type { ChaseTier } from '@/lib/packs/chase-odds'

const THRESHOLDS = [1.5, 2, 3, 5, 10]

export default function WatchChaseButton({ distId, tier, tierLabel }: { distId: string; tier: ChaseTier; tierLabel: string }) {
  const [open, setOpen] = useState(false)
  const [min, setMin] = useState(2)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'auth'; text: string } | null>(null)

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/alerts/pack-chase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dist_id: distId, tier, min_vs_launch: min }),
      })
      if (res.status === 401 || res.status === 405 || res.redirected) {
        setMsg({ kind: 'auth', text: 'Sign in to set a pack alert.' })
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ kind: 'err', text: typeof data?.error === 'string' ? data.error : 'Could not save the alert.' })
        return
      }
      setMsg({ kind: 'ok', text: 'Watching. Alerts go to the channels linked on your Alerts page.' })
    } catch {
      setMsg({ kind: 'err', text: 'Network error. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-[color:var(--rpc-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)]"
      >
        🔔 Alert me
      </button>
    )
  }

  return (
    <div className="mt-2 rounded-md border border-[color:var(--rpc-border)] p-2 text-xs">
      <label className="flex flex-wrap items-center gap-2 text-[color:var(--rpc-text-secondary)]">
        <span>Alert when {tierLabel} density reaches</span>
        <select
          aria-label="Alert threshold vs launch"
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
          className="rounded border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-1 py-0.5 text-[color:var(--rpc-text-primary)]"
        >
          {THRESHOLDS.map((t) => (
            <option key={t} value={t}>{t}× launch</option>
          ))}
        </select>
      </label>
      <div className="mt-2 flex items-center gap-2">
        {/* brand-exception: white label on the --rpc-red fill */}
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded-md bg-[var(--rpc-red-fill)] px-3 py-1 font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setMsg(null) }} className="text-[color:var(--rpc-text-muted)] underline">
          Cancel
        </button>
      </div>
      {msg && (
        <p role={msg.kind === 'err' ? 'alert' : 'status'} className={'mt-2 ' + (msg.kind === 'err' ? 'text-[color:var(--rpc-danger-text)]' : 'text-[color:var(--rpc-text-secondary)]')}>
          {msg.text}
          {msg.kind === 'auth' && <> <Link href="/login" className="underline">Sign in</Link></>}
          {msg.kind === 'ok' && <> <Link href="/alerts" className="underline">Alerts page</Link></>}
        </p>
      )}
    </div>
  )
}
