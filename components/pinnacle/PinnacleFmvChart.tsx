"use client"

// components/pinnacle/PinnacleFmvChart.tsx
// Per-render Pinnacle FMV history line chart. Pinnacle FMV lives in the
// render-keyed pinnacle_fmv_history (engine pinnacle-2.0.0-render), a different
// table + shape than the shared editions fmv_snapshots that FmvHistoryChart
// reads, so this is its own lightweight server-fed chart (no range toggle —
// the render page passes the full recent window it already fetched).

import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

export interface PinnacleFmvPoint {
  computed_at: string
  fmv_usd: number | null
  fmv_confidence: string | null
  fmv_sales_count_30d: number | null
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

export default function PinnacleFmvChart({ points }: { points: PinnacleFmvPoint[] }) {
  // recharts SVG props can't resolve CSS var() (documented brand-exception), so
  // axis/grid colors are picked in JS off the applied theme after mount.
  const [light, setLight] = useState(false)
  useEffect(() => {
    setLight(document.documentElement.dataset.theme === "light")
  }, [])
  const axis = light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.35)"
  const tick = light ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.55)"
  const grid = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)"
  const tipBg = light ? "rgba(247,247,245,0.97)" : "rgba(13,13,13,0.96)"

  const series = useMemo(
    () =>
      points
        .filter((d) => d.fmv_usd !== null && Number.isFinite(d.fmv_usd as number))
        .map((d) => ({ ...d, label: fmtDay(d.computed_at) })),
    [points],
  )

  if (series.length <= 2) {
    return (
      <div
        style={{
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          border: "1px dashed var(--rpc-border)",
          borderRadius: 6,
        }}
      >
        Building price history — too few FMV points to chart
      </div>
    )
  }

  return (
    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            stroke={axis}
            tick={{ fontSize: 10, fill: tick }}
            axisLine={false}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            stroke={axis}
            tick={{ fontSize: 10, fill: tick }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => fmtUsd(v as number)}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: tipBg,
              border: "1px solid var(--rpc-border)",
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
            labelStyle={{ color: "var(--rpc-text-secondary)" }}
            formatter={(value, _name, item) => {
              const p = item?.payload as (PinnacleFmvPoint & { label: string }) | undefined
              return [
                `${fmtUsd(value as number)}${p?.fmv_confidence ? ` (${p.fmv_confidence})` : ""}${
                  p?.fmv_sales_count_30d ? ` · ${p.fmv_sales_count_30d} sales/30d` : ""
                }`,
                "FMV",
              ]
            }}
          />
          {/* brand-exception: recharts SVG stroke can't resolve var(--rpc-red) */}
          <Line type="monotone" dataKey="fmv_usd" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
