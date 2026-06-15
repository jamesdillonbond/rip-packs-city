"use client"

import { useMemo, useState } from "react"
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Clock,
  Copy,
  ExternalLink,
  HandCoins,
  HelpCircle,
  Percent,
  Repeat,
  Users,
  Wallet,
} from "lucide-react"
import Link from "next/link"
import WalletIdenticon from "./WalletIdenticon"
import type {
  WalletDetailResponse,
  WalletPositionTransfersResponse,
  WalletPositionTransferIncomingLoan,
  WalletPositionTransferOutgoingLoan,
  WalletRecentLoan,
} from "@/lib/analytics-types"
import {
  useResolveUsernames,
  displayName as resolveDisplayName,
} from "@/lib/analytics/username-resolver"

interface WalletProfileProps {
  data: WalletDetailResponse
  username?: string | null
  positionTransfers?: WalletPositionTransfersResponse | null
}

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
  other: "#71717a",
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
  return n.toString()
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(2)}%`
}

function truncateAddress(addr: string): string {
  const a = (addr || "").toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return "—"
  }
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

function pickEarliest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[0] ?? null
}

function pickLatest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[valid.length - 1] ?? null
}

function classifyRole(
  borrowerCount: number,
  lenderCount: number
): "Borrower" | "Lender" | "Mixed" {
  if (borrowerCount > 0 && lenderCount > 0) return "Mixed"
  if (lenderCount > 0) return "Lender"
  return "Borrower"
}

function statusBadge(status: string): { label: string; cls: string } {
  const s = (status || "").toLowerCase()
  if (s === "active" || s === "funded") {
    return {
      label: "Active",
      cls: "border-sky-500/30 bg-sky-500/10 text-sky-400",
    }
  }
  if (s === "repaid") {
    return {
      label: "Repaid",
      cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    }
  }
  if (s === "settled") {
    return {
      label: "Settled",
      cls: "border-rose-500/30 bg-rose-500/10 text-rose-400",
    }
  }
  if (s === "canceled" || s === "cancelled") {
    return {
      label: "Cancelled",
      cls: "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-[color:var(--rpc-text-secondary)]",
    }
  }
  return {
    label: status || "—",
    cls: "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-[color:var(--rpc-text-secondary)]",
  }
}

interface MergedLoanRow extends WalletRecentLoan {
  side: "borrower" | "lender"
}

function mergeLoans(
  borrower: WalletRecentLoan[],
  lender: WalletRecentLoan[]
): MergedLoanRow[] {
  const merged: MergedLoanRow[] = [
    ...borrower.map((l) => ({ ...l, side: "borrower" as const })),
    ...lender.map((l) => ({ ...l, side: "lender" as const })),
  ]
  return merged.sort((a, b) => (b.funded_at || "").localeCompare(a.funded_at || ""))
}

export default function WalletProfile({
  data,
  username,
  positionTransfers,
}: WalletProfileProps) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const addr = data.addr

  const counterpartyAddrs = useMemo(() => {
    const out = new Set<string>()
    for (const l of data.recent_as_borrower ?? []) if (l.counterparty_addr) out.add(l.counterparty_addr.toLowerCase())
    for (const l of data.recent_as_lender ?? []) if (l.counterparty_addr) out.add(l.counterparty_addr.toLowerCase())
    if (positionTransfers) {
      for (const l of positionTransfers.outgoing?.loans ?? []) {
        if (l.recipient_addr) out.add(l.recipient_addr.toLowerCase())
        if (l.borrower_addr) out.add(l.borrower_addr.toLowerCase())
      }
      for (const l of positionTransfers.incoming?.loans ?? []) {
        if (l.origin_addr) out.add(l.origin_addr.toLowerCase())
        if (l.borrower_addr) out.add(l.borrower_addr.toLowerCase())
      }
    }
    return Array.from(out)
  }, [data.recent_as_borrower, data.recent_as_lender, positionTransfers])

  const resolvedNames = useResolveUsernames(counterpartyAddrs)

  const display = username && username.trim() ? username : truncateAddress(addr)

  const borrowerCount = data.as_borrower?.loan_count ?? 0
  const lenderCount = data.as_lender?.loan_count ?? 0
  const limboBorrower = data.limbo_as_borrower?.loan_count ?? 0
  const limboLender = data.limbo_as_lender?.loan_count ?? 0

  const role = classifyRole(borrowerCount + limboBorrower, lenderCount + limboLender)

  const totalVolume =
    (data.as_borrower?.total_principal_usd ?? 0) +
    (data.as_lender?.total_principal_usd ?? 0)
  const totalLoans = borrowerCount + lenderCount + limboBorrower + limboLender

  const firstSeen = pickEarliest(
    data.as_borrower?.first_seen_at,
    data.as_lender?.first_seen_at,
    data.limbo_as_borrower?.first_terminal,
    data.limbo_as_lender?.first_terminal
  )
  const lastSeen = pickLatest(
    data.as_borrower?.last_seen_at,
    data.as_lender?.last_seen_at,
    data.limbo_as_borrower?.last_terminal,
    data.limbo_as_lender?.last_terminal
  )

  const mergedLoans = useMemo(
    () => mergeLoans(data.recent_as_borrower ?? [], data.recent_as_lender ?? []).slice(0, 20),
    [data.recent_as_borrower, data.recent_as_lender]
  )

  const handleCopy = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    navigator.clipboard.writeText(addr).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const roleBadgeCls =
    role === "Mixed"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
      : role === "Lender"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
        : "border-sky-500/30 bg-sky-500/10 text-sky-400"

  const showBorrowerPanel = borrowerCount > 0 || limboBorrower > 0
  const showLenderPanel = lenderCount > 0 || limboLender > 0

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
        <WalletIdenticon addr={addr} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-[color:var(--rpc-text-primary)]">{display}</h1>
            <span
              className={
                "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold " +
                roleBadgeCls
              }
            >
              {role}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <code className="text-xs text-[color:var(--rpc-text-secondary)] font-mono break-all">{addr}</code>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] px-1.5 py-0.5 text-[10px] text-[color:var(--rpc-text-secondary)] hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
              aria-label="Copy address"
            >
              <Copy size={10} />
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              href={`https://flowscan.io/account/${addr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] px-1.5 py-0.5 text-[10px] text-[color:var(--rpc-text-secondary)] hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
            >
              <ExternalLink size={10} />
              FlowScan
            </a>
          </div>
        </div>
      </header>

      <section className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiCell
          label="Total volume"
          value={fmtUsd(totalVolume)}
          icon={<HandCoins size={16} className="text-emerald-400" />}
        />
        <KpiCell
          label="Total loans"
          value={fmtNumber(totalLoans)}
          icon={<Wallet size={16} className="text-sky-400" />}
        />
        <KpiCell
          label="First seen"
          value={fmtDate(firstSeen)}
          icon={<Calendar size={16} className="text-amber-400" />}
        />
        <KpiCell
          label="Last active"
          value={lastSeen ? fmtRelative(lastSeen) : "—"}
          sublabel={lastSeen ? fmtDate(lastSeen) : undefined}
          icon={<Clock size={16} className="text-rose-400" />}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {showBorrowerPanel ? (
          <RolePanel
            title="As Borrower"
            accent="sky"
            stats={data.as_borrower}
            limbo={data.limbo_as_borrower}
            uniqueCount={data.as_borrower?.unique_lenders ?? 0}
            uniqueLabel="Unique lenders"
            collectionBreakdown={data.borrower_collection_breakdown}
            isLender={false}
          />
        ) : null}
        {showLenderPanel ? (
          <RolePanel
            title="As Lender"
            accent="emerald"
            stats={data.as_lender}
            limbo={data.limbo_as_lender}
            uniqueCount={data.as_lender?.unique_borrowers ?? 0}
            uniqueLabel="Unique borrowers"
            collectionBreakdown={data.lender_collection_breakdown}
            isLender
          />
        ) : null}
      </section>

      {positionTransfers && positionTransfers.has_activity ? (
        <PositionTransfersSection
          self={addr}
          payload={positionTransfers}
          names={resolvedNames}
        />
      ) : null}

      <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-[color:var(--rpc-border)]">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Recent loan activity</h2>
            <p className="text-xs text-[color:var(--rpc-text-muted)] mt-0.5">
              Last {Math.min(20, mergedLoans.length)} loans, newest first · click a row to expand
            </p>
          </div>
          <span className="rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]">
            {mergedLoans.length} loans
          </span>
        </div>
        {mergedLoans.length === 0 ? (
          <div className="p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            No funded loans in this wallet&apos;s history.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] border-b border-[color:var(--rpc-border)]">
                  <th className="py-2 px-3 text-left font-semibold">Collection</th>
                  <th className="py-2 px-3 text-left font-semibold">Side</th>
                  <th className="py-2 px-3 text-left font-semibold">Counterparty</th>
                  <th className="py-2 px-3 text-right font-semibold">Principal</th>
                  <th className="py-2 px-3 text-center font-semibold">Status</th>
                  <th className="py-2 px-3 text-right font-semibold">Funded</th>
                </tr>
              </thead>
              <tbody>
                {mergedLoans.map((loan) => {
                  const key = `${loan.side}-${loan.funding_resource_id}`
                  const isOpen = expanded === key
                  const sb = statusBadge(loan.status)
                  const collKey = (loan.collection || "other").toLowerCase()
                  return (
                    <RowGroup
                      key={key}
                      loan={loan}
                      collectionLabel={COLLECTION_LABEL[collKey] ?? collKey}
                      collectionColor={COLLECTION_COLORS[collKey] ?? "#71717a"}
                      statusLabel={sb.label}
                      statusCls={sb.cls}
                      open={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : key)}
                      counterpartyDisplay={resolveDisplayName(
                        loan.counterparty_addr,
                        resolvedNames
                      )}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--rpc-text-muted)] pt-2 border-t border-[color:var(--rpc-border)]">
        <Link
          href="/analytics/wallets"
          className="inline-flex items-center gap-1 hover:text-emerald-400 transition-colors"
        >
          <Wallet size={12} />
          Wallet directory
        </Link>
        <span className="text-[color:var(--rpc-text-ghost)]">·</span>
        <Link
          href="/analytics/loans"
          className="inline-flex items-center gap-1 hover:text-emerald-400 transition-colors"
        >
          <Activity size={12} />
          Loan analytics
        </Link>
        <span className="text-[color:var(--rpc-text-ghost)]">·</span>
        <a
          href="/analytics/methodology/wallet-profiles"
          className="inline-flex items-center gap-1 hover:text-emerald-400 transition-colors"
        >
          <Percent size={12} />
          Methodology
        </a>
      </footer>
    </div>
  )
}

interface KpiCellProps {
  label: string
  value: string
  sublabel?: string
  icon: React.ReactNode
}

function KpiCell({ label, value, sublabel, icon }: KpiCellProps) {
  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="mb-2">{icon}</div>
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
        {label}
      </div>
      <div className="text-xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums leading-tight mt-0.5">
        {value}
      </div>
      {sublabel ? (
        <div className="text-[11px] text-[color:var(--rpc-text-muted)] mt-1">{sublabel}</div>
      ) : null}
    </div>
  )
}

