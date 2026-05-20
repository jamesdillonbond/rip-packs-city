"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  HandCoins,
  Info,
  ShoppingCart,
  Skull,
} from "lucide-react"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import KpiCard from "./KpiCard"
import type {
  Pulse24hResponse,
  PulseActivityKind,
  PulseActivityRow,
  PulseHourlyRow,
} from "@/lib/analytics-types"

// ── Local utility helpers ───────────────────────────────────────────────────

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const diff = Date.now() - t
  if (diff < 0) return "just now"
  if (diff < 5_000) return "just now"
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
  return new Date(iso).toLocaleDateString()
}

function truncateAddr(addr: string | null | undefined): string {
  if (!addr) return ""
  const a = String(addr).toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

function isLinkableAddr(a: string | null | undefined): a is string {
  return !!a && /^0x[0-9a-f]{16}$/i.test(a)
}

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

const ALL_COLLECTIONS = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "ufc", label: "UFC Strike" },
  { key: "pinnacle", label: "Pinnacle" },
]

// ── Activity row event configuration ────────────────────────────────────────

interface KindConfig {
  label: string
  icon: typeof HandCoins
  // Tailwind class applied to the icon container border + tint.
  className: string
  // Tailwind class applied to the icon glyph itself.
  iconClassName: string
}

const KIND_CONFIG: Record<PulseActivityKind, KindConfig> = {
  loan_originated: {
    label: "Loan originated",
    icon: HandCoins,
    className: "border-emerald-500/30 bg-emerald-500/10",
    iconClassName: "text-emerald-400",
  },
  loan_repaid: {
    label: "Loan repaid",
    icon: CircleDollarSign,
    className: "border-sky-500/30 bg-sky-500/10",
    iconClassName: "text-sky-400",
  },
  loan_settled: {
    label: "Loan defaulted",
    icon: Skull,
    className: "border-amber-500/30 bg-amber-500/10",
    iconClassName: "text-amber-400",
  },
  sale: {
    label: "Sale",
    icon: ShoppingCart,
    className: "border-zinc-700 bg-zinc-800/40",
    iconClassName: "text-zinc-300",
  },
}

function summarizeKind(row: PulseActivityRow): string {
  const d = (row.details ?? {}) as Record<string, unknown>
  const collectionLabel = COLLECTION_LABEL[row.collection?.toLowerCase()] ?? row.collection
  switch (row.kind) {
    case "loan_originated": {
      const term = d.term_days != null ? `${d.term_days}d` : "—"
      const apr = d.apr_pct != null ? `${Number(d.apr_pct).toFixed(0)}% APR` : ""
      const principal = formatUsd(row.amount_usd ?? 0)
      const tail = apr ? ` for ${term} at ${apr}` : ` for ${term}`
      return `Loan originated: ${principal}${tail} · ${collectionLabel}`
    }
    case "loan_repaid": {
      const repaid = formatUsd(row.amount_usd ?? 0)
      const principal = d.principal_usd != null ? formatUsd(Number(d.principal_usd)) : null
      const tail = principal ? ` (principal ${principal})` : ""
      return `Loan repaid: ${repaid}${tail} · ${collectionLabel}`
    }
    case "loan_settled": {
      const principal = d.principal_usd != null ? formatUsd(Number(d.principal_usd)) : formatUsd(row.amount_usd ?? 0)
      return `Loan defaulted: ${principal} settled to lender · ${collectionLabel}`
    }
    case "sale": {
      const price = formatUsd(row.amount_usd ?? 0)
      const marketplace = String(d.marketplace ?? "").toLowerCase() || "marketplace"
      const serial =
        d.serial_number != null && Number.isFinite(Number(d.serial_number))
          ? ` · #${d.serial_number}`
          : ""
      return `Sale: ${price} on ${marketplace}${serial} · ${collectionLabel}`
    }
    default:
      return collectionLabel || ""
  }
}

