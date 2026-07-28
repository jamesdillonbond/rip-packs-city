"use client"

import { useEffect, useState } from "react"

// Recent-sales panel for /[collection]/collection.
//
// Extracted verbatim from the WalletMomentsBody monolith (Phase 2 of
// docs/audits/refactor-plan-monolith-pages-2026-05.md) — it was the most
// isolated useState cluster in that component: `recentSales` + `salesLoading`
// were read by nothing except their own fetch and their own JSX block.
//
// NOTE the feed is NOT wallet-scoped — `/api/recent-sales?limit=15` takes no
// wallet argument, so this is the platform's recent-sales tape, refreshed as a
// side effect of the user running a wallet search. That is the pre-existing
// behaviour and is preserved exactly; `searchNonce` is simply the parent
// re-firing signal (it increments once per runSearch, where the parent used to
// call setRecentSales([]) + setSalesLoading(true) inline).

export interface RecentSaleRow {
  playerName?: string | null
  setName?: string | null
  serialNumber?: number | string | null
  price?: number | string | null
  fmv?: number | null
  soldAt?: string | null
}

export default function CollectionRecentSales({
  searchNonce,
  visible,
}: {
  /** Increments once per wallet search. 0 = no search has run yet. */
  searchNonce: number
  /** Parent's `hasSearched` — the panel stays hidden until results land. */
  visible: boolean
}) {
  const [recentSales, setRecentSales] = useState<RecentSaleRow[]>([])
  const [salesLoading, setSalesLoading] = useState(false)

  useEffect(function () {
    if (searchNonce === 0) return
    // Guard against a slow response from search N landing after search N+1.
    // The inline version had no such guard; moving the fetch into an effect
    // makes the overlap easier to hit, so it is added deliberately here.
    let cancelled = false
    setRecentSales([])
    setSalesLoading(true)
    fetch("/api/recent-sales?limit=15")
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { if (!cancelled && d && d.sales) setRecentSales(d.sales) })
      .catch(function () {})
      .finally(function () { if (!cancelled) setSalesLoading(false) })
    return function () { cancelled = true }
  }, [searchNonce])

  // Same gate as the inline block: hasSearched && (recentSales.length > 0 || salesLoading)
  if (!visible || (recentSales.length === 0 && !salesLoading)) return null

  return (
    <div className="mb-5 rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Recent Sales</div>
        <div className="text-[10px] text-[color:var(--rpc-text-muted)]">{recentSales.length} sales</div>
      </div>
      {salesLoading ? (
        <div className="text-xs text-[color:var(--rpc-text-muted)]">Loading sales history…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[color:var(--rpc-border)]">
                <th className="text-left pb-2 text-[color:var(--rpc-text-muted)] font-medium">Player</th>
                <th className="text-right pb-2 text-[color:var(--rpc-text-muted)] font-medium">Serial</th>
                <th className="text-right pb-2 text-[color:var(--rpc-text-muted)] font-medium">Price</th>
                <th className="text-right pb-2 text-[color:var(--rpc-text-muted)] font-medium">vs FMV</th>
                <th className="text-right pb-2 text-[color:var(--rpc-text-muted)] font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--rpc-border)]">
              {recentSales.map(function (s: any, i: number) {
                const pct = s.fmv && s.fmv > 0 ? Math.round(((s.price - s.fmv) / s.fmv) * 100) : null;
                const age = s.soldAt ? Math.round((Date.now() - new Date(s.soldAt).getTime()) / 60000) : null;
                const ageStr = age === null ? "—" : age < 60 ? age + "m ago" : age < 1440 ? Math.round(age/60) + "h ago" : Math.round(age/1440) + "d ago";
                return (
                  <tr key={i} className="hover:bg-[var(--rpc-surface)]">
                    <td className="py-1.5 pr-3">
                      <div className="font-medium text-[color:var(--rpc-text-primary)]">{s.playerName ?? "—"}</div>
                      <div className="text-[color:var(--rpc-text-muted)]">{s.setName ?? ""}</div>
                    </td>
                    <td className="py-1.5 text-right text-[color:var(--rpc-text-secondary)]">#{s.serialNumber}</td>
                    <td className="py-1.5 text-right font-semibold text-emerald-400">{s.price ? "$" + Number(s.price).toFixed(2) : "—"}</td>
                    <td className="py-1.5 text-right">
                      {pct !== null ? (
                        <span className={"font-semibold " + (pct >= 0 ? "text-emerald-400" : "text-red-400")}>{pct >= 0 ? "+" : ""}{pct}%</span>
                      ) : <span className="text-[color:var(--rpc-text-muted)]">—</span>}
                    </td>
                    <td className="py-1.5 text-right text-[color:var(--rpc-text-muted)]">{ageStr}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
