"use client"

import { useMemo } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { PLATFORM_EVENTS } from "./event-markers"
import type { AnalyticsTimeseriesRow } from "@/lib/analytics-types"

interface VolumeChartProps {
  rows: AnalyticsTimeseriesRow[]
  // Visible series whitelist; empty = render the total (sum of all collections).
  activeCollections: string[]
  weekly?: boolean
}

const COLLECTION_COLORS: Record<string, string> = {
  topshot: "#10b981",
  allday: "#38bdf8",
  golazos: "#f59e0b",
  pinnacle: "#a78bfa",
  ufc: "#fb7185",
}

function colorFor(collection: string, idx: number): string {
  return (
    COLLECTION_COLORS[collection] ||
    ["#10b981", "#38bdf8", "#f59e0b", "#a78bfa", "#fb7185", "#22d3ee"][idx % 6]
  )
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

interface TooltipPayloadEntry {
  name?: string
  value?: number
  color?: string
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
  const total = payload.reduce((acc, p) => acc + (Number(p.value) || 0), 0)
  return (
    <div className="rounded-md border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="font-semibold text-slate-50 mb-1.5">{fmtUsd(total)}</div>
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded"
              style={{ background: p.color }}
            />
            <span className="capitalize text-slate-400">{p.name}</span>
            <span className="ml-auto tabular-nums text-slate-200">
              {fmtUsd(Number(p.value) || 0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface PivotPoint {
  date: string
  total: number
  [collection: string]: string | number
}

function pivot(rows: AnalyticsTimeseriesRow[]): {
  points: PivotPoint[]
  collections: string[]
} {
  const byDate = new Map<string, PivotPoint>()
  const collections = new Set<string>()
  for (const r of rows) {
    const date = (r.bucket || "").slice(0, 10)
    if (!date) continue
    const collection = (r.collection || "unknown").toLowerCase()
    collections.add(collection)
    const usd = Number(r.principal_usd) || 0
    const point = byDate.get(date) ?? { date, total: 0 }
    point[collection] = (Number(point[collection]) || 0) + usd
    point.total = (Number(point.total) || 0) + usd
    byDate.set(date, point)
  }
  return {
    points: Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    ),
    collections: Array.from(collections).sort(),
  }
}

export default function VolumeChart({ rows, activeCollections, weekly }: VolumeChartProps) {
  const { points, collections } = useMemo(() => pivot(rows), [rows])

  if (!points || points.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        Backfill in progress — chart populates as loan history arrives.
      </div>
    )
  }

  const visible =
    activeCollections.length > 0
      ? activeCollections.filter((c) => collections.includes(c))
      : collections
  const stacked = visible.length > 0
  const hasMarkers = points.length > 1

  return (
    <div style={{ width: "100%", height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            {(stacked ? visible : ["total"]).map((c, i) => (
              <linearGradient key={c} id={`grad-${c}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorFor(c, i)} stopOpacity={0.5} />
                <stop offset="100%" stopColor={colorFor(c, i)} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => fmtUsd(Number(v))}
            width={56}
          />
          <Tooltip content={<CustomTooltip />} />
          {stacked
            ? visible.map((c, i) => (
                <Area
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stackId="1"
                  name={c}
                  stroke={colorFor(c, i)}
                  fill={`url(#grad-${c})`}
                  strokeWidth={1.5}
                />
              ))
            : (
                <Area
                  type="monotone"
                  dataKey="total"
                  name="Volume"
                  stroke="#10b981"
                  fill="url(#grad-total)"
                  strokeWidth={1.5}
                />
              )}
          {hasMarkers
            ? PLATFORM_EVENTS.map((ev) => {
                const exists = points.some((p) => p.date >= ev.date)
                if (!exists) return null
                return (
                  <ReferenceLine
                    key={ev.date}
                    x={ev.date}
                    stroke="#475569"
                    strokeDasharray="4 4"
                    label={{
                      value: ev.label,
                      position: "insideTopRight",
                      fill: "#64748b",
                      fontSize: 9,
                    }}
                  />
                )
              })
            : null}
        </AreaChart>
      </ResponsiveContainer>
      {weekly ? (
        <div className="text-[10px] text-slate-500 mt-1.5 text-right">Bucketed by week</div>
      ) : null}
    </div>
  )
}
