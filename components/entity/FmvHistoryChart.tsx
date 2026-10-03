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

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
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
import { usdSignFirst } from "@/lib/usd-format"

// OVERLAYS (beta feedback 10259 / 10261 / 10263, 2026-10-03). Opt-in, off by
// default, additive — the collector layers what they want on the one chart.
// Each one is drawn from data RPC actually keeps, and the caption names it:
//   ASP      — 30-day average sale price as of each day (fmv_snapshots.asp_usd);
//              FMV ranges only — the long ranges already plot the median print.
//   RANGE    — each bucket's low–high sale prints as a band (get_edition_sale_
//              history low_usd/high_usd). Not candlesticks: RPC keeps no open/
//              close per bucket, so a candle would be invented. Said so in copy.
//   VOLUME   — sales per bucket, bars on a second axis (same RPC, sales_count).
//   MA       — a trailing 7-point moving average of the plotted value, computed
//              here from the points on screen (so it is always the series shown).
//   MY BUYS  — the viewer's own purchases of this edition as dots (date, price),
//              from the wallet the site already tracks; shown only when one is.
// NOT offered, honestly: a "low ask history" or "high offer history" — RPC
// records the CURRENT ask/offer (edition_offers), not a series (fmv_snapshots'
// top_shot_ask is populated on 3 % of snapshots); overlaying it would plot a
// column that is mostly empty and call it history.

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
  /**
   * Whether the SERVER read that produced `initial` failed.
   *
   * ⚠ Without this the 30-day view — the one the page opens on — renders a
   * server-side failure as "too few sales to chart", which is the exact
   * sentence the `failed` state below exists to avoid. The client fetch has
   * been able to tell the two apart since it was written; the SEEDED path
   * could not, because `[]` reached it with no provenance.
   */
  initialFailed?: boolean
  /**
   * false for a collection whose sales are not a recorded feed (Panini: RPC keeps
   * the LAST sale per card, not every sale). The 1Y/ALL ranges read sale prints,
   * so they are hidden rather than rendered as "too few recorded sales", and the
   * FMV empty state stops blaming sales. Default true (every other collection).
   */
  salesTracked?: boolean
}

interface SalePoint {
  bucket: string
  median_usd: number | null
  low_usd: number | null
  high_usd: number | null
  sales_count: number | null
  grain: string | null
}

