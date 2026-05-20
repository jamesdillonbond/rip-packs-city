"use client"

import { useMemo } from "react"
import type { AnalyticsCohortRow } from "@/lib/analytics-types"

interface CohortRetentionProps {
  rows: AnalyticsCohortRow[]
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

function monthLabel(iso: string): string {
  // iso = YYYY-MM-01
  const [y, m] = iso.slice(0, 10).split("-")
  const idx = Math.max(0, Math.min(11, parseInt(m, 10) - 1))
  return `${MONTH_NAMES[idx]} ${y}`
}

function colorFor(pct: number): { bg: string; text: string } {
  if (pct < 10) return { bg: "rgba(16,185,129,0.06)", text: "#a1a1aa" }
  if (pct < 25) return { bg: "rgba(16,185,129,0.15)", text: "#d4d4d8" }
  if (pct < 40) return { bg: "rgba(16,185,129,0.28)", text: "#e4e4e7" }
  if (pct < 60) return { bg: "rgba(16,185,129,0.45)", text: "#18181b" }
  if (pct < 80) return { bg: "rgba(16,185,129,0.7)", text: "#18181b" }
  return { bg: "rgba(16,185,129,0.95)", text: "#18181b" }
}

const LEGEND = [
  { range: "<10%", pct: 5 },
  { range: "10-25%", pct: 17 },
  { range: "25-40%", pct: 32 },
  { range: "40-60%", pct: 50 },
  { range: "60-80%", pct: 70 },
  { range: "80%+", pct: 90 },
]

interface PivotCohort {
  cohort_month: string
  size: number
  cells: Map<number, { active_count: number; retention_pct: number }>
}

function pivot(rows: AnalyticsCohortRow[]): {
  cohorts: PivotCohort[]
  maxOffset: number
} {
  const byCohort = new Map<string, PivotCohort>()
  let maxOffset = 0
  for (const r of rows) {
    const key = (r.cohort_month || "").slice(0, 10)
    if (!key) continue
    const offset = Number(r.month_offset) || 0
    if (offset > maxOffset) maxOffset = offset
    const existing = byCohort.get(key) ?? {
      cohort_month: key,
      size: Number(r.cohort_size) || 0,
      cells: new Map<number, { active_count: number; retention_pct: number }>(),
    }
    // Cohort size is the same on every row of a given cohort, but trust the
    // first non-zero value we see in case the RPC ever zero-fills.
    if (!existing.size && r.cohort_size) existing.size = Number(r.cohort_size)
    existing.cells.set(offset, {
      active_count: Number(r.active_count) || 0,
      retention_pct: Number(r.retention_pct) || 0,
    })
    byCohort.set(key, existing)
  }
  return {
    cohorts: Array.from(byCohort.values()).sort((a, b) =>
      a.cohort_month.localeCompare(b.cohort_month)
    ),
    maxOffset,
  }
}

export default function CohortRetention({ rows }: CohortRetentionProps) {
  const { cohorts, maxOffset } = useMemo(() => pivot(rows), [rows])

  if (!cohorts || cohorts.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 text-sm text-zinc-500">
        Cohort table populates after the first monthly cohort completes.
      </div>
    )
  }

  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i)

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-zinc-500">
              <th className="pb-3 pr-4 text-left font-semibold">Cohort</th>
              <th className="pb-3 pr-3 text-right font-semibold">Size</th>
              {offsets.map((o) => (
                <th key={o} className="pb-3 px-1 text-center font-semibold">
                  M{o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.cohort_month} className="border-t border-zinc-800/60">
                <td className="py-2 pr-4 text-zinc-200 whitespace-nowrap">
                  {monthLabel(c.cohort_month)}
                </td>
                <td className="py-2 pr-3 text-right text-zinc-400 tabular-nums">
                  {c.size.toLocaleString()}
                </td>
                {offsets.map((o) => {
                  const cell = c.cells.get(o)
                  if (!cell) {
                    return (
                      <td key={o} className="py-2 px-1 text-center text-zinc-700">
                        ·
                      </td>
                    )
                  }
                  const { bg, text } = colorFor(cell.retention_pct)
                  return (
                    <td key={o} className="py-1 px-1 text-center">
                      <div
                        className="rounded px-1.5 py-1 tabular-nums font-medium"
                        style={{ background: bg, color: text }}
                        title={`${cell.active_count} of ${c.size}`}
                      >
                        {cell.retention_pct.toFixed(0)}%
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 mt-4 pt-3 border-t border-zinc-800/60 sm:flex-row sm:items-center">
        <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
          % active in month
        </div>
        <div className="flex items-center gap-1 sm:ml-auto">
          {LEGEND.map((l) => {
            const { bg } = colorFor(l.pct)
            return (
              <div key={l.range} className="flex items-center gap-1">
                <span
                  className="inline-block h-3 w-4 rounded"
                  style={{ background: bg }}
                />
                <span className="text-[9px] text-zinc-500 tabular-nums">{l.range}</span>
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
        M0 is the cohort&apos;s first month, M1 the next month, etc. Cells show the % of that
        cohort active in month N — not strict retention; wallets can come back after a gap.
      </p>
    </div>
  )
}
