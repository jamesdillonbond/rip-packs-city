"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronDown, ChevronUp, Repeat } from "lucide-react"
import type {
  PositionTransfersSummaryResponse,
  PositionTransfersRecentRow,
  PositionTransfersTopWallet,
} from "@/lib/analytics-types"
import {
  useResolveUsernames,
  displayName as resolveDisplayName,
  truncateAddress,
} from "@/lib/analytics/username-resolver"

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "NFL All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC Strike",
  other: "Other",
}

const COLLECTION_COLORS: Record<string, string> = {
  topshot: "#10b981",
  allday: "#38bdf8",
  golazos: "#f59e0b",
  pinnacle: "#a78bfa",
  ufc: "#fb7185",
  other: "#64748b",
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return Math.round(n).toString()
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n < 0.01) return "<0.01%"
  return `${n.toFixed(2)}%`
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return "just now"
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon}mo ago`
  return `${Math.floor(mon / 12)}y ago`
}

function statusBadge(status: string): { label: string; cls: string } {
  const s = (status || "").toLowerCase()
  if (s === "active" || s === "funded") {
    return { label: "Active", cls: "border-sky-500/30 bg-sky-500/10 text-sky-400" }
  }
  if (s === "repaid") {
    return { label: "Repaid", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" }
  }
  if (s === "settled") {
    return { label: "Settled", cls: "border-rose-500/30 bg-rose-500/10 text-rose-400" }
  }
  if (s === "canceled" || s === "cancelled") {
    return { label: "Cancelled", cls: "border-slate-500/30 bg-slate-500/10 text-slate-400" }
  }
  return { label: status || "—", cls: "border-slate-700 bg-slate-800/40 text-slate-400" }
}

export default function PositionTransfersCard() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PositionTransfersSummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    if (!open || fetched) return
    setLoading(true)
    fetch("/api/analytics/loans/position-transfers")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setData((j as PositionTransfersSummaryResponse | null) ?? null)
        setFetched(true)
      })
      .catch(() => setFetched(true))
      .finally(() => setLoading(false))
  }, [open, fetched])

  const allAddrs = useMemo(() => {
    if (!data) return [] as string[]
    const set = new Set<string>()
    for (const r of data.top_origins ?? []) set.add(r.addr.toLowerCase())
    for (const r of data.top_recipients ?? []) set.add(r.addr.toLowerCase())
    for (const r of data.recent ?? []) {
      if (r.origin_addr) set.add(r.origin_addr.toLowerCase())
      if (r.recipient_addr) set.add(r.recipient_addr.toLowerCase())
    }
    return Array.from(set)
  }, [data])

  const names = useResolveUsernames(allAddrs)
  const totals = data?.totals

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left hover:bg-slate-900/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/10 border border-amber-500/20">
            <Repeat size={16} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Position transfers</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              FULL loans where lender_at_settlement differs from origination lender. Almost
              always HybridCustody parent/child reassignment.
            </p>
          </div>
        </div>
        {open ? (
          <ChevronUp size={16} className="text-slate-500" />
        ) : (
          <ChevronDown size={16} className="text-slate-500" />
        )}
      </button>

      {open ? (
        <div className="border-t border-slate-800 p-5 space-y-5">
          {loading && !data ? (
            <div className="text-sm text-slate-500 py-4">Loading position transfers…</div>
          ) : !data ? (
            <div className="text-sm text-slate-500 py-4">
              Could not load position transfer data.
            </div>
          ) : (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
                <Kpi
                  label="Total transfers"
                  value={fmtNumber(totals?.total_transfers)}
                />
                <Kpi
                  label="Principal"
                  value={fmtUsd(totals?.total_principal_usd ?? 0)}
                />
                <Kpi
                  label="Origin lenders"
                  value={fmtNumber(totals?.unique_origin_lenders)}
                />
                <Kpi
                  label="Recipient lenders"
                  value={fmtNumber(totals?.unique_recipient_lenders)}
                />
                <Kpi
                  label="% of FULL loans"
                  value={fmtPct(totals?.pct_of_full_loans)}
                  accent="amber"
                />
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <TopWalletsTable
                  title="Top origin wallets"
                  subtitle="Where positions came from"
                  rows={data.top_origins ?? []}
                  names={names}
                />
                <TopWalletsTable
                  title="Top recipient wallets"
                  subtitle="Where positions ended up"
                  rows={data.top_recipients ?? []}
                  names={names}
                />
              </div>

              <RecentTransfersTable rows={data.recent ?? []} names={names} />

              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  Updated{" "}
                  {data.as_of
                    ? new Date(data.as_of).toLocaleTimeString()
                    : "recently"}
                </span>
                <Link
                  href="/analytics/methodology/position-transfers"
                  className="hover:text-amber-400 transition-colors"
                >
                  Methodology →
                </Link>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "amber"
}) {
  const valueCls =
    accent === "amber" ? "text-amber-300" : "text-slate-100"
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
        {label}
      </div>
      <div className={`text-xl font-bold tabular-nums mt-0.5 ${valueCls}`}>{value}</div>
    </div>
  )
}

function TopWalletsTable({
  title,
  subtitle,
  rows,
  names,
}: {
  title: string
  subtitle: string
  rows: PositionTransfersTopWallet[]
  names: Record<string, string>
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40">
      <div className="p-3 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <div className="p-4 text-sm text-slate-500 text-center">No data.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[9px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
              <th className="py-1.5 px-3 text-left font-semibold">Wallet</th>
              <th className="py-1.5 px-3 text-right font-semibold">Transfers</th>
              <th className="py-1.5 px-3 text-right font-semibold">Principal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const display = resolveDisplayName(r.addr, names)
              const truncated = truncateAddress(r.addr)
              return (
                <tr key={r.addr} className="border-b border-slate-800/40 last:border-b-0">
                  <td className="py-2 px-3 min-w-0">
                    <Link
                      href={`/analytics/wallets/${r.addr}`}
                      className="text-slate-200 hover:text-emerald-400 transition-colors"
                      title={r.addr}
                    >
                      <div className={display === truncated ? "font-mono text-xs" : "font-medium"}>
                        {display}
                      </div>
                      {display !== truncated ? (
                        <div className="text-[10px] text-slate-500 font-mono">{truncated}</div>
                      ) : null}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                    {fmtNumber(r.transfers)}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-100 tabular-nums">
                    {fmtUsd(r.principal_usd)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function RecentTransfersTable({
  rows,
  names,
}: {
  rows: PositionTransfersRecentRow[]
  names: Record<string, string>
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40">
      <div className="p-3 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-slate-100">Recent transfers</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Most recent {rows.length} transfers, newest first.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="p-4 text-sm text-slate-500 text-center">No transfers.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
                <th className="py-1.5 px-3 text-left font-semibold">Funded</th>
                <th className="py-1.5 px-3 text-left font-semibold">Collection</th>
                <th className="py-1.5 px-3 text-left font-semibold">Origin → Recipient</th>
                <th className="py-1.5 px-3 text-right font-semibold">Principal</th>
                <th className="py-1.5 px-3 text-center font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const sb = statusBadge(r.status || "")
                const collKey = (r.collection || "other").toLowerCase()
                return (
                  <tr
                    key={`${r.listing_resource_id}-${idx}`}
                    className="border-b border-slate-800/40 last:border-b-0"
                  >
                    <td className="py-2 px-3 text-slate-400 tabular-nums text-xs whitespace-nowrap">
                      {fmtRelative(r.funded_at)}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded"
                          style={{
                            background: COLLECTION_COLORS[collKey] ?? "#64748b",
                          }}
                        />
                        <span className="text-slate-300 text-xs">
                          {COLLECTION_LABEL[collKey] ?? r.collection}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs">
                      <Link
                        href={`/analytics/wallets/${r.origin_addr}`}
                        className="text-slate-300 hover:text-emerald-400 transition-colors"
                        title={r.origin_addr}
                      >
                        {resolveDisplayName(r.origin_addr, names)}
                      </Link>
                      <span className="text-slate-600 mx-1.5">→</span>
                      <Link
                        href={`/analytics/wallets/${r.recipient_addr}`}
                        className="text-slate-300 hover:text-emerald-400 transition-colors"
                        title={r.recipient_addr}
                      >
                        {resolveDisplayName(r.recipient_addr, names)}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-right text-slate-100 tabular-nums">
                      {fmtUsd(r.principal_usd)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                          sb.cls
                        }
                      >
                        {sb.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
