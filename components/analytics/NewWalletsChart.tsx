"use client"

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { PLATFORM_EVENTS } from "./event-markers"

export interface NewWalletPoint {
  week: string
  newLenders: number
  newBorrowers: number
  cumulative: number
}

interface NewWalletsChartProps {
  series: NewWalletPoint[]
  height?: number
}

interface TooltipPayloadEntry {
  name?: string
  value?: number
  color?: string
  dataKey?: string
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayloadEntry[]
  label?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-md border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">
        Week of {label}
      </div>
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded"
              style={{ background: p.color }}
            />
            <span className="text-slate-400">{p.name}</span>
            <span className="ml-auto tabular-nums text-slate-200">
              {Number(p.value).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function NewWalletsChart({ series, height = 320 }: NewWalletsChartProps) {
  if (!series || series.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        No new-wallet data yet — populating as loan history arrives.
      </div>
    )
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            yAxisId="left"
            dataKey="newBorrowers"
            stackId="users"
            name="New borrowers"
            fill="#10b981"
            radius={[2, 2, 0, 0]}
          />
          <Bar
            yAxisId="left"
            dataKey="newLenders"
            stackId="users"
            name="New lenders"
            fill="#38bdf8"
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumulative"
            name="Cumulative"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={false}
          />
          {PLATFORM_EVENTS.map((ev) => {
            const exists = series.some((p) => p.week >= ev.date)
            if (!exists) return null
            return (
              <ReferenceLine
                key={ev.date}
                x={ev.date}
                yAxisId="left"
                stroke="#475569"
                strokeDasharray="4 4"
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
