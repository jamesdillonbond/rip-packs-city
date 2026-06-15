"use client"

import { useMemo } from "react"
import Link from "next/link"
import type { SalesTopMoveRow } from "@/lib/analytics-types"
import { useResolveUsernames } from "@/lib/analytics/username-resolver"

// BiggestSales — card grid showing the largest individual sales in the
// active window. The RPC pre-joins player_name / set_name when the
// editions table covers the moment; we render gracefully when those are
// NULL (Pinnacle and partial AllDay edition coverage).

interface BiggestSalesProps {
  rows: SalesTopMoveRow[]
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function truncate(addr: string | null | undefined): string {
  if (!addr) return "—"
  const a = addr.toLowerCase()
  if (!a.startsWith("0x")) return a
  if (a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  if (diff < 60_000) return "just now"
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
  return new Date(iso).toLocaleDateString()
}

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

const MARKETPLACE_LABEL: Record<string, { label: string; className: string }> = {
  topshot: { label: "Top Shot", className: "border-emerald-500/30 text-emerald-400" },
  flowty: { label: "Flowty", className: "border-violet-500/30 text-violet-400" },
  "on-chain": { label: "On-chain", className: "border-sky-500/30 text-sky-400" },
  pinnacle: { label: "Pinnacle", className: "border-sky-500/30 text-sky-400" },
}

function isLinkableAddr(a: string | null | undefined): a is string {
  return !!a && /^0x[0-9a-f]{16}$/i.test(a)
}

export default function BiggestSales({ rows }: BiggestSalesProps) {
  const addrs = useMemo(() => {
    const out: string[] = []
    for (const r of rows ?? []) {
      if (r.buyer_address) out.push(r.buyer_address)
      if (r.seller_address) out.push(r.seller_address)
    }
    return out
  }, [rows])
  const names = useResolveUsernames(addrs)
  const label = (addr: string | null | undefined) =>
    addr && names[addr.toLowerCase()] ? `@${names[addr.toLowerCase()]}` : truncate(addr)

  if (!rows || rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-sm text-[color:var(--rpc-text-muted)]">
        No sales in this window yet.
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((r) => {
        const collectionLabel = COLLECTION_LABEL[r.collection?.toLowerCase()] ?? r.collection
        const mp = MARKETPLACE_LABEL[r.marketplace?.toLowerCase()] ?? {
          label: r.marketplace,
          className: "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)]",
        }
        const title = r.player_name || `${collectionLabel} #${r.serial_number ?? "—"}`
        const subtitle = r.player_name
          ? r.set_name || collectionLabel
          : r.set_name || ""

        return (
          <article
            key={`${r.transaction_hash ?? r.rank}-${r.rank}`}
            className="group relative rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4 transition-colors hover:border-emerald-500/40"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                  #{r.rank} · {collectionLabel}
                </div>
                <h3 className="font-semibold text-[color:var(--rpc-text-primary)] truncate" title={title}>
                  {title}
                </h3>
                {subtitle ? (
                  <div className="text-xs text-[color:var(--rpc-text-secondary)] truncate" title={subtitle}>
                    {subtitle}
                  </div>
                ) : null}
              </div>
              <span
                className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold ${mp.className}`}
              >
                {mp.label}
              </span>
            </div>
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums">
                {fmtUsd(Number(r.price_usd) || 0)}
              </div>
              {r.serial_number != null ? (
                <div className="text-xs text-[color:var(--rpc-text-secondary)] tabular-nums">#{r.serial_number}</div>
              ) : null}
            </div>
            <div className="flex flex-col gap-0.5 text-[11px] text-[color:var(--rpc-text-muted)]">
              <div className="flex items-center gap-1.5">
                <span className="text-[color:var(--rpc-text-ghost)]">Buyer</span>
                {isLinkableAddr(r.buyer_address) ? (
                  <Link
                    href={`/analytics/wallets/${r.buyer_address}`}
                    title={r.buyer_address}
                    className="font-mono text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors"
                  >
                    {label(r.buyer_address)}
                  </Link>
                ) : (
                  <span className="font-mono text-[color:var(--rpc-text-secondary)]">{label(r.buyer_address)}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[color:var(--rpc-text-ghost)]">Seller</span>
                {isLinkableAddr(r.seller_address) ? (
                  <Link
                    href={`/analytics/wallets/${r.seller_address}`}
                    title={r.seller_address}
                    className="font-mono text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors"
                  >
                    {label(r.seller_address)}
                  </Link>
                ) : (
                  <span className="font-mono text-[color:var(--rpc-text-secondary)]">{label(r.seller_address)}</span>
                )}
              </div>
              <div className="text-[color:var(--rpc-text-ghost)] mt-0.5">{relativeTime(r.sold_at)}</div>
            </div>
          </article>
        )
      })}
    </div>
  )
}
