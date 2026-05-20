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
  // When true, the chart is dedicated to a single collection — switch the
  // total fill to that collection's color and skip the stacking treatment.
  singleCollection?: boolean
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

function fmtDateShort(iso: string, includeYear = false): string {
  // iso = YYYY-MM-DD; render "Dec 29" or "Jan 5 '26" when year is needed.
  const parts = iso.slice(0, 10).split("-")
  if (parts.length !== 3) return iso
  const [y, m, d] = parts
  const idx = Math.max(0, Math.min(11, parseInt(m, 10) - 1))
  const day = parseInt(d, 10)
  const base = `${MONTH_NAMES[idx]} ${day}`
  return includeYear ? `${base} ’${y.slice(-2)}` : base
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
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs text-zinc-200">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
        {label ? fmtDateShort(label, true) : ""}
      </div>
      <div className="font-semibold text-zinc-50 mb-1.5">{fmtUsd(total)}</div>
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded"
              style={{ background: p.color }}
            />
            <span className="capitalize text-zinc-400">{p.name}</span>
            <span className="ml-auto tabular-nums text-zinc-200">
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

export default function VolumeChart({
  rows,
  activeCollections,
  weekly,
  singleCollection,
}: VolumeChartProps) {
  const { points, collections } = useMemo(() => pivot(rows), [rows])

  const tickFormatter = useMemo(() => {
    if (!points || points.length === 0) return (v: string) => v
    // Show the year on the very first tick of each year so the boundary
    // (e.g. 2025-12-29 → 2026-01-05) doesn't lose its year context.
    const seenYears = new Set<string>()
    return (raw: string) => {
      const year = raw.slice(0, 4)
      const showYear = !seenYears.has(year)
      seenYears.add(year)
      return fmtDateShort(raw, showYear)
    }
  }, [points])

  if (!points || points.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 text-sm text-zinc-500">
        Backfill in progress — chart populates as loan history arrives.
      </div>
    )
  }

  // In single-collection mode we always render one filled area regardless
  // of how the activeCollections array is set, since the page's collection
  // is the entire dataset.
  const visible = singleCollection
    ? []
    : activeCollections.length > 0
      ? activeCollections.filter((c) => collections.includes(c))
      : collections
  const stacked = !singleCollection && visible.length > 0
  const totalColor = singleCollection
    ? colorFor(collections[0] || "topshot", 0)
    : "#10b981"

  // Platform-event markers: render only when the event date falls inside
  // (not strictly past) the chart's domain. We use ifOverflow="extendDomain"
  // so a marker at the boundary still renders with its label intact, even
  // if Recharts would otherwise cull it as "outside the data range".
  const firstDate = points[0].date
  const lastDate = points[points.length - 1].date

  return (
    <div style={{ width: "100%", height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            {(stacked ? visible : ["total"]).map((c, i) => (
              <linearGradient key={c} id={`grad-${c}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stacked ? colorFor(c, i) : totalColor} stopOpacity={0.5} />
                <stop offset="100%" stopColor={stacked ? colorFor(c, i) : totalColor} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={tickFormatter}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
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
                  stroke={totalColor}
                  fill="url(#grad-total)"
                  strokeWidth={1.5}
                />
              )}
          {PLATFORM_EVENTS.map((ev) => {
            // Only skip markers that are strictly before the chart starts —
            // boundary events (e.g. Dec 28 next to a Dec 29 first point)
            // should still render.
            if (ev.date < firstDate || ev.date > lastDate) return null
            return (
              <ReferenceLine
                key={ev.date}
                x={ev.date}
                stroke="#71717a"
                strokeDasharray="4 4"
                strokeWidth={1}
                ifOverflow="extendDomain"
                label={{
                  value: ev.label,
                  position: "top",
                  fill: "#a1a1aa",
                  fontSize: 10,
                  offset: 6,
                }}
              />
            )
          })}
        </AreaChart>
      </ResponsiveContainer>
      {weekly ? (
        <div className="text-[10px] text-zinc-500 mt-1.5 text-right">Bucketed by week</div>
      ) : null}
    </div>
  )
}
