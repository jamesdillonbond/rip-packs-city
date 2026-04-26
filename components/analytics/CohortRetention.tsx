"use client"

interface CohortRow {
  cohort: string
  cohortLabel: string
  size: number
  retention: Array<{ quarter: string; pct: number; count: number }>
}

interface CohortRetentionProps {
  cohorts: CohortRow[]
  quarters: string[]
}

function quarterLabel(q: string): string {
  const [year, qNum] = q.split("Q")
  return `Q${qNum} ${year.slice(2)}`
}

function colorFor(pct: number): { bg: string; text: string } {
  if (pct < 10) return { bg: "rgba(16,185,129,0.06)", text: "#94a3b8" }
  if (pct < 25) return { bg: "rgba(16,185,129,0.15)", text: "#cbd5e1" }
  if (pct < 40) return { bg: "rgba(16,185,129,0.28)", text: "#e2e8f0" }
  if (pct < 60) return { bg: "rgba(16,185,129,0.45)", text: "#0f172a" }
  if (pct < 80) return { bg: "rgba(16,185,129,0.7)", text: "#0f172a" }
  return { bg: "rgba(16,185,129,0.95)", text: "#0f172a" }
}

const LEGEND = [
  { range: "<10%", pct: 5 },
  { range: "10-25%", pct: 17 },
  { range: "25-40%", pct: 32 },
  { range: "40-60%", pct: 50 },
  { range: "60-80%", pct: 70 },
  { range: "80%+", pct: 90 },
]

export default function CohortRetention({ cohorts, quarters }: CohortRetentionProps) {
  if (!cohorts || cohorts.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        Cohort table populates after the first quarterly cohort completes.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-slate-500">
              <th className="pb-3 pr-4 text-left font-semibold">Cohort</th>
              <th className="pb-3 pr-3 text-right font-semibold">Size</th>
              {quarters.map((q) => (
                <th key={q} className="pb-3 px-1 text-center font-semibold">
                  {quarterLabel(q)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => {
              const map = new Map(c.retention.map((r) => [r.quarter, r]))
              return (
                <tr key={c.cohort} className="border-t border-slate-800/60">
                  <td className="py-2 pr-4 text-slate-200 whitespace-nowrap">
                    {c.cohortLabel}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-400 tabular-nums">
                    {c.size.toLocaleString()}
                  </td>
                  {quarters.map((q) => {
                    const cell = map.get(q)
                    if (!cell || q < c.cohort) {
                      return (
                        <td key={q} className="py-2 px-1 text-center text-slate-700">
                          ·
                        </td>
                      )
                    }
                    const { bg, text } = colorFor(cell.pct)
                    return (
                      <td key={q} className="py-1 px-1 text-center">
                        <div
                          className="rounded px-1.5 py-1 tabular-nums font-medium"
                          style={{ background: bg, color: text }}
                          title={`${cell.count} of ${c.size}`}
                        >
                          {cell.pct.toFixed(0)}%
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-800/60">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          Retention
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {LEGEND.map((l) => {
            const { bg } = colorFor(l.pct)
            return (
              <div key={l.range} className="flex items-center gap-1">
                <span
                  className="inline-block h-3 w-4 rounded"
                  style={{ background: bg }}
                />
                <span className="text-[9px] text-slate-500 tabular-nums">{l.range}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
