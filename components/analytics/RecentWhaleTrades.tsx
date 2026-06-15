"use client"

// Top sales over the last 30 days, presented as a tight 8-row card.
// The /api/analytics/sales/top-moves route doesn't accept a 24h window, so
// we use l30 (the smallest supported window) and let users see the biggest
// of the recent trades. Each row links to the per-collection sales page.

import Link from "next/link"
import { useEffect, useState } from "react"
import { Flame } from "lucide-react"
import type { SalesTopMoveRow } from "@/lib/analytics-types"

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

const TIER_COLOR: Record<string, string> = {
  ULTIMATE: "var(--tier-ultimate)",
  LEGENDARY: "var(--tier-legendary)",
  RARE: "var(--tier-rare)",
  FANDOM: "var(--tier-fandom)",
  COMMON: "var(--tier-common)",
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

export default function RecentWhaleTrades() {
  const [rows, setRows] = useState<SalesTopMoveRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch("/api/analytics/sales/top-moves?window=l30&limit=8")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.rows) setRows(j.rows as SalesTopMoveRow[]) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <Flame size={16} className="text-rose-400" />
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Recent Whale Trades</h2>
        </div>
        <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Last 30 days</span>
      </div>
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] overflow-hidden">
        {loading && !rows ? (
          <div className="h-48 animate-pulse bg-[color:var(--rpc-surface-hover)]" />
        ) : !rows || rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-[color:var(--rpc-text-muted)]">No recent whale trades.</div>
        ) : (
          <ol className="divide-y divide-[color:var(--rpc-border-subtle)]">
            {rows.map((r) => {
              const collKey = (r.collection || "").toLowerCase()
              const collLabel = COLLECTION_LABEL[collKey] ?? r.collection
              const tier = (r as any).tier ? String((r as any).tier).toUpperCase() : ""
              const tierColor = TIER_COLOR[tier] ?? "var(--rpc-text-muted)"
              return (
                <li key={`${r.transaction_hash ?? r.edition_id}-${r.rank}`} className="hover:bg-[color:var(--rpc-surface-hover)] transition-colors">
                  <Link
                    href={`/analytics/sales?collections=${encodeURIComponent(collKey)}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: "var(--rpc-danger)" }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-[color:var(--rpc-text-primary)] font-medium">
                          {r.player_name ?? "Unknown moment"}
                        </span>
                        {tier ? (
                          <span
                            className="rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold"
                            style={{ color: tierColor, borderColor: tierColor }}
                          >
                            {tier}
                          </span>
                        ) : null}
                        {r.serial_number ? (
                          <span className="text-[10px] text-[color:var(--rpc-text-muted)] font-mono">#{r.serial_number}</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[color:var(--rpc-text-muted)]">
                        {r.set_name ?? "—"} · {collLabel}
                      </div>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-base font-bold text-[color:var(--rpc-text-primary)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                        {fmtUsd(r.price_usd)}
                      </span>
                      <span className="text-[10px] text-[color:var(--rpc-text-muted)]">{fmtRelative(r.sold_at)}</span>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}
