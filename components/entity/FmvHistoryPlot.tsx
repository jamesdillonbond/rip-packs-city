"use client"

// components/entity/FmvHistoryPlot.tsx
//
// The recharts half of FmvHistoryChart, split out 2026-10-21 so recharts
// (366 KB raw, the edition page's largest script, 45 KB of it unused on load —
// Lighthouse mobile) loads AFTER the page instead of in its critical path. The
// parent loads this with next/dynamic({ ssr: false }) inside its fixed 220 px
// box, so nothing shifts; the server never drew a line here anyway (recharts
// renders width -1 until the client measures). Same JSX as before, moved.

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { fmtUsd } from "@/components/entity/FmvHistoryChart"

export interface FmvHistoryPlotProps {
  series: Array<Record<string, unknown>>
  source: "fmv" | "sales"
  showVolume: boolean
  showRange: boolean
  showAsp: boolean
  showMa: boolean
  showBuys: boolean
  wallet: string | null
  light: boolean
  axis: string
  tick: string
  grid: string
  tipBg: string
}

export default function FmvHistoryPlot({ series, source, showVolume, showRange, showAsp, showMa, showBuys, wallet, light, axis, tick, grid, tipBg }: FmvHistoryPlotProps) {
  return (
        <ResponsiveContainer minWidth={0} initialDimension={{ width: -1, height: 220 }}>
          <ComposedChart data={series} margin={{ top: 8, right: showVolume ? 4 : 16, bottom: 8, left: 4 }}>
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
              yAxisId="usd"
              stroke={axis}
              tick={{ fontSize: 10, fill: tick }}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => fmtUsd(v as number)}
              width={48}
            />
            {showVolume && (
              <YAxis
                yAxisId="vol"
                orientation="right"
                stroke={axis}
                tick={{ fontSize: 10, fill: tick }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
                width={32}
              />
            )}
            <Tooltip
              contentStyle={{
                background: tipBg,
                border: "1px solid var(--rpc-border)",
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              labelStyle={{ color: "var(--rpc-text-secondary)" }}
              formatter={(value, name, item) => {
                const p = item?.payload as { count?: number | null; low?: number | null; high?: number | null; maWindow?: number; buyNote?: string | null } | undefined
                if (name === "asp") return [fmtUsd(value as number), "ASP 30d"]
                if (name === "range") {
                  const r = value as unknown as [number, number] | null
                  return [r ? `${fmtUsd(r[0])}–${fmtUsd(r[1])}` : "—", "Low–high prints"]
                }
                if (name === "volume") return [String(value), "Sales"]
                if (name === "ma") return [fmtUsd(value as number), `MA ${p?.maWindow ?? 7}`]
                if (name === "buy") return [p?.buyNote ?? fmtUsd(value as number), "My buy"]
                if (name !== "value") return [String(value), String(name)]
                if (source === "sales") {
                  const range =
                    p?.low != null && p?.high != null && Number(p.low) !== Number(p.high)
                      ? ` (${fmtUsd(Number(p.low))}–${fmtUsd(Number(p.high))})`
                      : ""
                  return [
                    `${fmtUsd(value as number)}${range}${p?.count ? ` · ${p.count} sale${p.count === 1 ? "" : "s"}` : ""}`,
                    "Median sale",
                  ]
                }
                return [
                  `${fmtUsd(value as number)}${p?.count ? ` · ${p.count} sales/30d` : ""}`,
                  "FMV",
                ]
              }}
            />
            {/* brand-exception: recharts SVG stroke/fill can't resolve var(--rpc-red) / theme tokens */}
            {showVolume && (
              <Bar yAxisId="vol" dataKey="volume" name="volume" fill={light ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.14)"} isAnimationActive={false} />
            )}
            {showRange && (
              <Area yAxisId="usd" type="monotone" dataKey="range" name="range" stroke="none" fill="#E03A2F" fillOpacity={0.12} connectNulls isAnimationActive={false} />
            )}
            {/* brand-exception: recharts SVG stroke can't resolve var(--rpc-red) */}
            <Line yAxisId="usd" type="monotone" dataKey="value" name="value" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
            {showAsp && source === "fmv" && (
              /* brand-exception: recharts SVG stroke can't resolve theme tokens */
              <Line yAxisId="usd" type="monotone" dataKey="asp" name="asp" stroke={light ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.65)"} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
            )}
            {showMa && (
              <Line yAxisId="usd" type="monotone" dataKey="ma" name="ma" stroke="#F59E0B" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            )}
            {showBuys && wallet && (
              <Scatter yAxisId="usd" dataKey="buy" name="buy" fill="#22C55E" shape="circle" isAnimationActive={false} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
  )
}
