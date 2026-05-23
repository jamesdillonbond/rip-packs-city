"use client"

// components/entity/FmvHistoryChart.tsx
// Phase 1B. Client-side FMV history line chart with 30/90/365-day toggle.
// Re-fetches /api/entity/edition?part=fmv-history&days=N on toggle.

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

interface HistoryPoint {
  day: string
  fmv_usd: number | null
  wap_usd: number | null
  floor_usd: number | null
  confidence: string | null
  sales_count_30d: number | null
  computed_at: string | null
}

interface Props {
  collectionUrlSlug: string
  routeSlug: string
  initial: HistoryPoint[]
}

const RANGES: Array<{ days: number; label: string }> = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "365d" },
]

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

export default function FmvHistoryChart({ collectionUrlSlug, routeSlug, initial }: Props) {
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<HistoryPoint[]>(initial)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (days === 30) { setData(initial); return }
    let cancelled = false
    setLoading(true)
    const url = `/api/entity/edition?collection=${encodeURIComponent(collectionUrlSlug)}&slug=${encodeURIComponent(routeSlug)}&part=fmv-history&days=${days}`
    fetch(url, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: HistoryPoint[]) => { if (!cancelled) setData(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) setData([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, collectionUrlSlug, routeSlug, initial])

  const series = useMemo(() => data.filter(d => d.fmv_usd !== null && Number.isFinite(d.fmv_usd as number))
    .map(d => ({ ...d, label: fmtDay(d.day) })), [data])

  const tooLittleData = series.length <= 2

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {RANGES.map(r => (
          <button
            key={r.days}
            type="button"
            onClick={() => setDays(r.days)}
            className="rpc-chip"
            style={{
              background: days === r.days ? "var(--rpc-red-bg)" : undefined,
              borderColor: days === r.days ? "var(--rpc-red-border)" : undefined,
              color: days === r.days ? "var(--rpc-red)" : undefined,
              cursor: "pointer",
            }}
          >{r.label}</button>
        ))}
        {loading && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginLeft: 8, alignSelf: "center" }}>
            loading…
          </span>
        )}
      </div>
      {tooLittleData ? (
        <div style={{
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          border: "1px dashed var(--rpc-border)",
          borderRadius: 6,
        }}>
          Building price history — too few sales to chart
        </div>
      ) : (
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                stroke="rgba(255,255,255,0.35)"
                tick={{ fontSize: 10, fill: "rgba(255,255,255,0.55)" }}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis
                stroke="rgba(255,255,255,0.35)"
                tick={{ fontSize: 10, fill: "rgba(255,255,255,0.55)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => fmtUsd(v as number)}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(13,13,13,0.96)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
                labelStyle={{ color: "var(--rpc-text-secondary)" }}
                formatter={(value, name, item) => {
                  const p = item?.payload as HistoryPoint | undefined
                  if (name === "fmv_usd") {
                    return [
                      `${fmtUsd(value as number)}${p?.confidence ? ` (${p.confidence})` : ""}${p?.sales_count_30d ? ` · ${p.sales_count_30d} sales/30d` : ""}`,
                      "FMV",
                    ]
                  }
                  return [String(value), String(name)]
                }}
              />
              <Line type="monotone" dataKey="fmv_usd" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
