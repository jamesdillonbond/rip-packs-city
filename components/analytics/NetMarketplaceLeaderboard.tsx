"use client"

// Net Marketplace activity leaderboard — wallets ranked by combined Flowty
// buy + sell volume in the selected window. Net position is colored:
//   green = net seller (sold more than they bought)  — net_position_usd > 0
//   red   = net buyer  (bought more than they sold)  — net_position_usd < 0
// net_position_usd = sell_volume - buy_volume, as the SQL computes it. Until
// 2026-10-10 (#178) this file read it the other way round and coloured every
// net seller red; the sign is pinned by the component test now.
//
// 2026-10-10 (#178): Flowty's marketplace went dormant on 2026-05-14, so the
// API anchors the window to that date and answers `as_of` + `archived`. The
// copy here says which window it is showing ("Flowty's final 30 days, to
// 14 May 2026") instead of implying a live feed.

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { ArrowRight, TrendingUp } from "lucide-react"
import WalletIdenticon from "@/components/analytics/WalletIdenticon"
import { useResolveUsernames } from "@/lib/analytics/username-resolver"
import type { NetMarketplaceResponse, NetMarketplaceRow } from "@/lib/analytics-types"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { formatClosedOn } from "@/lib/market-closed"

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
  // "No activity in this window" is a claim about the marketplace. It may only
  // be made off a response we actually received.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const url = `/api/analytics/wallets/net-marketplace?collection=${encodeURIComponent(collection)}&days=${days}&limit=15`
    fetchJson<NetMarketplaceResponse>(url)
      .then((res) => {
        if (cancelled) return
        setFailed(!res.ok)
        if (res.ok) setResp(res.json)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [collection, days])

  const rows: NetMarketplaceRow[] = resp?.rows ?? []
  // The window the API actually answered for. Only claim an archive window off
  // a response we received.
  const asOf = resp?.archived && resp.as_of ? formatClosedOn(resp.as_of) : null
  const addrs = useMemo(() => rows.map((r) => r.address).filter(Boolean), [rows])
  const names = useResolveUsernames(addrs)

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-emerald-400" />
            <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Net Marketplace Activity</h2>
          </div>
          <p className="mt-1 text-sm text-[color:var(--rpc-text-secondary)]">
            Wallets ranked by combined buy + sell activity on Flowty{asOf ? ` in its final ${days} days of trading (to ${asOf})` : ""}. Net position in green = sold more than bought, red = bought more than sold.
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
                      : "border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
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
                      : "border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
                  }
                >
                  {d}d
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="h-32 animate-pulse bg-[color:var(--rpc-surface-raised)]" />
        ) : failed ? (
          <div className="p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            Couldn&apos;t load marketplace activity right now.
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            No Flowty marketplace activity in this window.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] border-b border-[color:var(--rpc-border)]">
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
                  // net_position_usd = sell - buy. Positive net = net seller (green).
                  const isNetSeller = row.net_position_usd > 0
                  const netColor = row.net_position_usd === 0
                    ? "var(--rpc-text-muted)"
                    : isNetSeller
                      ? "var(--rpc-success)"
                      : "var(--rpc-danger)"
                  return (
                    <tr
                      key={row.address}
                      className="border-b border-[color:var(--rpc-border-subtle)] last:border-b-0 hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
                    >
                      <td className="py-2.5 px-3 text-[color:var(--rpc-text-muted)] tabular-nums">{row.rank}</td>
                      <td className="py-2.5 px-3">
                        <Link
                          href={`/analytics/wallets/${row.address}`}
                          className="flex items-center gap-2 min-w-0"
                        >
                          <WalletIdenticon addr={row.address} size={28} />
                          <div className="min-w-0">
                            <div className="text-[color:var(--rpc-text-secondary)] font-mono text-[12px] truncate" title={row.address}>
                              {names[row.address?.toLowerCase()] ? `@${names[row.address.toLowerCase()]}` : truncateAddr(row.address)}
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-primary)] tabular-nums font-medium">
                        {fmtUsd(row.gross_activity_usd)}
                      </td>
                      <td
                        className="py-2.5 px-3 text-right tabular-nums font-medium"
                        style={{ color: netColor }}
                      >
                        {row.net_position_usd > 0 ? "+" : ""}
                        {fmtUsd(row.net_position_usd)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                        <span className="text-[color:var(--rpc-text-muted)] text-[10px]">{row.buy_tx_count}</span>{" "}
                        <span className="text-[color:var(--rpc-text-secondary)]">{fmtUsd(row.buy_volume_usd)}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                        <span className="text-[color:var(--rpc-text-muted)] text-[10px]">{row.sell_tx_count}</span>{" "}
                        <span className="text-[color:var(--rpc-text-secondary)]">{fmtUsd(row.sell_volume_usd)}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Link
                          href={`/analytics/wallets/${row.address}`}
                          className="inline-flex items-center text-[color:var(--rpc-text-muted)] hover:text-emerald-400 transition-colors"
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