// Top Shot's centralized marketplace doesn't expose participant wallets; we
// surface a small badge on those rows so the missing addresses don't read as
// a bug.
function isAnonymousSale(row: PulseActivityRow): boolean {
  if (row.kind !== "sale") return false
  const marketplace = String((row.details as Record<string, unknown>)?.marketplace ?? "").toLowerCase()
  if (marketplace === "topshot") return true
  return !row.primary_addr && !row.counterparty
}

function activityRowKey(row: PulseActivityRow): string {
  const d = (row.details ?? {}) as Record<string, unknown>
  return (
    String(d.tx_hash ?? "") ||
    String(d.listing_resource_id ?? "") ||
    `${row.occurred_at}-${row.kind}-${row.primary_addr ?? "anon"}`
  )
}

// ── Sparkline (24h dual-bar chart) ──────────────────────────────────────────

interface HourlyPoint {
  hour: string
  hourLabel: string
  loan_count: number
  sale_count: number
}

function reshapeHourly(rows: PulseHourlyRow[]): HourlyPoint[] {
  return rows
    .slice()
    .sort((a, b) => a.hour.localeCompare(b.hour))
    .map((r) => {
      const d = new Date(r.hour)
      const label = Number.isFinite(d.getTime())
        ? `${d.getUTCHours().toString().padStart(2, "0")}:00`
        : r.hour.slice(11, 16)
      return {
        hour: r.hour,
        hourLabel: label,
        loan_count: Number(r.loan_count) || 0,
        sale_count: Number(r.sale_count) || 0,
      }
    })
}

interface HourlyTooltipEntry {
  name?: string
  value?: number
  color?: string
}

function HourlyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: HourlyTooltipEntry[]
  label?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs text-zinc-200">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
        {label ?? ""} UTC
      </div>
      <div className="space-y-0.5">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded" style={{ background: p.color }} />
            <span className="text-zinc-300">{p.name}</span>
            <span className="ml-auto tabular-nums text-zinc-100">
              {formatNumber(Number(p.value) || 0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HourlySparkline({ rows }: { rows: PulseHourlyRow[] }) {
  const points = useMemo(() => reshapeHourly(rows), [rows])
  if (!points || points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-900/20 text-xs text-zinc-500">
        Hourly buckets populate as activity arrives.
      </div>
    )
  }
  return (
    <div style={{ width: "100%", height: 128 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="hourLabel"
            tick={{ fill: "#71717a", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            minTickGap={20}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={30}
          />
          <Tooltip content={<HourlyTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 10, color: "#a1a1aa" }}
            iconSize={8}
            verticalAlign="top"
            align="right"
            height={20}
          />
          <Bar dataKey="sale_count" name="Sales" fill="#38bdf8" radius={[2, 2, 0, 0]} />
          <Bar dataKey="loan_count" name="Loans" fill="#10b981" radius={[2, 2, 0, 0]} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Activity row component ──────────────────────────────────────────────────

function ActivityRow({
  row,
  isFresh,
}: {
  row: PulseActivityRow
  isFresh: boolean
}) {
  const cfg = KIND_CONFIG[row.kind] ?? KIND_CONFIG.sale
  const Icon = cfg.icon
  const summary = summarizeKind(row)
  const anon = isAnonymousSale(row)
  const [open, setOpen] = useState(false)

  return (
    <article
      className={
        "flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 transition-colors " +
        (isFresh ? "ring-1 ring-emerald-500/30 bg-emerald-500/5" : "")
      }
    >
      <div
        className={
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border " +
          cfg.className
        }
      >
        <Icon size={14} className={cfg.iconClassName} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="text-sm text-zinc-100 font-medium">{summary}</p>
          {anon ? (
            <span className="rounded border border-zinc-700 px-1.5 py-px text-[9px] uppercase tracking-wider font-semibold text-zinc-400">
              Centralized · anon
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 mt-1">
          <span>{relativeFromNow(row.occurred_at)}</span>
          {!anon && row.primary_addr ? (
            <span className="flex items-center gap-1">
              <span className="text-zinc-600">addr</span>
              {isLinkableAddr(row.primary_addr) ? (
                <Link
                  href={`/analytics/wallets/${row.primary_addr}`}
                  className="font-mono text-zinc-300 hover:text-emerald-400 transition-colors"
                >
                  {truncateAddr(row.primary_addr)}
                </Link>
              ) : (
                <span className="font-mono text-zinc-400">{truncateAddr(row.primary_addr)}</span>
              )}
            </span>
          ) : null}
          {!anon && row.counterparty ? (
            <span className="flex items-center gap-1">
              <span className="text-zinc-600">cp</span>
              {isLinkableAddr(row.counterparty) ? (
                <Link
                  href={`/analytics/wallets/${row.counterparty}`}
                  className="font-mono text-zinc-300 hover:text-emerald-400 transition-colors"
                >
                  {truncateAddr(row.counterparty)}
                </Link>
              ) : (
                <span className="font-mono text-zinc-400">{truncateAddr(row.counterparty)}</span>
              )}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto inline-flex items-center gap-0.5 text-zinc-500 hover:text-emerald-400 transition-colors"
          >
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            details
          </button>
        </div>
        {open ? (
          <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 p-2 text-[10px] text-zinc-400 font-mono">
            {JSON.stringify(row.details ?? {}, null, 2)}
          </pre>
        ) : null}
      </div>
    </article>
  )
}

// ── Main dashboard ──────────────────────────────────────────────────────────

const KIND_FILTERS: Array<{ key: "all" | "loans" | "sales"; label: string; kinds: PulseActivityKind[] | null }> = [
  { key: "all", label: "All", kinds: null },
  {
    key: "loans",
    label: "Loans",
    kinds: ["loan_originated", "loan_repaid", "loan_settled"],
  },
  { key: "sales", label: "Sales", kinds: ["sale"] },
]

const REFRESH_MS = 30_000

export default function PulseDashboard() {
  const [activeCollections, setActiveCollections] = useState<string[]>([])
  const [kindFilter, setKindFilter] = useState<"all" | "loans" | "sales">("all")
  const [minSize, setMinSize] = useState<string>("")

  const [pulse24h, setPulse24h] = useState<Pulse24hResponse | null>(null)
  const [hourly, setHourly] = useState<PulseHourlyRow[]>([])
  const [activity, setActivity] = useState<PulseActivityRow[]>([])
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [tickRefreshedAt, setTickRefreshedAt] = useState<number>(Date.now())

  const collectionsRef = useRef(activeCollections)
  collectionsRef.current = activeCollections
  const kindFilterRef = useRef(kindFilter)
  kindFilterRef.current = kindFilter

  // Build a query string honoring active collection chips.
  const collectionsQs = useMemo(
    () => (activeCollections.length > 0 ? activeCollections.join(",") : ""),
    [activeCollections]
  )
  const kinds = KIND_FILTERS.find((k) => k.key === kindFilter)?.kinds ?? null

  // Initial fetch — full activity payload.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)

    const activityQs = new URLSearchParams(qs)
    if (kinds && kinds.length > 0) activityQs.set("kinds", kinds.join(","))
    activityQs.set("limit", "100")

    Promise.all([
      fetch(`/api/analytics/pulse/24h?${qs.toString()}`).then((r) => r.json()),
      fetch(`/api/analytics/pulse/hourly?${qs.toString()}`).then((r) => r.json()),
      fetch(`/api/analytics/pulse/activity?${activityQs.toString()}`).then((r) => r.json()),
    ])
      .then(([s, h, a]) => {
        if (cancelled) return
        setPulse24h((s as Pulse24hResponse) ?? null)
        setHourly(((h as { rows?: PulseHourlyRow[] })?.rows ?? []) as PulseHourlyRow[])
        const rows = ((a as { rows?: PulseActivityRow[] })?.rows ?? []) as PulseActivityRow[]
        setActivity(rows.slice(0, 100))
        setFreshKeys(new Set())
        setTickRefreshedAt(Date.now())
      })
      .catch(() => {
        // soft-fail; the UI keeps last-known data
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [collectionsQs, kindFilter, kinds])

  // Auto-refresh tick — every REFRESH_MS pull a fresh 24h summary +
  // hourly buckets + only the new activity rows since the most recent
  // occurred_at we already have. Prepend new rows, slice to 100.
  useEffect(() => {
    const id = window.setInterval(async () => {
      const baseQs = new URLSearchParams()
      const cols = collectionsRef.current
      if (cols.length > 0) baseQs.set("collections", cols.join(","))

      const kindsNow = KIND_FILTERS.find((k) => k.key === kindFilterRef.current)?.kinds ?? null
      const activityQs = new URLSearchParams(baseQs)
      if (kindsNow && kindsNow.length > 0) activityQs.set("kinds", kindsNow.join(","))
      activityQs.set("limit", "100")

      // Use the most-recent occurred_at from current state to scope the fetch.
      let mostRecent: string | null = null
      setActivity((curr) => {
        if (curr && curr.length > 0) mostRecent = curr[0].occurred_at
        return curr
      })
      if (mostRecent) activityQs.set("since", mostRecent)

      try {
        const [s, h, a] = await Promise.all([
          fetch(`/api/analytics/pulse/24h?${baseQs.toString()}`).then((r) => r.json()),
          fetch(`/api/analytics/pulse/hourly?${baseQs.toString()}`).then((r) => r.json()),
          fetch(`/api/analytics/pulse/activity?${activityQs.toString()}`).then((r) => r.json()),
        ])
        setPulse24h((s as Pulse24hResponse) ?? null)
        setHourly(((h as { rows?: PulseHourlyRow[] })?.rows ?? []) as PulseHourlyRow[])
        const newRows = ((a as { rows?: PulseActivityRow[] })?.rows ?? []) as PulseActivityRow[]
        if (newRows.length > 0) {
          setActivity((curr) => {
            const seen = new Set(curr.map(activityRowKey))
            const fresh = newRows.filter((r) => !seen.has(activityRowKey(r)))
            if (fresh.length === 0) return curr
            return [...fresh, ...curr].slice(0, 100)
          })
          const freshSet = new Set(newRows.map(activityRowKey))
          setFreshKeys(freshSet)
          // Clear the highlight after 4 seconds so the row settles back into the list.
          window.setTimeout(() => setFreshKeys(new Set()), 4_000)
        }
        setTickRefreshedAt(Date.now())
      } catch {
        // soft-fail
      }
    }, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [])

  const minSizeNum = useMemo(() => {
    const n = parseFloat(minSize)
    return Number.isFinite(n) && n > 0 ? n : 0
  }, [minSize])

  const visibleActivity = useMemo(() => {
    if (!minSizeNum) return activity
    return activity.filter((r) => (Number(r.amount_usd) || 0) >= minSizeNum)
  }, [activity, minSizeNum])

  const prior = pulse24h
  const sales = pulse24h?.sales
  const loans = pulse24h?.loans
  const priorSales = pulse24h?.prior_sales
  const priorLoans = pulse24h?.prior_loans

  const volumeDelta = deltaPct(sales?.volume_usd, priorSales?.volume_usd)
  const salesDelta = deltaPct(sales?.sales, priorSales?.sales)
  const loanDelta = deltaPct(loans?.originations, priorLoans?.originations)
  const loanVolumeDelta = deltaPct(loans?.origination_volume_usd, priorLoans?.origination_volume_usd)

  function toggleCollection(key: string) {
    setActiveCollections((curr) =>
      curr.includes(key) ? curr.filter((c) => c !== key) : [...curr, key]
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">
                Pulse — Live Flow NFT Activity
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                Live
              </span>
            </div>
            <p className="text-sm text-zinc-400 max-w-2xl">
              Real-time transaction stream across loans, sales, and listings on the Flow blockchain.
              Refreshes automatically every {Math.round(REFRESH_MS / 1000)} seconds.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveCollections([])}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (activeCollections.length === 0
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
            }
          >
            All collections
          </button>
          {ALL_COLLECTIONS.map((c) => {
            const active = activeCollections.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCollection(c.key)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 24h KPI strip */}
      <section className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Volume sold (24h)"
          value={sales ? formatUsd(sales.volume_usd) : "—"}
          sublabel={sales?.avg_price_usd != null ? `Avg ${formatPrice(sales.avg_price_usd)}` : undefined}
          delta={volumeDelta}
          icon={CircleDollarSign}
          accent="emerald"
        />
        <KpiCard
          label="Sales (24h)"
          value={sales ? formatNumber(sales.sales) : "—"}
          sublabel={sales?.unique_buyers != null ? `${formatNumber(sales.unique_buyers)} buyers` : undefined}
          delta={salesDelta}
          icon={BarChart3}
          accent="sky"
        />
        <KpiCard
          label="Loan originations (24h)"
          value={loans ? formatNumber(loans.originations) : "—"}
          sublabel={
            loans
              ? `${formatNumber(loans.repayments)} repaid · ${formatNumber(loans.settlements)} settled`
              : undefined
          }
          delta={loanDelta}
          icon={HandCoins}
          accent="emerald"
        />
        <KpiCard
          label="Loan volume (24h)"
          value={loans ? formatUsd(loans.origination_volume_usd) : "—"}
          sublabel="Capital deployed"
          delta={loanVolumeDelta}
          icon={Activity}
          accent="amber"
        />
      </section>

      {/* "as_of" caption */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Updated {relativeFromNow(prior?.as_of ?? new Date(tickRefreshedAt).toISOString())}
        </span>
        <span className="text-zinc-700">·</span>
        <span>{loading ? "Refreshing…" : "Auto-refresh on"}</span>
      </div>

      {/* Hourly sparkline */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Last 24 hours</h2>
            <p className="text-xs text-zinc-500">Hourly buckets · sales vs loans</p>
          </div>
        </div>
        <HourlySparkline rows={hourly} />
      </section>

      {/* Activity feed */}
      <section>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
          <div className="flex items-center gap-2">
            {KIND_FILTERS.map((f) => {
              const active = kindFilter === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setKindFilter(f.key)}
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                    (active
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
                  }
                >
                  {f.label}
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
              Min size
            </span>
            <input
              type="number"
              inputMode="numeric"
              value={minSize}
              onChange={(e) => setMinSize(e.target.value)}
              placeholder="$"
              className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
            />
          </label>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-amber-950/10 border-amber-900/30 p-3 flex items-start gap-2 mb-3">
          <Info size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-zinc-300 leading-relaxed">
            Top Shot marketplace sales appear without buyer/seller wallets — that marketplace doesn&apos;t
            expose participant addresses. Prices and volume are accurate; counterparty data is only
            available for Flowty + Pinnacle.{" "}
            <Link
              href="/analytics/methodology/pulse"
              className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
            >
              Methodology
            </Link>
          </p>
        </div>

        <div className="space-y-2">
          {visibleActivity.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-900/20 text-sm text-zinc-500">
              {loading ? "Loading activity…" : "No events match the current filters."}
            </div>
          ) : (
            visibleActivity.map((row) => {
              const key = activityRowKey(row)
              return <ActivityRow key={key} row={row} isFresh={freshKeys.has(key)} />
            })
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 pt-4 border-t border-zinc-800">
        <span className="inline-flex items-center gap-1.5">
          <ArrowUp size={12} className="text-emerald-500" />
          Most recent first
        </span>
        <span className="text-zinc-700">·</span>
        <Link
          href="/analytics/methodology/pulse"
          className="hover:text-emerald-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </Link>
        <span className="text-zinc-700">·</span>
        <span className="inline-flex items-center gap-1.5">
          <ArrowDown size={12} />
          Older events scroll off after 100
        </span>
      </footer>
    </div>
  )
}