interface Purchase {
  sold_at: string
  price_usd: number | null
  serial_number: number | null
  marketplace: string | null
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
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

/**
 * Trailing moving average at index i over up to `size` points (fewer at the
 * start — the window used is returned so the tooltip can say "MA 3" honestly
 * instead of implying seven points that do not exist yet). Exported for tests.
 */
export function trailingAverage(values: number[], i: number, size = 7): { avg: number; window: number } {
  const win = values.slice(Math.max(0, i - (size - 1)), i + 1)
  const avg = win.reduce((a, v) => a + v, 0) / win.length
  return { avg: Number(avg.toFixed(4)), window: win.length }
}

// The wallet the site already tracks for this viewer (WalletHydrator's key,
// else the team-checklist keys). Read through useSyncExternalStore so the
// server and the first client paint agree (no wallet → no MY BUYS chip).
const subscribeNever = () => () => {}
function readTrackedWallet(): string | null {
  try {
    const w = localStorage.getItem("rpc_wallet_address") || localStorage.getItem("rpc_checklist_wallet") || localStorage.getItem("rpc_checklist_wallet_solana")
    return w && w.trim() ? w.trim() : null
  } catch { return null }
}
const readNoWallet = () => null

export default function FmvHistoryChart({ collectionUrlSlug, routeSlug, initial, initialFailed = false, salesTracked = true }: Props) {
  const ranges = salesTracked ? RANGES : RANGES.filter(r => r.source === "fmv")
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<HistoryPoint[]>(initial)
  const [saleData, setSaleData] = useState<SalePoint[]>([])
  const [loading, setLoading] = useState(false)
  // A failed fetch must not render as "too few sales to chart" — that sentence
  // is a claim about the DATA, and using it for a network error tells the user
  // an actively-traded edition has no market. Tracked separately.
  const [failed, setFailed] = useState(initialFailed)
  const source: Source = RANGES.find(r => r.days === days)?.source ?? "fmv"

  // ── Overlays ────────────────────────────────────────────────────────────
  const [showAsp, setShowAsp] = useState(false)
  const [showRange, setShowRange] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  const [showMa, setShowMa] = useState(false)
  const [showBuys, setShowBuys] = useState(false)
  // Per-bucket sale prints for the FMV ranges (the sale ranges already hold
  // them in saleData). Fetched only when RANGE or VOLUME is on.
  const [bucketData, setBucketData] = useState<SalePoint[]>([])
  const [bucketFailed, setBucketFailed] = useState(false)
  // null on the server + first paint (no chip), the stored key after hydration
  // — no setState-in-effect, no hydration mismatch.
  const wallet = useSyncExternalStore(subscribeNever, readTrackedWallet, readNoWallet)
  const [buys, setBuys] = useState<Purchase[]>([])
  const [buysFailed, setBuysFailed] = useState(false)

  const needBuckets = (showRange || showVolume) && source === "fmv"
  useEffect(() => {
    if (!needBuckets) return
    let cancelled = false
    fetch(`/api/entity/edition?collection=${encodeURIComponent(collectionUrlSlug)}&slug=${encodeURIComponent(routeSlug)}&part=sale-history&days=${days}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: unknown) => { if (!cancelled) { setBucketFailed(false); setBucketData(Array.isArray(rows) ? (rows as SalePoint[]) : []) } })
      .catch(() => { if (!cancelled) { setBucketFailed(true); setBucketData([]) } })
    return () => { cancelled = true }
  }, [needBuckets, days, collectionUrlSlug, routeSlug])

  useEffect(() => {
    if (!showBuys || !wallet) return
    let cancelled = false
    fetch(`/api/entity/edition?collection=${encodeURIComponent(collectionUrlSlug)}&slug=${encodeURIComponent(routeSlug)}&part=wallet-purchases&wallet=${encodeURIComponent(wallet)}&days=${days}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: unknown) => { if (!cancelled) { setBuysFailed(false); setBuys(Array.isArray(rows) ? (rows as Purchase[]) : []) } })
      .catch(() => { if (!cancelled) { setBuysFailed(true); setBuys([]) } })
    return () => { cancelled = true }
  }, [showBuys, wallet, days, collectionUrlSlug, routeSlug])
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
    if (days === 30 && source === "fmv") { setData(initial); setFailed(initialFailed); return }
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
  }, [days, source, collectionUrlSlug, routeSlug, initial, initialFailed])

  // One shape for the chart regardless of source: `value` is FMV on the short
  // ranges and the MEDIAN PRINT on the long ones.
  const series = useMemo(() => {
    const base = source === "sales"
      ? saleData
          .filter(d => d.median_usd !== null && Number.isFinite(Number(d.median_usd)))
          .map(d => ({
            key: d.bucket.slice(0, 10),
            label: fmtBucket(d.bucket, d.grain),
            value: Number(d.median_usd),
            count: d.sales_count,
            low: d.low_usd == null ? null : Number(d.low_usd),
            high: d.high_usd == null ? null : Number(d.high_usd),
            asp: null as number | null,
            volume: d.sales_count ?? null,
          }))
      : data
          .filter(d => d.fmv_usd !== null && Number.isFinite(d.fmv_usd as number))
          .map(d => {
            // Per-day prints for the overlays, matched by date to the FMV day.
            const b = bucketData.find(x => x.bucket.slice(0, 10) === d.day.slice(0, 10))
            return {
              key: d.day.slice(0, 10),
              label: fmtDay(d.day),
              value: Number(d.fmv_usd),
              count: d.sales_count_30d,
              low: b?.low_usd == null ? null : Number(b.low_usd),
              high: b?.high_usd == null ? null : Number(b.high_usd),
              asp: d.wap_usd == null || !Number.isFinite(Number(d.wap_usd)) ? null : Number(d.wap_usd),
              volume: b?.sales_count ?? null,
            }
          })
    // Trailing 7-point moving average of the plotted value — from the points on
    // screen, so it is always an average OF THIS series. The first six points
    // carry a shorter window, which is stated in the tooltip label.
    const values = base.map(p => p.value)
    const withMa = base.map((p, i) => {
      const { avg, window } = trailingAverage(values, i, 7)
      return { ...p, ma: avg, maWindow: window, range: p.low != null && p.high != null ? [p.low, p.high] as [number, number] : null }
    })
    // The viewer's buys, placed on the nearest plotted bucket at their own price.
    if (!showBuys || buys.length === 0) return withMa
    const byKey = new Map(withMa.map((p, i) => [p.key, i] as const))
    const buyPts = withMa.map(p => ({ ...p, buy: null as number | null, buyNote: null as string | null }))
    for (const b of buys) {
      const price = Number(b.price_usd)
      if (!Number.isFinite(price) || !b.sold_at) continue
      const day = b.sold_at.slice(0, 10)
      let idx = byKey.get(day)
      if (idx === undefined) {
        // nearest bucket at or before the sale date (monthly / weekly buckets)
        for (let i = withMa.length - 1; i >= 0; i--) { if (withMa[i].key <= day) { idx = i; break } }
      }
      if (idx === undefined) continue
      const note = `${fmtUsd(price)}${b.serial_number != null ? ` · #${b.serial_number}` : ""} · ${fmtDay(b.sold_at)}`
      buyPts[idx] = { ...buyPts[idx], buy: price, buyNote: buyPts[idx].buyNote ? `${buyPts[idx].buyNote}; ${note}` : note }
    }
    return buyPts
  }, [source, data, saleData, bucketData, showBuys, buys])

  const grain = source === "sales" ? (saleData.find(d => d.grain)?.grain ?? null) : null
  const overlayCaption = [
    showAsp && source === "fmv" ? "ASP 30D" : null,
    showRange ? "LOW–HIGH PRINTS" : null,
    showVolume ? "SALES/BUCKET" : null,
    showMa ? "MA 7" : null,
    showBuys && wallet ? "MY BUYS" : null,
  ].filter(Boolean).join(" · ")
  const tooLittleData = series.length <= 2

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {ranges.map(r => (
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
        {overlayCaption ? ` · ${overlayCaption}` : ""}
      </div>
      {/* Overlay chips — opt-in, off by default, additive (10259/10261/10263). */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }} role="group" aria-label="Chart overlays">
        {source === "fmv" && (
          <OverlayChip on={showAsp} onClick={() => setShowAsp(v => !v)} title="30-day average sale price as of each day (ASP) — the sales-based average the FMV model starts from">ASP</OverlayChip>
        )}
        <OverlayChip on={showRange} onClick={() => setShowRange(v => !v)} title="Low–high band of the sale prints in each bucket. Not candlesticks: RPC keeps no open/close per bucket.">RANGE</OverlayChip>
        <OverlayChip on={showVolume} onClick={() => setShowVolume(v => !v)} title="Sales per bucket, as bars on the right axis">VOLUME</OverlayChip>
        <OverlayChip on={showMa} onClick={() => setShowMa(v => !v)} title="Trailing 7-point moving average of the plotted line">MA 7</OverlayChip>
        {wallet && (
          <OverlayChip on={showBuys} onClick={() => setShowBuys(v => !v)} title={`Your own purchases of this edition (price + date) for the wallet you track, ${wallet.slice(0, 6)}…${wallet.slice(-4)}`}>MY BUYS</OverlayChip>
        )}
      </div>
      {(showRange || showVolume) && bucketFailed && source === "fmv" && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginBottom: 6 }}>
          Couldn&rsquo;t load the sale prints behind RANGE / VOLUME right now.
        </div>
      )}
      {showBuys && wallet && (buysFailed ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginBottom: 6 }}>
          Couldn&rsquo;t load your purchases right now.
        </div>
      ) : buys.length === 0 ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginBottom: 6 }} data-testid="buys-empty">
          No recorded purchases of this edition for {wallet.slice(0, 6)}…{wallet.slice(-4)} in this window.
        </div>
      ) : null)}
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
            : salesTracked
              ? "Building price history — too few sales to chart"
              : "Building price history — not enough daily FMV readings to chart yet"}
        </div>
      ) : (
        <div style={{ width: "100%", height: 220 }}>
          {/* minWidth={0} suppresses recharts' SSR width(-1)/height(-1) console
              warning (parent has 0 width during SSR before client measures) —
              per recharts' own guidance. Cosmetic: quiets log noise only. */}
          <ResponsiveContainer minWidth={0}>
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
              <Line yAxisId="usd" type="monotone" dataKey="value" name="value" stroke="#E03A2F" strokeWidth={2} dot={false} isAnimationActive={false} />
              {showAsp && source === "fmv" && (
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
        </div>
      )}
    </div>
  )
}

function OverlayChip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rpc-chip"
      aria-pressed={on}
      title={title}
      style={{
        background: on ? "var(--rpc-red-bg)" : undefined,
        borderColor: on ? "var(--rpc-red-border)" : undefined,
        color: on ? "var(--rpc-red)" : undefined,
        cursor: "pointer",
      }}
    >{children}</button>
  )
}
