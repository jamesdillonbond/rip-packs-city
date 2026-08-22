"use client"

// components/entity/FmvHistoryChart.tsx
// Phase 1B. Client-side price-history line chart.
//
// TWO SOURCES, AND THE DISTINCTION IS THE POINT (2026-08-11).
//   30d / 90d  → FMV snapshots (get_edition_fmv_history). A modelled value.
//   1Y / ALL   → actual SALE PRINTS, median per bucket (get_edition_sale_history).
//
// It has to work this way: `fmv_snapshots` only begins 2026-03-31, so the old
// "365d" chip never showed a year — it showed the ~4.5 months that exist and
// looked like a year. `sales` goes back to 2020-07-28 (3.11M Top Shot rows), so
// the long horizons are derived from prints instead, which is also the more
// honest number: a print is what someone paid.
//
// The two series are NOT merged into one line. An FMV estimate and a median
// print are different quantities, and splicing them would invent a continuity
// the data does not have. Switching range switches source, and the caption
// under the chips says which one you are looking at, including the bucket grain
// (the RPC returns `grain` per row, so the label is measured, not assumed).

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

interface SalePoint {
  bucket: string
  median_usd: number | null
  low_usd: number | null
  high_usd: number | null
  sales_count: number | null
  grain: string | null
}

type Source = "fmv" | "sales"

const RANGES: Array<{ days: number; label: string; source: Source }> = [
  { days: 30, label: "30d", source: "fmv" },
  { days: 90, label: "90d", source: "fmv" },
  // 365 was an FMV range and could never deliver a year of FMV; it now reads
  // sale prints, which genuinely go back that far.
  { days: 365, label: "1Y", source: "sales" },
  // days=0 is the RPC's all-time sentinel.
  { days: 0, label: "ALL", source: "sales" },
]

const GRAIN_LABEL: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
}

// Exported for unit testing — these are the money/date formatters that decide
// what the axis, tooltip, and empty-state render; otherwise reachable only
// through recharts' internal tick/tooltip callbacks (same rationale as
// PinnacleFmvChart's exported fmtUsd/fmtDay).
export function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // `iso` is a date-only "YYYY-MM-DD" bucket (RPC returns DATE(computed_at)),
  // which parses as UTC midnight. Format in UTC so the label doesn't slip to the
  // previous calendar day for viewers west of UTC (the whole US user base).
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

/**
 * Label a sale-history bucket. A monthly bucket must not be labelled "Jul 1" —
 * that reads as a single day when it summarises a whole month — so the format
 * follows the grain the RPC actually used.
 */
export function fmtBucket(iso: string, grain: string | null | undefined): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (grain === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

export default function FmvHistoryChart({ collectionUrlSlug, routeSlug, initial }: Props) {
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<HistoryPoint[]>(initial)
  const [saleData, setSaleData] = useState<SalePoint[]>([])
  const [loading, setLoading] = useState(false)
  // A failed fetch must not render as "too few sales to chart" — that sentence
  // is a claim about the DATA, and using it for a network error tells the user
  // an actively-traded edition has no market. Tracked separately.
  const [failed, setFailed] = useState(false)
  const source: Source = RANGES.find(r => r.days === days)?.source ?? "fmv"
  // recharts stroke/fill take raw SVG color strings — CSS var() doesn't resolve
  // there (the documented brand-exception), so axis/grid colors are picked in
  // JS off the applied theme. Defaults to dark on the server + first paint
  // (matching the no-attribute default) and corrects after mount in light mode.
  const [light, setLight] = useState(false)
  useEffect(() => {
    setLight(document.documentElement.dataset.theme === "light")
  }, [])
  // brand-exception: recharts SVG props can't resolve CSS var()
  const axis = light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.35)"
  const tick = light ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.55)"
  const grid = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)"
  const tipBg = light ? "rgba(247,247,245,0.97)" : "rgba(13,13,13,0.96)" // brand-exception: recharts SVG color

  useEffect(() => {
    // 30d is server-seeded, so it needs no fetch.
    if (days === 30 && source === "fmv") { setData(initial); setFailed(false); return }
    let cancelled = false
    setLoading(true)
    setFailed(false)
    const part = source === "sales" ? "sale-history" : "fmv-history"
    const url = `/api/entity/edition?collection=${encodeURIComponent(collectionUrlSlug)}&slug=${encodeURIComponent(routeSlug)}&part=${part}&days=${days}`
    fetch(url, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: unknown) => {
        if (cancelled) return
        const arr = Array.isArray(rows) ? rows : []
        if (source === "sales") setSaleData(arr as SalePoint[])
        else setData(arr as HistoryPoint[])
      })
      .catch(() => {
        if (cancelled) return
        setFailed(true)
        if (source === "sales") setSaleData([])
        else setData([])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, source, collectionUrlSlug, routeSlug, initial])

  // One shape for the chart regardless of source: `value` is FMV on the short
  // ranges and the MEDIAN PRINT on the long ones.
  const series = useMemo(() => {
    if (source === "sales") {
      return saleData
        .filter(d => d.median_usd !== null && Number.isFinite(Number(d.median_usd)))
        .map(d => ({
          label: fmtBucket(d.bucket, d.grain),
          value: Number(d.median_usd),
          count: d.sales_count,
          low: d.low_usd,
          high: d.high_usd,
        }))
    }
    return data
      .filter(d => d.fmv_usd !== null && Number.isFinite(d.fmv_usd as number))
      .map(d => ({
        label: fmtDay(d.day),
        value: Number(d.fmv_usd),
        count: d.sales_count_30d,
        low: null as number | null,
        high: null as number | null,
      }))
  }, [source, data, saleData])

  const grain = source === "sales" ? (saleData.find(d => d.grain)?.grain ?? null) : null
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
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em", color: "var(--rpc-text-muted)", marginBottom: 8 }}>
        {source === "sales"
          ? "MEDIAN SALE PRICE" + (grain ? " · " + (GRAIN_LABEL[grain] ?? grain) : "") + " · ACTUAL PRINTS"
          : "ESTIMATED FMV · DAILY"}
      </div>
      {failed ? (
        // Deliberately NOT the "too few sales" copy: this is a failed request,
        // not a verdict on the market.
        <div style={{
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          border: "1px dashed var(--rpc-border)",
          borderRadius: 6,
        }}>
          Couldn&rsquo;t load price history right now
        </div>
      ) : tooLittleData ? (
        <div style={{
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          border: "1px dashed var(--rpc-border)",
          borderRadius: 6,
        }}>
          {source === "sales"
            ? "Too few recorded sales in this window to chart"
            : "Building price history — too few sales to chart"}
        </div>
      ) : (
        <div style={{ width: "100%", height: 220 }}>
          {/* minWidth={0} suppresses recharts' SSR width(-1)/height(-1) console
              warning (parent has 0 width during SSR before client measures) —
              per recharts' own guidance. Cosmetic: quiets log noise only. */}
          <ResponsiveContainer minWidth={0}>
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
                tickFormatter={v => fmtUsd(v as number)}
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
                  const p = item?.payload as { count?: number | null; low?: number | null; high?: number | null } | undefined
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
              {/* brand-exception: recharts SVG stroke can't resolve var(--rpc-red) */}
          <Line type="monotone" dataKey="value" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
