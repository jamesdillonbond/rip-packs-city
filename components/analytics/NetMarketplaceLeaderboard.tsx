"use client"

// Net Marketplace activity leaderboard — wallets ranked by combined Flowty
// buy + sell volume in the selected window. Net position is colored:
//   green = net seller (sold more than they bought)
//   red   = net buyer  (bought more than they sold)

import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowRight, TrendingUp } from "lucide-react"
import WalletIdenticon from "@/components/analytics/WalletIdenticon"
import type { NetMarketplaceResponse, NetMarketplaceRow } from "@/lib/analytics-types"

const COLLECTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "topshot", label: "Top Shot" },
  { value: "allday", label: "All Day" },
  { value: "golazos", label: "Golazos" },
  { value: "pinnacle", label: "Pinnacle" },
  { value: "ufc", label: "UFC" },
]

const DAYS_OPTIONS = [7, 30, 90] as const

function fmtUsd(n: number): string {
  const abs = Math.abs(n)
  if (!Number.isFinite(abs) || abs === 0) return "$0"
  if (abs >= 1_000_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}k`
  if (abs >= 100) return `${n < 0 ? "-" : ""}$${abs.toFixed(0)}`
  return `${n < 0 ? "-" : ""}$${abs.toFixed(2)}`
}

function truncateAddr(addr: string): string {
  const a = (addr || "").toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export default function NetMarketplaceLeaderboard() {
  const [collection, setCollection] = useState<string>("all")
  const [days, setDays] = useState<number>(30)
  const [resp, setResp] = useState<NetMarketplaceResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const url = `/api/analytics/wallets/net-marketplace?collection=${encodeURIComponent(collection)}&days=${days}&limit=15`
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setResp(j as NetMarketplaceResponse) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [collection, days])

  const rows: NetMarketplaceRow[] = resp?.rows ?? []

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-emerald-400" />
            <h2 className="text-lg font-semibold text-zinc-100">Net Marketplace Activity</h2>
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            Wallets ranked by combined buy + sell activity on Flowty. Net position in green = net seller, red = net buyer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-wrap gap-1.5">
            {COLLECTION_OPTIONS.map((c) => {
              const active = collection === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCollection(c.value)}
                  className={
                    "rounded-full px-2.5 py-1 text-[11px] uppercase tracking-widest border transition-colors " +
                    (active
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")
                  }
                >
                  {c.label}
                </button>
              )
            })}
          </div>
          <div className="flex gap-1.5">
            {DAYS_OPTIONS.map((d) => {
              const active = days === d
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={
                    "rounded-full px-2.5 py-1 text-[11px] uppercase tracking-widest border transition-colors " +
                    (active
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")
                  }
                >
                  {d}d
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="h-32 animate-pulse bg-zinc-900/60" />
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No Flowty marketplace activity in this window.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800">
                  <th className="py-2 px-3 text-left font-semibold w-10">#</th>
                  <th className="py-2 px-3 text-left font-semibold">Wallet</th>
                  <th className="py-2 px-3 text-right font-semibold">Gross</th>
                  <th className="py-2 px-3 text-right font-semibold">Net</th>
                  <th className="py-2 px-3 text-right font-semibold">Buys</th>
                  <th className="py-2 px-3 text-right font-semibold">Sells</th>
                  <th className="py-2 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isNetSeller = row.net_position_usd < 0
                  // net_position_usd = buy - sell. Negative net = net seller (green).
                  const netColor = row.net_position_usd === 0
                    ? "var(--rpc-text-muted)"
                    : isNetSeller
                      ? "var(--rpc-success)"
                      : "var(--rpc-danger)"
                  return (
                    <tr
                      key={row.address}
                      className="border-b border-zinc-800/40 last:border-b-0 hover:bg-zinc-900/40 transition-colors"
                    >
                      <td className="py-2.5 px-3 text-zinc-500 tabular-nums">{row.rank}</td>
                      <td className="py-2.5 px-3">
                        <Link
                          href={`/analytics/wallets/${row.address}`}
                          className="flex items-center gap-2 min-w-0"
                        >
                          <WalletIdenticon addr={row.address} size={28} />
                          <div className="min-w-0">
                            <div className="text-zinc-200 font-mono text-[12px] truncate">
                              {truncateAddr(row.address)}
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 text-right text-zinc-100 tabular-nums font-medium">
                        {fmtUsd(row.gross_activity_usd)}
                      </td>
                      <td
                        className="py-2.5 px-3 text-right tabular-nums font-medium"
                        style={{ color: netColor }}
                      >
                        {row.net_position_usd > 0 ? "+" : ""}
                        {fmtUsd(row.net_position_usd)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-zinc-300 tabular-nums">
                        <span className="text-zinc-500 text-[10px]">{row.buy_tx_count}</span>{" "}
                        <span className="text-zinc-300">{fmtUsd(row.buy_volume_usd)}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-zinc-300 tabular-nums">
                        <span className="text-zinc-500 text-[10px]">{row.sell_tx_count}</span>{" "}
                        <span className="text-zinc-300">{fmtUsd(row.sell_volume_usd)}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Link
                          href={`/analytics/wallets/${row.address}`}
                          className="inline-flex items-center text-zinc-500 hover:text-emerald-400 transition-colors"
                          aria-label="View wallet profile"
                        >
                          <ArrowRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
