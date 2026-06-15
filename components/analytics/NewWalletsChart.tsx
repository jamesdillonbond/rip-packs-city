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
import type { AnalyticsNewWalletsRow } from "@/lib/analytics-types"

interface NewWalletsChartProps {
  rows: AnalyticsNewWalletsRow[]
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
    <div className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] px-3 py-2 text-xs text-[color:var(--rpc-text-primary)]">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] mb-1">
        Week of {label}
      </div>
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded"
              style={{ background: p.color }}
            />
            <span className="text-[color:var(--rpc-text-secondary)]">{p.name}</span>
            <span className="ml-auto tabular-nums text-[color:var(--rpc-text-primary)]">
              {Number(p.value).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function NewWalletsChart({ rows, height = 320 }: NewWalletsChartProps) {
  if (!rows || rows.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-sm text-[color:var(--rpc-text-muted)]">
        No new-wallet data yet — populating as loan history arrives.
      </div>
    )
  }
  const data = rows.map((r) => ({
    week: (r.week || "").slice(0, 10),
    new_borrowers: Number(r.new_borrowers) || 0,
    new_lenders: Number(r.new_lenders) || 0,
    cumulative_total: Number(r.cumulative_total) || 0,
  }))
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            yAxisId="left"
            dataKey="new_borrowers"
            stackId="users"
            name="New borrowers"
            fill="#10b981"
            radius={[2, 2, 0, 0]}
          />
          <Bar
            yAxisId="left"
            dataKey="new_lenders"
            stackId="users"
            name="New lenders"
            fill="#38bdf8"
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumulative_total"
            name="Cumulative"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={false}
          />
          {PLATFORM_EVENTS.map((ev) => {
            const exists = data.some((p) => p.week >= ev.date)
            if (!exists) return null
            return (
              <ReferenceLine
                key={ev.date}
                x={ev.date}
                yAxisId="left"
                stroke="#52525b"
                strokeDasharray="4 4"
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
