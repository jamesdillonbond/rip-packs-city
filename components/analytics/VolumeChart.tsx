"use client"

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

export interface VolumePoint {
  date: string
  totalUsd: number
  totalLoans: number
  [collection: string]: string | number
}

interface VolumeChartProps {
  series: VolumePoint[]
  collections: string[]
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

export default function VolumeChart({ series, collections, weekly }: VolumeChartProps) {
  if (!series || series.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-sm text-slate-500">
        Backfill in progress — chart populates as loan history arrives.
      </div>
    )
  }
  const hasMarkers = series.length > 1
  const visibleCollections = collections.length > 0 ? collections : ["totalUsd"]
  return (
    <div style={{ width: "100%", height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            {visibleCollections.map((c, i) => (
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
          {visibleCollections.map((c, i) =>
            collections.length > 0 ? (
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
            ) : (
              <Area
                key={c}
                type="monotone"
                dataKey="totalUsd"
                name="Volume"
                stroke="#10b981"
                fill={`url(#grad-${c})`}
                strokeWidth={1.5}
              />
            )
          )}
          {hasMarkers
            ? PLATFORM_EVENTS.map((ev) => {
                const exists = series.some((p) => p.date >= ev.date)
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
