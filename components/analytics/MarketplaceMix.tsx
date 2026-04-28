"use client"

// Marketplace mix — renders the distribution of sale volume across the
// three marketplaces we index (Top Shot's centralized market, Flowty,
// and on-chain Pinnacle.Trade). Stacked-bar form so the legend can
// surface the dollar volume per slice without the cramming a pie chart.

interface MarketplaceMixProps {
  // Keys: "topshot", "flowty", "on-chain" (or "pinnacle"). The summary RPC
  // emits one of these. We tolerate any unknown extras and bucket them
  // into "other".
  data: Record<string, { count: number; usd: number }> | null | undefined
}

interface Slice {
  key: string
  label: string
  count: number
  usd: number
  color: string
  className: string
}

const KNOWN: Array<{ key: string; label: string; color: string; className: string }> = [
  { key: "topshot", label: "Top Shot marketplace", color: "#10b981", className: "bg-emerald-500" },
  { key: "flowty", label: "Flowty (NFTStorefrontV2)", color: "#a78bfa", className: "bg-violet-400" },
  { key: "on-chain", label: "Pinnacle direct", color: "#38bdf8", className: "bg-sky-400" },
  { key: "pinnacle", label: "Pinnacle direct", color: "#38bdf8", className: "bg-sky-400" },
]

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export default function MarketplaceMix({ data }: MarketplaceMixProps) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        No marketplace activity in this window yet.
      </div>
    )
  }

  // Merge "on-chain" + "pinnacle" if both happen to appear (some RPC
  // versions emit one or the other). Keep the first label that wins.
  const merged: Record<string, { count: number; usd: number }> = {}
  for (const [k, v] of Object.entries(data)) {
    const key = k.toLowerCase() === "pinnacle" ? "on-chain" : k.toLowerCase()
    const cur = merged[key] ?? { count: 0, usd: 0 }
    cur.count += Number(v?.count) || 0
    cur.usd += Number(v?.usd) || 0
    merged[key] = cur
  }

  const total = Object.values(merged).reduce((acc, v) => acc + v.usd, 0)
  if (total <= 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        No marketplace volume in this window yet.
      </div>
    )
  }

  const slices: Slice[] = []
  for (const k of KNOWN) {
    const v = merged[k.key]
    if (!v) continue
    slices.push({
      key: k.key,
      label: k.label,
      count: v.count,
      usd: v.usd,
      color: k.color,
      className: k.className,
    })
    // Mark consumed so it doesn't double-fall into "other".
    delete merged[k.key]
  }
  // Anything left over goes into "other" (defensive — shouldn't normally occur).
  const otherUsd = Object.values(merged).reduce((acc, v) => acc + v.usd, 0)
  const otherCount = Object.values(merged).reduce((acc, v) => acc + v.count, 0)
  if (otherUsd > 0) {
    slices.push({
      key: "other",
      label: "Other",
      count: otherCount,
      usd: otherUsd,
      color: "#64748b",
      className: "bg-slate-500",
    })
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-slate-100">Marketplace mix</h2>
        <div className="text-xs text-slate-500 tabular-nums">{fmtUsd(total)} total</div>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Where the volume came from. Top Shot’s centralized market, Flowty (NFTStorefrontV2 fork), and direct
        on-chain Pinnacle sales.
      </p>
      <div className="flex h-3 w-full overflow-hidden rounded">
        {slices.map((s) => (
          <div
            key={s.key}
            className={s.className}
            style={{ width: `${Math.max(0.5, (s.usd / total) * 100)}%` }}
            title={`${s.label}: ${fmtUsd(s.usd)} · ${fmtCount(s.count)} sales`}
          />
        ))}
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {slices.map((s) => {
          const pct = (s.usd / total) * 100
          return (
            <li
              key={s.key}
              className="flex items-center gap-2.5 rounded-md border border-slate-800/60 bg-slate-950/40 px-3 py-2"
            >
              <span
                className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-slate-200 truncate">{s.label}</div>
                <div className="text-[10px] text-slate-500 tabular-nums">
                  {fmtCount(s.count)} sales
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-100 tabular-nums">
                  {fmtUsd(s.usd)}
                </div>
                <div className="text-[10px] text-slate-500 tabular-nums">{pct.toFixed(1)}%</div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
