"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import type { LenderPerformanceRow } from "@/lib/analytics-types"
import {
  useResolveUsernames,
  displayName as resolveDisplayName,
  truncateAddress,
} from "@/lib/analytics/username-resolver"

interface LenderPerformanceTableProps {
  collections: string[]
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$0"
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return Math.round(n).toString()
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(2)}%`
}

function identicon(addr: string): string {
  const hex = (addr || "").replace(/[^0-9a-f]/gi, "").slice(-6) || "10b981"
  return `#${hex}`
}

function yieldClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-slate-300"
  if (n > 0.01) return "text-emerald-400"
  if (n < -0.01) return "text-rose-400"
  return "text-slate-300"
}

function defaultRateClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-slate-300"
  if (n >= 20) return "text-rose-400"
  if (n >= 10) return "text-amber-400"
  return "text-slate-300"
}

export default function LenderPerformanceTable({
  collections,
}: LenderPerformanceTableProps) {
  const [rows, setRows] = useState<LenderPerformanceRow[]>([])
  const [loading, setLoading] = useState(true)

  const collectionsKey = useMemo(() => collections.join(","), [collections])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = new URLSearchParams()
    if (collections.length > 0) qs.set("collections", collections.join(","))
    qs.set("min_loans", "5")
    qs.set("limit", "25")
    fetch(`/api/analytics/loans/lender-performance?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j) => {
        if (cancelled) return
        const list = (j as { rows?: LenderPerformanceRow[] })?.rows ?? []
        setRows(list)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionsKey])

  const addrs = useMemo(() => rows.map((r) => r.addr), [rows])
  const names = useResolveUsernames(addrs)

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-slate-800">
        <div>
          <h3 className="font-semibold text-slate-100">Top Lenders by realized yield</h3>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mt-0.5">
            Completed loans
          </div>
        </div>
        <span className="rounded border border-emerald-500/30 px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-emerald-400">
          Realized yield
        </span>
      </div>
      <div className="px-4 py-2 border-b border-slate-800 text-[11px] text-slate-500 leading-relaxed">
        Realized yield = (interest earned − principal lost to defaults) / principal at risk.
        Reflects completed loans only. Active loans excluded since their outcomes are pending.
        Lenders with fewer than 5 completed loans excluded.
      </div>
      <div className="overflow-x-auto" style={{ maxHeight: 420 }}>
        {loading ? (
          <div className="p-6 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            No qualifying lenders in this filter.
          </div>
        ) : (
          <table className="w-full text-sm min-w-[680px]">
            <thead className="sticky top-0 bg-slate-900/80 backdrop-blur">
              <tr className="text-[10px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
                <th className="py-2 px-3 text-left font-semibold w-8">#</th>
                <th className="py-2 px-3 text-left font-semibold">Wallet</th>
                <th className="py-2 px-3 text-right font-semibold">Loans</th>
                <th className="py-2 px-3 text-right font-semibold">Principal</th>
                <th className="py-2 px-3 text-right font-semibold">Interest</th>
                <th className="py-2 px-3 text-right font-semibold">Yield</th>
                <th className="py-2 px-3 text-right font-semibold">Default</th>
                <th className="py-2 px-3 text-right font-semibold">Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const display = resolveDisplayName(r.addr, names)
                const truncated = truncateAddress(r.addr)
                return (
                  <tr
                    key={r.addr}
                    className="border-b border-slate-800/40 last:border-b-0"
                  >
                    <td className="py-2.5 px-3 text-slate-500 tabular-nums">{r.rank}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-5 w-5 rounded-full flex-shrink-0 ring-1 ring-slate-700"
                          style={{ background: identicon(r.addr) }}
                        />
                        <Link
                          href={`/analytics/wallets/${r.addr}`}
                          className="min-w-0 hover:text-emerald-400 transition-colors"
                          title={r.addr}
                        >
                          <div className="text-slate-200 truncate">{display}</div>
                          {display !== truncated ? (
                            <div className="text-[10px] text-slate-500 font-mono truncate">
                              {truncated}
                            </div>
                          ) : null}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {fmtNumber(r.total_loans)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-100 tabular-nums">
                      {fmtUsd(r.total_principal_usd)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {fmtUsd(r.interest_earned_usd)}
                    </td>
                    <td
                      className={
                        "py-2.5 px-3 text-right tabular-nums font-medium " +
                        yieldClass(r.realized_yield_pct)
                      }
                    >
                      {fmtPct(r.realized_yield_pct)}
                    </td>
                    <td
                      className={
                        "py-2.5 px-3 text-right tabular-nums " +
                        defaultRateClass(r.default_rate_pct)
                      }
                    >
                      {fmtPct(r.default_rate_pct)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-400 tabular-nums">
                      {fmtNumber(r.active_loans)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
