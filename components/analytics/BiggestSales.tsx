"use client"

import Link from "next/link"
import type { SalesTopMoveRow } from "@/lib/analytics-types"

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
  if (!rows || rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
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
          className: "border-slate-700 text-slate-400",
        }
        const title = r.player_name || `${collectionLabel} #${r.serial_number ?? "—"}`
        const subtitle = r.player_name
          ? r.set_name || collectionLabel
          : r.set_name || ""

        return (
          <article
            key={`${r.transaction_hash ?? r.rank}-${r.rank}`}
            className="group relative rounded-xl border border-slate-800 bg-slate-900/40 p-4 transition-colors hover:border-emerald-500/40"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                  #{r.rank} · {collectionLabel}
                </div>
                <h3 className="font-semibold text-slate-100 truncate" title={title}>
                  {title}
                </h3>
                {subtitle ? (
                  <div className="text-xs text-slate-400 truncate" title={subtitle}>
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
              <div className="text-2xl font-bold text-slate-50 tabular-nums">
                {fmtUsd(Number(r.price_usd) || 0)}
              </div>
              {r.serial_number != null ? (
                <div className="text-xs text-slate-400 tabular-nums">#{r.serial_number}</div>
              ) : null}
            </div>
            <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-600">Buyer</span>
                {isLinkableAddr(r.buyer_address) ? (
                  <Link
                    href={`/analytics/wallets/${r.buyer_address}`}
                    className="font-mono text-slate-300 hover:text-emerald-400 transition-colors"
                  >
                    {truncate(r.buyer_address)}
                  </Link>
                ) : (
                  <span className="font-mono text-slate-400">{truncate(r.buyer_address)}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-600">Seller</span>
                {isLinkableAddr(r.seller_address) ? (
                  <Link
                    href={`/analytics/wallets/${r.seller_address}`}
                    className="font-mono text-slate-300 hover:text-emerald-400 transition-colors"
                  >
                    {truncate(r.seller_address)}
                  </Link>
                ) : (
                  <span className="font-mono text-slate-400">{truncate(r.seller_address)}</span>
                )}
              </div>
              <div className="text-slate-600 mt-0.5">{relativeTime(r.sold_at)}</div>
            </div>
          </article>
        )
      })}
    </div>
  )
}
