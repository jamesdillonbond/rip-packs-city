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
import { usdSignFirst } from "@/lib/usd-format"
import { mergeFmvAndAsk, type PinnacleAskPoint } from "@/lib/pinnacle/ask-history"

export interface PinnacleFmvPoint {
  computed_at: string
  fmv_usd: number | null
  fmv_confidence: string | null
  fmv_sales_count_30d: number | null
}

// Exported for unit testing — the money formatter is otherwise only reachable
// via recharts' internal tick/tooltip callbacks. A regression here silently
// renders $0.00 / — where a real price belongs.
export function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // This is a daily FMV series; format the axis/tooltip day in UTC so a point
  // doesn't slip to the previous calendar day for viewers west of UTC — matching
  // the sibling daily chart FmvHistoryChart.
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function fmtUsd(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

/**
 * `asks` (2026-11-23): the pin's lowest-ask changes, ascending. Omitted = FMV-only chart (old shape);
 * null = the ask read FAILED, so the chart says so instead of implying there was no ask;
 * [] / all-null = RPC recorded no live ask in the tracked window (a fact, stated as one).
 */
export default function PinnacleFmvChart({ points, asks }: { points: PinnacleFmvPoint[]; asks?: PinnacleAskPoint[] | null }) {
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
  // Ask line: sky-700 on the light theme keeps ≥ 3:1 for a graphic against the page (sky-400 does not).
  const askStroke = light ? "#0369A1" : "#38BDF8"

  const fmvFinite = useMemo(
    () => points.filter((d) => d.fmv_usd !== null && Number.isFinite(d.fmv_usd as number)),
    [points],
  )
  const askKnown = Array.isArray(asks) && asks.some((a) => a.floor_ask !== null && Number.isFinite(Number(a.floor_ask)))
  const series = useMemo(() => {
    if (!askKnown) return fmvFinite.map((d) => ({ ...d, ask_usd: undefined as number | null | undefined, label: fmtDay(d.computed_at) }))
    return mergeFmvAndAsk(points, asks ?? null).map((m) => ({
      computed_at: m.t,
      fmv_usd: m.fmv_usd ?? null,
      fmv_confidence: null,
      fmv_sales_count_30d: m.fmv_sales_count_30d ?? null,
      ask_usd: m.ask_usd,
      label: fmtDay(m.t),
    }))
  }, [askKnown, fmvFinite, points, asks])

  if (fmvFinite.length <= 2) {
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
    <div style={{ width: "100%" }}>
      <div style={{ width: "100%", height: 220 }}>
        {/* Positive starting height silences recharts' server-render width(-1)/height(-1)
            warning; see FmvHistoryChart for the measured reason. */}
        <ResponsiveContainer initialDimension={{ width: -1, height: 220 }}>
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
              formatter={(value, name, item) => {
                if (name === "ask_usd") return [fmtUsd(value as number), "Lowest ask"]
                const p = item?.payload as (PinnacleFmvPoint & { label: string }) | undefined
                return [
                  `${fmtUsd(value as number)}${p?.fmv_sales_count_30d ? ` · ${p.fmv_sales_count_30d} sales/30d` : ""}`,
                  "FMV",
                ]
              }}
            />
            {/* brand-exception: recharts SVG stroke can't resolve var(--rpc-red) */}
            <Line type="monotone" dataKey="fmv_usd" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
            {askKnown ? (
              /* brand-exception: recharts SVG stroke can't resolve a CSS var. Step line: an ask holds
                 until the next sweep changes it; a null (no live ask) breaks the line. */
              <Line type="stepAfter" dataKey="ask_usd" stroke={askStroke} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <AskCaption asks={asks} askKnown={askKnown} askColor={askStroke} />
    </div>
  )
}

/** The legend / honesty line under the chart. Renders nothing when the caller passed no asks. */
export function AskCaption({ asks, askKnown, askColor = "#38BDF8" }: { asks: PinnacleAskPoint[] | null | undefined; askKnown: boolean; askColor?: string }) {
  if (asks === undefined) return null
  const style = {
    marginTop: 6,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--rpc-text-muted)",
  } as const
  if (asks === null) return <div style={style} data-testid="pinnacle-ask-caption">Lowest-ask history is unavailable right now.</div>
  if (!askKnown) return <div style={style} data-testid="pinnacle-ask-caption">No live ask recorded for this pin since Oct 19, 2026.</div>
  return (
    <div style={style} data-testid="pinnacle-ask-caption">
      <span style={{ color: "var(--rpc-red-text)" }}>━</span> FMV{"  "}
      <span style={{ color: askColor }}>┅</span> Lowest ask on Disney Pinnacle (tracked since Oct 19, 2026; gaps = no live ask)
    </div>
  )
}
