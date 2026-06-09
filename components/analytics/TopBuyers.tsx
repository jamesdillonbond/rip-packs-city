"use client"

// components/analytics/TopBuyers.tsx
//
// Buyer-side accumulation leaderboard — "who is sweeping what right now". Reads
// /api/analytics/top-buyers, which proxies the get_top_accumulators RPC and
// resolves the swept edition's player/set + the buyer @handle.
//
// Partial-data posture (2026-06-09): Top Shot buyer_address coverage only went
// live ~48h ago (the b7211fb buyer-resolution ship) and the 30d backfill is
// still draining, so the window defaults to 7d where the data lives, the
// caption says so, and there is deliberately NO "new vs returning buyer" badge
// — the prior window is too short to tell first-time from returning, so any
// such badge would read as a false "all first-time" artifact.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useResolveUsernames } from "@/lib/analytics/username-resolver"

interface TopBuyerRow {
  rank: number
  buyer_address: string
  buy_count: number
  spend_usd: number
  avg_price_usd: number
  distinct_editions: number
  top_edition_id: string | null
  top_edition_buys: number
  username?: string | null
  top_edition_player?: string | null
  top_edition_set?: string | null
}

const SWEEP_THRESHOLD = 3

function fmt(n: number): string {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(2)}`
}

function shortAddr(addr: string): string {
  if (!addr) return "—"
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export default function TopBuyers({ collection = "nba_top_shot" }: { collection?: string }) {
  const [days, setDays] = useState<7 | 30>(7)
  const [rows, setRows] = useState<TopBuyerRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = new URLSearchParams({
      collection,
      days: String(days),
      limit: "15",
    })
    fetch(`/api/analytics/top-buyers?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        setRows((j?.rows as TopBuyerRow[]) ?? [])
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
  }, [collection, days])

  const list = useMemo(() => rows ?? [], [rows])
  const addrs = useMemo(() => list.map((r) => r.buyer_address).filter(Boolean), [list])
  const names = useResolveUsernames(addrs)

  const walletLabel = (r: TopBuyerRow) => {
    const resolved = names[r.buyer_address?.toLowerCase()]
    if (resolved) return `@${resolved}`
    if (r.username && r.username !== shortAddr(r.buyer_address)) return `@${r.username}`
    return shortAddr(r.buyer_address)
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          className="text-sm uppercase tracking-widest text-zinc-200"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Top Accumulators
        </h3>
        <div className="flex gap-1" style={{ fontFamily: "var(--font-mono)" }}>
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className="rounded px-2 py-1 text-[11px] uppercase tracking-widest transition-colors"
              style={{
                border: "1px solid var(--rpc-border)",
                color: days === d ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
                background: days === d ? "var(--rpc-surface-hover)" : "transparent",
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div
        className="mb-3 text-[11px]"
        style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}
      >
        On-chain buyers ranked by spend, with the edition each is sweeping. Buyer
        coverage is filling in — meaningful for roughly the last ~48h.
      </div>

      {loading && !rows ? (
        <div className="h-40 animate-pulse rounded bg-zinc-900" />
      ) : list.length === 0 ? (
        <div className="py-6 text-center text-sm text-zinc-500">
          No buyer-resolved accumulation in the last {days}d yet.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                <th className="py-1.5 pr-2">#</th>
                <th className="py-1.5 pr-2">Wallet</th>
                <th className="py-1.5 pr-2 text-right">Buys</th>
                <th className="py-1.5 pr-2 text-right">Editions</th>
                <th className="py-1.5 pr-2 text-right">Spend</th>
                <th className="py-1.5 pr-2 text-right">Avg</th>
                <th className="py-1.5 pl-3">Sweeping</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const sweeping =
                  r.top_edition_buys >= SWEEP_THRESHOLD && r.top_edition_player
                return (
                  <tr key={`${r.rank}-${r.buyer_address}`} className="border-b border-zinc-900">
                    <td className="py-1.5 pr-2 text-zinc-500">{r.rank}</td>
                    <td className="py-1.5 pr-2 text-zinc-200">
                      <Link
                        href={`/analytics/wallets/${encodeURIComponent(r.buyer_address)}`}
                        title={r.buyer_address}
                        className="hover:underline"
                        style={{ color: "var(--rpc-text-primary)" }}
                      >
                        {walletLabel(r)}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 text-right text-zinc-400">
                      {r.buy_count.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-zinc-400">
                      {r.distinct_editions.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-white">{fmt(r.spend_usd)}</td>
                    <td className="py-1.5 pr-2 text-right text-zinc-400">{fmt(r.avg_price_usd)}</td>
                    <td className="py-1.5 pl-3 text-[11px]">
                      {sweeping ? (
                        <span style={{ color: "var(--rpc-red)" }}>
                          {r.top_edition_player}{" "}
                          <span className="text-zinc-500">×{r.top_edition_buys}</span>
                        </span>
                      ) : (
                        <span className="text-zinc-700">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
