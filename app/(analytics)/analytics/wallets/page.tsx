// Wallet directory — index page listing every wallet active on the
// Flowty loan book. Rendered server-side so each wallet row links to a
// crawlable /analytics/wallets/[address] page, which is the SEO play here.
//
// Data source: flowty_analytics_wallet_directory() RPC. We sort by total
// volume desc and render a flat list (~60 rows currently). When the list
// grows beyond a comfortable single-page render we'll paginate, but at
// this scale the page weight is dominated by the WalletIdenticon SVGs,
// not the row count.

import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Wallet } from "lucide-react"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveUsernames, displayName } from "@/lib/flowty-username"
import WalletIdenticon from "@/components/analytics/WalletIdenticon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"
import type { WalletDirectoryRow } from "@/lib/analytics-types"

export const revalidate = 600

export const metadata: Metadata = analyticsMetadata({
  title: "Flowty Wallet Directory — Lenders & Borrowers",
  description:
    "Browse every wallet active on the Flowty NFT-collateralized loan book. Lenders, borrowers, and mixed-role power users — sorted by total volume.",
  path: "/analytics/wallets",
})

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  if (ms < 0) return "just now"
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon}mo ago`
  return `${Math.floor(mon / 12)}y ago`
}

function truncateAddress(addr: string): string {
  const a = (addr || "").toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

async function loadDirectory(): Promise<WalletDirectoryRow[]> {
  try {
    const { data, error } = await (supabaseAdmin.rpc as any)(
      "flowty_analytics_wallet_directory"
    )
    if (error) {
      console.log("[wallets/index] rpc_error", error.message)
      return []
    }
    return ((data ?? []) as WalletDirectoryRow[]).map((r) => ({
      ...r,
      borrower_principal_usd: Number(r.borrower_principal_usd) || 0,
      lender_principal_usd: Number(r.lender_principal_usd) || 0,
    }))
  } catch (e: any) {
    console.log("[wallets/index] error", e?.message || e)
    return []
  }
}

export default async function WalletsIndexPage() {
  const rows = await loadDirectory()

  const enriched = rows
    .map((r) => ({
      ...r,
      total_volume:
        (Number(r.borrower_principal_usd) || 0) +
        (Number(r.lender_principal_usd) || 0),
      total_loans:
        (Number(r.borrower_loan_count) || 0) +
        (Number(r.lender_loan_count) || 0),
    }))
    .sort((a, b) => b.total_volume - a.total_volume)

  const names = await resolveUsernames(enriched.map((r) => r.addr))

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Rip Packs City Flowty Wallet Directory",
    description:
      "Index of every wallet active on the Flowty NFT-collateralized loan book.",
    creator: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/wallets`,
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-100">Wallet directory</h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Every wallet active on the Flowty NFT-collateralized loan book, sorted by
            total volume. Each profile is a standalone page with role-specific stats
            and recent loan activity.
          </p>
        </header>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Wallet size={16} className="text-emerald-400" />
              <span className="text-sm font-semibold text-slate-100">
                {enriched.length} wallets
              </span>
            </div>
          </div>
          {enriched.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No wallet activity to display.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
                    <th className="py-2 px-3 text-left font-semibold w-10">#</th>
                    <th className="py-2 px-3 text-left font-semibold">Wallet</th>
                    <th className="py-2 px-3 text-left font-semibold">Role</th>
                    <th className="py-2 px-3 text-right font-semibold">Loans</th>
                    <th className="py-2 px-3 text-right font-semibold">Volume</th>
                    <th className="py-2 px-3 text-right font-semibold">Last active</th>
                    <th className="py-2 px-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((row, i) => {
                    const display = displayName(row.addr, names)
                    const truncated = truncateAddress(row.addr)
                    const role = row.primary_role || "borrower"
                    const roleCls =
                      role === "lender"
                        ? "border-emerald-500/30 text-emerald-400"
                        : role === "mixed"
                          ? "border-amber-500/30 text-amber-400"
                          : "border-sky-500/30 text-sky-400"
                    return (
                      <tr
                        key={row.addr}
                        className="border-b border-slate-800/40 last:border-b-0 hover:bg-slate-900/40 transition-colors"
                      >
                        <td className="py-2.5 px-3 text-slate-500 tabular-nums">
                          {i + 1}
                        </td>
                        <td className="py-2.5 px-3">
                          <Link
                            href={`/analytics/wallets/${row.addr}`}
                            className="flex items-center gap-2 min-w-0"
                          >
                            <WalletIdenticon addr={row.addr} size={28} />
                            <div className="min-w-0">
                              <div className="text-slate-200 truncate group-hover:text-emerald-400">
                                {display}
                              </div>
                              {display !== truncated ? (
                                <div className="text-[10px] text-slate-500 font-mono truncate">
                                  {truncated}
                                </div>
                              ) : null}
                            </div>
                          </Link>
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={
                              "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                              roleCls
                            }
                          >
                            {role}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                          {row.total_loans}
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-100 tabular-nums font-medium">
                          {fmtUsd(row.total_volume)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-400 tabular-nums text-xs">
                          {fmtRelative(row.last_active_at)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <Link
                            href={`/analytics/wallets/${row.addr}`}
                            className="inline-flex items-center text-slate-500 hover:text-emerald-400 transition-colors"
                            aria-label={`View ${display} profile`}
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
      </div>
    </>
  )
}
