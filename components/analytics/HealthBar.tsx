interface HealthMetric {
  label: string
  value: string
  progress?: number | null
  hint?: string
}

interface HealthBarProps {
  title?: string
  metrics: HealthMetric[]
}

export default function HealthBar({ title, metrics }: HealthBarProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      {title ? (
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-4">
          {title}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label}>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
              {m.label}
            </div>
            <div className="text-xl font-semibold text-slate-100 tabular-nums">{m.value}</div>
            {m.hint ? (
              <div className="text-[11px] text-slate-500 mt-0.5">{m.hint}</div>
            ) : null}
            {m.progress != null && Number.isFinite(m.progress) ? (
              <div className="mt-2 h-1 w-full overflow-hidden rounded bg-slate-800">
                <div
                  className="h-full bg-emerald-500/70"
                  style={{ width: `${Math.max(0, Math.min(100, m.progress))}%` }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
