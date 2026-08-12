"use client"

import { useEffect, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"

// Recent-sales strip rendered inside a moment row's expand panel.
// Extracted verbatim from the collection page in the Phase 1 refactor.
export default function EditionRecentSales({ editionKey, mintCount }: { editionKey: string | null; mintCount?: number | null }) {
  const [sales, setSales] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // "No recent sales" is a market fact a collector prices against. It may only
  // be stated off a response we actually received.
  const [failed, setFailed] = useState(false)

  useEffect(function() {
    if (!editionKey) { setSales([]); setLoading(false); return }
    // Guard against a stale response painting over a newer one when editionKey
    // changes mid-flight, and reset prior sales so the loading state shows.
    let cancelled = false
    setSales([])
    setFailed(false)
    setLoading(true)
    fetchJson<{ sales?: any[] }>("/api/recent-sales?editionKey=" + encodeURIComponent(editionKey) + "&limit=5")
      .then(function(res) {
        if (cancelled) return
        setFailed(!res.ok)
        if (res.ok) setSales(res.json?.sales ?? [])
      })
      .catch(function() {})
      .finally(function() { if (!cancelled) setLoading(false) })
    return function() { cancelled = true }
  }, [editionKey])

  if (!editionKey) return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--rpc-text-muted)]">Recent Sales</div>
      <div className="text-xs text-[color:var(--rpc-text-muted)]">—</div>
    </div>
  )

  if (loading) return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--rpc-text-muted)]">Recent Sales</div>
      <div className="text-xs text-[color:var(--rpc-text-muted)] animate-pulse">Loading sales...</div>
    </div>
  )

  if (failed) return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--rpc-text-muted)]">Recent Sales</div>
      <div className="text-xs text-[color:var(--rpc-text-muted)]">Couldn&apos;t load recent sales</div>
    </div>
  )

  if (!sales.length) return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--rpc-text-muted)]">Recent Sales</div>
      <div className="text-xs text-[color:var(--rpc-text-muted)]">No recent sales</div>
    </div>
  )

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--rpc-text-muted)]">Recent Sales</div>
      <div className="space-y-1.5">
        {sales.map(function(s: any, i: number) {
          const age = s.soldAt ? Math.round((Date.now() - new Date(s.soldAt).getTime()) / 60000) : null
          const ageStr = age === null ? "—" : age < 60 ? age + "m ago" : age < 1440 ? Math.round(age / 60) + "h ago" : Math.round(age / 1440) + "d ago"
          const serialStr = s.serialNumber ? ("#" + s.serialNumber + (mintCount ? " / " + mintCount : "")) : "—"
          return (
            <div key={i} className="flex items-center justify-between text-xs gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[color:var(--rpc-text-secondary)] shrink-0">{serialStr}</span>
                <span className="text-[color:var(--rpc-text-muted)] shrink-0">{ageStr}</span>
                {s.buyerUsername && <span className="text-[color:var(--rpc-text-muted)] truncate">→ {s.buyerUsername}</span>}
              </div>
              <span className="font-semibold text-emerald-400 shrink-0">{s.price ? "$" + Number(s.price).toFixed(2) : "—"}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
