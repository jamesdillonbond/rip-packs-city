import { ArrowDown, ArrowUp } from "lucide-react"

type Accent = "emerald" | "sky" | "amber" | "rose"

interface KpiCardProps {
  label: string
  value: string
  sublabel?: string
  delta?: number | null
  accent?: Accent
  icon?: React.ComponentType<{ size?: number; className?: string }>
}

const ACCENT_BG: Record<Accent, string> = {
  emerald: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  sky: "bg-sky-500/10 border-sky-500/20 text-sky-400",
  amber: "bg-amber-500/10 border-amber-500/20 text-amber-400",
  rose: "bg-rose-500/10 border-rose-500/20 text-rose-400",
}

export default function KpiCard({
  label,
  value,
  sublabel,
  delta,
  accent = "emerald",
  icon: Icon,
}: KpiCardProps) {
  const hasDelta = delta != null && Number.isFinite(delta)
  const positive = (delta ?? 0) >= 0
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5 relative">
      <div className="flex items-start justify-between mb-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-md border ${ACCENT_BG[accent]}`}>
          {Icon ? <Icon size={16} /> : null}
        </div>
        {hasDelta ? (
          <div
            className={
              "flex items-center gap-0.5 text-xs font-semibold tabular-nums " +
              (positive ? "text-emerald-400" : "text-rose-400")
            }
          >
            {positive ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {Math.abs(delta as number).toFixed(1)}%
          </div>
        ) : null}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
        {label}
      </div>
      <div className="text-2xl sm:text-3xl font-bold text-slate-100 tabular-nums leading-tight">
        {value}
      </div>
      {sublabel ? (
        <div className="text-xs text-slate-400 mt-1">{sublabel}</div>
      ) : null}
    </div>
  )
}