interface RolePanelProps {
  title: string
  accent: "emerald" | "sky"
  stats: {
    loan_count: number
    active_count: number
    repaid_count: number
    settled_count: number
    total_principal_usd: number
    total_repayment_usd: number
    default_rate_pct: number | null
    avg_loan_size_usd: number
    avg_term_days?: number
    avg_apr?: number
    first_seen_at: string | null
    last_seen_at: string | null
  } | null
  limbo: {
    loan_count: number
    repaid_count: number
    settled_count: number
    first_terminal: string | null
    last_terminal: string | null
  } | null
  uniqueCount: number
  uniqueLabel: string
  collectionBreakdown: Record<string, { loan_count: number; principal_usd: number }> | undefined
  isLender: boolean
}

function RolePanel({
  title,
  accent,
  stats,
  limbo,
  uniqueCount,
  uniqueLabel,
  collectionBreakdown,
  isLender,
}: RolePanelProps) {
  const titleCls =
    accent === "emerald"
      ? "border-emerald-500/30 text-emerald-400"
      : "border-sky-500/30 text-sky-400"
  const fundedCount = stats?.loan_count ?? 0
  const limboCount = limbo?.loan_count ?? 0
  const preWindowOnly = fundedCount === 0 && limboCount > 0

  const avgRate = isLender ? stats?.avg_apr : null
  const avgTerm = !isLender ? stats?.avg_term_days : null

  const collections = collectionBreakdown
    ? Object.entries(collectionBreakdown).sort(
        (a, b) => (b[1]?.principal_usd ?? 0) - (a[1]?.principal_usd ?? 0)
      )
    : []

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">{title}</h2>
          {preWindowOnly ? (
            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-amber-400">
              Pre-window only
            </span>
          ) : null}
        </div>
        <span
          className={
            "rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold " +
            titleCls
          }
        >
          {fmtNumber(fundedCount + limboCount)} loans
        </span>
      </div>

      <div className="grid gap-3 grid-cols-2">
        <Cell label="Funded volume" value={fmtUsd(stats?.total_principal_usd ?? 0)} />
        <Cell label="Repaid volume" value={fmtUsd(stats?.total_repayment_usd ?? 0)} />
        <Cell label="Active" value={fmtNumber(stats?.active_count ?? 0)} />
        <Cell label="Repaid" value={fmtNumber(stats?.repaid_count ?? 0)} />
        <Cell label="Settled" value={fmtNumber(stats?.settled_count ?? 0)} accent="rose" />
        <Cell label="Default rate" value={fmtPct(stats?.default_rate_pct)} />
        <Cell label="Avg loan size" value={fmtUsd(stats?.avg_loan_size_usd ?? 0)} />
        {isLender ? (
          <Cell
            label="Avg APR"
            value={
              avgRate != null && Number.isFinite(avgRate)
                ? `${(avgRate * 100).toFixed(1)}%`
                : "—"
            }
          />
        ) : (
          <Cell
            label="Avg term"
            value={
              avgTerm != null && Number.isFinite(avgTerm)
                ? `${Math.round(avgTerm)}d`
                : "—"
            }
          />
        )}
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-[color:var(--rpc-border-subtle)] text-xs">
        <Users size={12} className="text-[color:var(--rpc-text-muted)]" />
        <span className="text-[color:var(--rpc-text-secondary)]">
          {fmtNumber(uniqueCount)} {uniqueLabel.toLowerCase()}
        </span>
      </div>

      {collections.length > 0 ? (
        <div className="space-y-1.5 pt-3 border-t border-[color:var(--rpc-border-subtle)]">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
            Collection mix
          </div>
          {collections.map(([key, val]) => {
            const total = stats?.total_principal_usd || 1
            const pct = ((val?.principal_usd ?? 0) / total) * 100
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                {/* brand-exception: data-viz collection swatch fallback color */}
                <span
                  className="inline-block h-2 w-2 rounded"
                  style={{ background: COLLECTION_COLORS[key.toLowerCase()] ?? "#71717a" }}
                />
                <span className="text-[color:var(--rpc-text-secondary)]">
                  {COLLECTION_LABEL[key.toLowerCase()] ?? key}
                </span>
                <span className="ml-auto text-[color:var(--rpc-text-secondary)] tabular-nums">
                  {fmtUsd(val?.principal_usd ?? 0)}
                </span>
                <span className="text-[color:var(--rpc-text-muted)] tabular-nums w-12 text-right">
                  {pct.toFixed(0)}%
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      {limboCount > 0 ? (
        <div className="rounded-lg border border-[color:var(--rpc-border-subtle)] bg-[var(--rpc-surface)] p-3 text-xs space-y-1">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
            Pre-window activity
          </div>
          <div className="text-[color:var(--rpc-text-secondary)]">
            {fmtNumber(limboCount)} loans whose origination predates our scan window — terminal
            events captured.
          </div>
          <div className="flex items-center gap-3 text-[color:var(--rpc-text-muted)] tabular-nums">
            <span>Repaid: <span className="text-[color:var(--rpc-text-secondary)]">{fmtNumber(limbo?.repaid_count ?? 0)}</span></span>
            <span>Settled: <span className="text-[color:var(--rpc-text-secondary)]">{fmtNumber(limbo?.settled_count ?? 0)}</span></span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "rose"
}) {
  const valueCls =
    accent === "rose" ? "text-rose-300" : "text-[color:var(--rpc-text-primary)]"
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>
        {value}
      </div>
    </div>
  )
}

interface RowGroupProps {
  loan: MergedLoanRow
  collectionLabel: string
  collectionColor: string
  statusLabel: string
  statusCls: string
  open: boolean
  onToggle: () => void
  counterpartyDisplay: string
}

function RowGroup({
  loan,
  collectionLabel,
  collectionColor,
  statusLabel,
  statusCls,
  open,
  onToggle,
  counterpartyDisplay,
}: RowGroupProps) {
  const sideLabel = loan.side === "borrower" ? "Borrowed" : "Funded"
  const sideCls =
    loan.side === "borrower"
      ? "border-sky-500/30 text-sky-400"
      : "border-emerald-500/30 text-emerald-400"

  const termDays =
    loan.term_seconds && Number.isFinite(loan.term_seconds)
      ? Math.round(loan.term_seconds / 86400)
      : null
  const aprPct =
    loan.interest_rate && Number.isFinite(loan.interest_rate)
      ? (loan.interest_rate * 100).toFixed(2) + "%"
      : "—"

  return (
    <>
      <tr
        className="border-b border-[color:var(--rpc-border-subtle)] last:border-b-0 cursor-pointer hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
        onClick={onToggle}
      >
        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded"
              style={{ background: collectionColor }}
            />
            <span className="text-[color:var(--rpc-text-secondary)] text-xs">{collectionLabel}</span>
          </div>
        </td>
        <td className="py-2.5 px-3">
          <span
            className={
              "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
              sideCls
            }
          >
            {sideLabel}
          </span>
        </td>
        <td className="py-2.5 px-3">
          <Link
            href={`/analytics/wallets/${loan.counterparty_addr}`}
            className="text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors text-xs"
            onClick={(e) => e.stopPropagation()}
            title={loan.counterparty_addr}
          >
            <span
              className={
                counterpartyDisplay === truncateAddress(loan.counterparty_addr)
                  ? "font-mono"
                  : "font-medium text-[color:var(--rpc-text-secondary)]"
              }
            >
              {counterpartyDisplay}
            </span>
          </Link>
        </td>
        <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-primary)] tabular-nums">
          {fmtUsd(loan.principal_usd)}
        </td>
        <td className="py-2.5 px-3 text-center">
          <span
            className={
              "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
              statusCls
            }
          >
            {statusLabel}
          </span>
        </td>
        <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums text-xs">
          {fmtRelative(loan.funded_at)}
        </td>
      </tr>
      {open ? (
        <tr className="bg-[var(--rpc-surface)] border-b border-[color:var(--rpc-border-subtle)]">
          <td colSpan={6} className="py-3 px-5 text-xs text-[color:var(--rpc-text-secondary)]">
            <div className="grid gap-y-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Funded" value={fmtDate(loan.funded_at)} />
              <Detail label="Matures" value={fmtDate(loan.matures_at)} />
              <Detail label="Term" value={termDays != null ? `${termDays}d` : "—"} />
              <Detail label="Term rate" value={aprPct} />
              <Detail label="Repayment" value={fmtUsd(loan.repayment_usd)} />
              <Detail label="Currency" value={loan.principal_currency || "—"} />
              <Detail label="NFT ID" value={String(loan.nft_id)} />
              <Detail label="Counterparty" value={loan.counterparty_addr} mono />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

interface PositionTransfersSectionProps {
  self: string
  payload: WalletPositionTransfersResponse
  names: Record<string, string>
}

function PositionTransfersSection({
  self,
  payload,
  names,
}: PositionTransfersSectionProps) {
  const outgoing = payload.outgoing
  const incoming = payload.incoming
  const showOutgoing = (outgoing?.count ?? 0) > 0
  const showIncoming = (incoming?.count ?? 0) > 0

  const outgoingLoans = useMemo(
    () =>
      [...(outgoing?.loans ?? [])].sort((a, b) =>
        (b.funded_at || "").localeCompare(a.funded_at || "")
      ),
    [outgoing]
  )
  const incomingLoans = useMemo(
    () =>
      [...(incoming?.loans ?? [])].sort((a, b) =>
        (b.funded_at || "").localeCompare(a.funded_at || "")
      ),
    [incoming]
  )

  return (
    <section className="rounded-xl border border-amber-900/40 bg-gradient-to-br from-amber-950/20 to-zinc-950/40 overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-amber-900/30">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 border border-amber-500/20">
            <Repeat size={14} className="text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Position transfers</h2>
              <span
                className="inline-flex items-center text-[color:var(--rpc-text-muted)] hover:text-[color:var(--rpc-text-secondary)] cursor-help"
                title="HybridCustody loans where this wallet was either the origination lender (transferred out) or settlement lender (transferred in). Reflects parent/child account reassignment within Flow's HybridCustody hierarchy."
              >
                <HelpCircle size={12} />
              </span>
            </div>
            <p className="text-xs text-[color:var(--rpc-text-muted)] mt-0.5">
              Loans whose at-settlement lender differs from origination lender — almost always
              HybridCustody parent/child reassignment.
            </p>
          </div>
        </div>
        <Link
          href="/analytics/methodology/position-transfers"
          className="text-[10px] uppercase tracking-widest text-amber-400 hover:text-amber-300 font-semibold"
        >
          Methodology →
        </Link>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-2">
        {showOutgoing ? (
          <PositionTransferPanel
            kind="outgoing"
            count={outgoing.count}
            principal={outgoing.principal_usd}
            uniqueLabel={`to ${fmtNumber(outgoing.unique_recipients)} unique recipients`}
            loans={outgoingLoans}
            self={self}
            names={names}
          />
        ) : null}
        {showIncoming ? (
          <PositionTransferPanel
            kind="incoming"
            count={incoming.count}
            principal={incoming.principal_usd}
            uniqueLabel={`from ${fmtNumber(incoming.unique_origins)} unique origins`}
            loans={incomingLoans}
            self={self}
            names={names}
          />
        ) : null}
      </div>
    </section>
  )
}

interface PositionTransferPanelProps {
  kind: "outgoing" | "incoming"
  count: number
  principal: number
  uniqueLabel: string
  loans: WalletPositionTransferOutgoingLoan[] | WalletPositionTransferIncomingLoan[]
  self: string
  names: Record<string, string>
}

function PositionTransferPanel({
  kind,
  count,
  principal,
  uniqueLabel,
  loans,
  self: _self,
  names,
}: PositionTransferPanelProps) {
  const isOutgoing = kind === "outgoing"
  const Icon = isOutgoing ? ArrowUpRight : ArrowDownLeft
  const accent = isOutgoing
    ? "border-rose-500/30 text-rose-400"
    : "border-emerald-500/30 text-emerald-400"
  const title = isOutgoing ? "Transferred out" : "Transferred in"

  return (
    <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={isOutgoing ? "text-rose-400" : "text-emerald-400"} />
          <h3 className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">{title}</h3>
        </div>
        <span
          className={
            "rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold " +
            accent
          }
        >
          {fmtNumber(count)} loans
        </span>
      </div>
      <div className="flex items-baseline gap-2 text-[color:var(--rpc-text-secondary)] text-sm">
        <span className="text-lg font-semibold tabular-nums text-[color:var(--rpc-text-primary)]">
          {fmtUsd(principal)}
        </span>
        <span className="text-xs text-[color:var(--rpc-text-muted)]">{uniqueLabel}</span>
      </div>
      {loans.length === 0 ? (
        <div className="text-xs text-[color:var(--rpc-text-muted)]">No transfers in this direction.</div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] border-b border-[color:var(--rpc-border)]">
                <th className="py-1.5 px-2 text-left font-semibold">Collection</th>
                <th className="py-1.5 px-2 text-left font-semibold">
                  {isOutgoing ? "Recipient" : "Origin"}
                </th>
                <th className="py-1.5 px-2 text-left font-semibold">Borrower</th>
                <th className="py-1.5 px-2 text-right font-semibold">Principal</th>
                <th className="py-1.5 px-2 text-center font-semibold">Status</th>
                <th className="py-1.5 px-2 text-right font-semibold">Funded</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((loan, idx) => {
                const otherAddr = isOutgoing
                  ? (loan as WalletPositionTransferOutgoingLoan).recipient_addr
                  : (loan as WalletPositionTransferIncomingLoan).origin_addr
                const sb = statusBadge(loan.status || "")
                const collKey = (loan.collection || "other").toLowerCase()
                return (
                  <tr
                    key={`${loan.listing_resource_id}-${idx}`}
                    className="border-b border-[color:var(--rpc-border-subtle)] last:border-b-0"
                  >
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1.5">
                        {/* brand-exception: data-viz collection swatch fallback color */}
                        <span
                          className="h-2 w-2 rounded"
                          style={{
                            background: COLLECTION_COLORS[collKey] ?? "#71717a",
                          }}
                        />
                        <span className="text-[color:var(--rpc-text-secondary)]">
                          {COLLECTION_LABEL[collKey] ?? loan.collection}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 px-2">
                      <Link
                        href={`/analytics/wallets/${otherAddr}`}
                        className="text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors"
                        title={otherAddr}
                      >
                        {resolveDisplayName(otherAddr, names)}
                      </Link>
                    </td>
                    <td className="py-1.5 px-2">
                      <Link
                        href={`/analytics/wallets/${loan.borrower_addr}`}
                        className="text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors"
                        title={loan.borrower_addr}
                      >
                        {resolveDisplayName(loan.borrower_addr, names)}
                      </Link>
                    </td>
                    <td className="py-1.5 px-2 text-right text-[color:var(--rpc-text-primary)] tabular-nums">
                      {fmtUsd(loan.principal_usd)}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                          sb.cls
                        }
                      >
                        {sb.label}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                      {fmtRelative(loan.funded_at)}
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

function Detail({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold flex-shrink-0">
        {label}
      </span>
      <span
        className={
          "text-[color:var(--rpc-text-secondary)] truncate " + (mono ? "font-mono text-[11px]" : "")
        }
      >
        {value}
      </span>
    </div>
  )
}
