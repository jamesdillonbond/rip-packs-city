"use client"

// app/insights/market/page.tsx
//
// The RPC Index — a tier-segmented Top Shot market index. No auth.
//
// The framing that makes this honest: commons dominate Top Shot sales by COUNT
// (~450 of ~550 daily sales), so the all-market median is sub-$1 and a single
// headline "Top Shot is worth $X" number is actively misleading (the same trap
// as quoting a face-value 200x pack EV). So we DON'T headline one number — we
// segment by tier and show a NORMALIZED index per tier (base day = 100) as a
// multi-line trend, plus a daily $-volume bar.
//
// Data source: GET /api/public/insights/market → reads the public
// `topshot_market_index_daily` view (shipped 2026-05-31 via
// audit_20260531_topshot_market_index_daily_view): tier-segmented daily
// roll-up of real secondary sales (price_usd > 0) over the trailing 120 days.
//
// Anatomy, top to bottom:
//   1. Hero band (display H1 + lede)
//   2. Per-tier headline cards (current index, median px, 30d change)
//   3. Normalized index chart (inline SVG, one line per tier, base = 100)
//      with a click-to-toggle legend
//   4. Daily $-volume bar (inline SVG, ALL-tier total GMV)
//   5. Footer: methodology + "Share this" twitter intent button
//
// Brand tokens for all DOM styling. SVG presentation attributes (stroke/fill)
// can't resolve CSS vars, so the chart palette is hardcoded hex matching the
// tier tokens in app/rpc-tokens.css (same approach as the OG cards).

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Row = {
  d: string
  tier: string
  sales: number | string | null
  volume_usd: number | string | null
  median_px: number | string | null
  avg_px: number | string | null
  max_px: number | string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number }
  rows: Row[]
}

// Tiers we plot, in descending typical-value order. ALL is intentionally
// excluded from the index lines (commons dominate it, so it isn't a
// meaningful "index") — ALL feeds the volume bar only.
const PLOT_TIERS = ["LEGENDARY", "RARE", "FANDOM", "COMMON", "ULTIMATE"] as const
type PlotTier = (typeof PLOT_TIERS)[number]

// Hardcoded hex — matches --tier-* tokens; SVG stroke can't use CSS vars.
const TIER_HEX: Record<PlotTier, string> = {
  LEGENDARY: "#FFD700",
  ULTIMATE: "#FF6B35",
  RARE: "#818CF8",
  FANDOM: "#34D399",
  COMMON: "#94A3B8",
}

function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 10) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtPctChange(n: number | null): string {
  if (n == null) return "—"
  const r = Math.round(n)
  return `${r > 0 ? "+" : ""}${r}%`
}

function fmtDateShort(d: string): string {
  // d is "YYYY-MM-DD". Render as "May 31" without TZ drift (parse parts).
  const [, m, day] = d.split("-").map(Number)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${months[(m ?? 1) - 1]} ${day}`
}

type TierPoint = { d: string; median: number; index: number; xi: number }

type Built = {
  // x spine: every date that has an ALL row (i.e. any sales that day), asc
  dates: string[]
  // per-tier normalized series (only days the tier actually traded)
  series: Record<PlotTier, TierPoint[]>
  // per-tier headline: latest median, latest index, 30d % change
  headline: Record<
    PlotTier,
    { latestMedian: number | null; latestIndex: number | null; change30d: number | null }
  >
  // daily total GMV from the ALL row, aligned to `dates`
  volume: { d: string; v: number }[]
}

function buildSeries(rows: Row[]): Built {
  const byTier: Record<string, Map<string, { median: number | null; volume: number | null }>> = {}
  for (const r of rows) {
    const t = (r.tier ?? "").toUpperCase()
    if (!byTier[t]) byTier[t] = new Map()
    byTier[t].set(r.d, { median: num(r.median_px), volume: num(r.volume_usd) })
  }

  // Date spine = ALL rows (present on every day with any sale); fall back to
  // the union of all dates if ALL is somehow absent.
  let dates: string[] = []
  if (byTier["ALL"]) {
    dates = [...byTier["ALL"].keys()].sort()
  } else {
    const set = new Set<string>()
    for (const m of Object.values(byTier)) for (const k of m.keys()) set.add(k)
    dates = [...set].sort()
  }
  const xIndex = new Map(dates.map((d, i) => [d, i]))

  const series = {} as Record<PlotTier, TierPoint[]>
  const headline = {} as Built["headline"]

  // The most recent date in range, used as the anchor for "30d change".
  const latestDate = dates[dates.length - 1] ?? null
  const target30 = latestDate
    ? new Date(new Date(latestDate).getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
    : null

  for (const tier of PLOT_TIERS) {
    const m = byTier[tier]
    const pts: TierPoint[] = []
    if (m) {
      // Ordered list of (date, median) the tier actually traded.
      const ordered = [...m.entries()]
        .filter(([d, v]) => v.median != null && xIndex.has(d))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      const base = ordered.length ? (ordered[0][1].median as number) : null
      for (const [d, v] of ordered) {
        const median = v.median as number
        pts.push({
          d,
          median,
          index: base && base > 0 ? (median / base) * 100 : 100,
          xi: xIndex.get(d) as number,
        })
      }
    }
    series[tier] = pts

    // Headline metrics.
    const latest = pts.length ? pts[pts.length - 1] : null
    let change30d: number | null = null
    if (latest && target30 && m) {
      // Find the traded day on/closest-after the 30d-ago target.
      const prior = pts.find((p) => p.d >= target30)
      if (prior && prior.median > 0 && prior.d !== latest.d) {
        change30d = ((latest.median - prior.median) / prior.median) * 100
      }
    }
    headline[tier] = {
      latestMedian: latest ? latest.median : null,
      latestIndex: latest ? latest.index : null,
      change30d,
    }
  }

  const allMap = byTier["ALL"]
  const volume = dates.map((d) => ({ d, v: allMap?.get(d)?.volume ?? 0 }))

  return { dates, series, headline, volume }
}

// ── Inline SVG index chart ─────────────────────────────────────────────────
function IndexChart({
  built,
  hidden,
}: {
  built: Built
  hidden: Set<PlotTier>
}) {
  const W = 1000
  const H = 360
  const padL = 46
  const padR = 18
  const padT = 18
  const padB = 34
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const N = built.dates.length
  const x = (xi: number) => (N <= 1 ? padL + plotW / 2 : padL + (xi / (N - 1)) * plotW)

  // y domain from visible points; base 100 always in view.
  let maxIdx = 120
  for (const tier of PLOT_TIERS) {
    if (hidden.has(tier)) continue
    for (const p of built.series[tier]) if (p.index > maxIdx) maxIdx = p.index
  }
  const yMax = Math.ceil(maxIdx / 50) * 50
  const y = (idx: number) => padT + (1 - idx / yMax) * plotH

  const yTicks: number[] = []
  for (let v = 0; v <= yMax; v += 50) yTicks.push(v)

  // x tick labels — ~6 evenly spaced dates.
  const xTickCount = Math.min(6, N)
  const xTicks: number[] = []
  if (N > 0) {
    for (let i = 0; i < xTickCount; i++) {
      xTicks.push(Math.round((i / Math.max(1, xTickCount - 1)) * (N - 1)))
    }
  }

  function pathFor(tier: PlotTier): string {
    const pts = built.series[tier]
    if (pts.length === 0) return ""
    return pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.xi).toFixed(1)},${y(p.index).toFixed(1)}`)
      .join(" ")
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Normalized per-tier price index over the trailing window"
      style={{ display: "block" }}
    >
      {/* gridlines + y labels */}
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(v)}
            y2={y(v)}
            stroke={v === 100 ? "rgba(224,58,47,0.45)" : "rgba(255,255,255,0.08)"}
            strokeWidth={v === 100 ? 1.5 : 1}
            strokeDasharray={v === 100 ? "4 3" : undefined}
          />
          <text
            x={padL - 8}
            y={y(v) + 4}
            textAnchor="end"
            fill="rgba(255,255,255,0.45)"
            fontSize={13}
            fontFamily="monospace"
          >
            {v}
          </text>
        </g>
      ))}

      {/* x labels */}
      {xTicks.map((xi) => (
        <text
          key={xi}
          x={x(xi)}
          y={H - 10}
          textAnchor="middle"
          fill="rgba(255,255,255,0.45)"
          fontSize={13}
          fontFamily="monospace"
        >
          {built.dates[xi] ? fmtDateShort(built.dates[xi]) : ""}
        </text>
      ))}

      {/* lines + dots */}
      {PLOT_TIERS.filter((t) => !hidden.has(t)).map((tier) => {
        const pts = built.series[tier]
        const hex = TIER_HEX[tier]
        return (
          <g key={tier}>
            <path d={pathFor(tier)} fill="none" stroke={hex} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
            {pts.map((p) => (
              <circle key={p.d} cx={x(p.xi)} cy={y(p.index)} r={pts.length > 60 ? 0 : 2.4} fill={hex} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

// ── Inline SVG volume bars ─────────────────────────────────────────────────
function VolumeBars({ volume }: { volume: { d: string; v: number }[] }) {
  const W = 1000
  const H = 150
  const padL = 46
  const padR = 18
  const padT = 12
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const N = volume.length
  const maxV = Math.max(1, ...volume.map((p) => p.v))
  const bw = N > 0 ? Math.max(1, (plotW / N) * 0.7) : 1
  const x = (i: number) => (N <= 1 ? padL + plotW / 2 : padL + (i / N) * plotW + (plotW / N - bw) / 2)
  const y = (v: number) => padT + (1 - v / maxV) * plotH

  const yTicks = [0, maxV / 2, maxV]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Daily total marketplace volume in USD"
      style={{ display: "block" }}
    >
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill="rgba(255,255,255,0.45)" fontSize={12} fontFamily="monospace">
            {fmtUsd(v)}
          </text>
        </g>
      ))}
      {volume.map((p, i) => (
        <rect key={p.d} x={x(i)} y={y(p.v)} width={bw} height={Math.max(0, padT + plotH - y(p.v))} fill="rgba(224,58,47,0.55)" />
      ))}
    </svg>
  )
}

export default function MarketIndexPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<PlotTier>>(new Set())

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(`/api/public/insights/market?days=120`, {
          signal: ctrl.signal,
          cache: "no-store",
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as ApiResponse
        setRows(j.rows ?? [])
        setFetchedAt(j.meta?.fetched_at ?? null)
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return
        setError(e instanceof Error ? e.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    }
    run()
    return () => ctrl.abort()
  }, [])

  const built = useMemo(() => buildSeries(rows), [rows])

  function toggleTier(t: PlotTier) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  const tweetIntent = useMemo(() => {
    const text = `Top Shot's "floor price" is a sub-$1 number dominated by commons.\n\nThe RPC Index segments the market by tier — what Legendary, Rare, and Fandom moments are actually doing:`
    const url = `${SITE_URL}/insights/market`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  // Cards in descending typical-value order, skipping tiers with no data.
  const cardTiers = PLOT_TIERS.filter((t) => built.headline[t]?.latestMedian != null)

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-mk-hero">
        <div className="rpc-mk-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-mk-h1">The RPC Index</h1>
        <p className="rpc-mk-lede">
          Top Shot&apos;s market &ldquo;floor&rdquo; is a sub-$1 number because{" "}
          <strong>commons dominate by volume</strong> — roughly 450 of every 550
          daily sales. One blended price hides everything that matters. So we{" "}
          <strong>segment by tier</strong> and index each one to 100 at the start
          of the window: a normalized read of what Legendary, Rare, Fandom, and
          Common moments are <em>actually</em> doing.
        </p>
        <div className="rpc-mk-meta-row">
          <span className="rpc-mk-meta">
            Updated{" "}
            {fetchedAt ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}
          </span>
          <span className="rpc-mk-meta-sep">·</span>
          <span className="rpc-mk-meta">Trailing 120 days</span>
          <span className="rpc-mk-meta-sep">·</span>
          <span className="rpc-mk-meta">No signup</span>
        </div>
      </section>

      {/* ── Per-tier headline cards ───────────────────────────────────── */}
      <section className="rpc-mk-cards" aria-label="Per-tier headline">
        {loading && cardTiers.length === 0 ? (
          <div className="rpc-mk-state">Loading…</div>
        ) : (
          cardTiers.map((t) => {
            const h = built.headline[t]
            const up = (h.change30d ?? 0) >= 0
            return (
              <div key={t} className="rpc-mk-card" style={{ borderTopColor: TIER_HEX[t] }}>
                <div className="rpc-mk-card-tier" style={{ color: TIER_HEX[t] }}>
                  {t}
                </div>
                <div className="rpc-mk-card-index">{h.latestIndex != null ? Math.round(h.latestIndex) : "—"}</div>
                <div className="rpc-mk-card-sub">
                  median {fmtUsd(h.latestMedian)}
                </div>
                <div className={`rpc-mk-card-chg ${up ? "rpc-mk-up" : "rpc-mk-down"}`}>
                  {fmtPctChange(h.change30d)} <span className="rpc-mk-chg-cap">30d</span>
                </div>
              </div>
            )
          })
        )}
      </section>

      {/* ── Index chart ───────────────────────────────────────────────── */}
      <section className="rpc-mk-chart-wrap" aria-label="Normalized tier index">
        <div className="rpc-mk-chart-head">
          <h2 className="rpc-mk-h2">Normalized index — base 100</h2>
          <div className="rpc-mk-legend" role="group" aria-label="Toggle tiers">
            {PLOT_TIERS.map((t) => (
              <button
                key={t}
                type="button"
                className={`rpc-mk-legend-btn ${hidden.has(t) ? "rpc-mk-legend-off" : ""}`}
                onClick={() => toggleTier(t)}
                aria-pressed={!hidden.has(t)}
              >
                <span className="rpc-mk-legend-dot" style={{ background: TIER_HEX[t] }} />
                {t}
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <div className="rpc-mk-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-mk-state">Loading…</div>
        ) : built.dates.length === 0 ? (
          <div className="rpc-mk-state">No market data in range.</div>
        ) : (
          <IndexChart built={built} hidden={hidden} />
        )}
      </section>

      {/* ── Volume bars ───────────────────────────────────────────────── */}
      <section className="rpc-mk-chart-wrap" aria-label="Daily volume">
        <div className="rpc-mk-chart-head">
          <h2 className="rpc-mk-h2">Daily marketplace volume (all tiers)</h2>
        </div>
        {loading || built.volume.length === 0 ? (
          <div className="rpc-mk-state">{loading ? "Loading…" : "No volume in range."}</div>
        ) : (
          <VolumeBars volume={built.volume} />
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-mk-footer">
        <div className="rpc-mk-method">
          <h3 className="rpc-mk-h3">Methodology</h3>
          <p>
            Each tier&apos;s <strong>index</strong> = that day&apos;s median sale
            price ÷ the median on the first day of the window × 100. Indexing
            removes the absolute-price gap between tiers so a Common and a
            Legendary can share one chart and you read <em>momentum</em>, not
            dollars.
          </p>
          <p>
            Built from <strong>real secondary-market sales only</strong>{" "}
            (price &gt; $0), rolled up daily. Thin tiers (Ultimate rarely
            trades) appear as sparse points — we never zero-fill a day with no
            sales, so the line simply connects the days that traded.
          </p>
          <p>
            <strong>Why no single &ldquo;Top Shot price&rdquo;:</strong> the
            all-market median is sub-$1 because commons swamp the count. Quoting
            it would be as dishonest as a face-value 200× pack EV. Tiers are the
            honest unit.
          </p>
        </div>

        <div className="rpc-mk-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-mk-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-mk-back">
            More public insights →
          </Link>
        </div>
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--rpc-black)",
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "32px 20px 80px",
  },
}

const CSS = `
.rpc-mk-hero {
  max-width: 1180px;
  margin: 0 auto 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-mk-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-mk-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-mk-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 820px;
  margin: 0 0 16px;
}
.rpc-mk-lede strong { color: var(--rpc-text-primary); }
.rpc-mk-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-mk-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-mk-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-mk-cards {
  max-width: 1180px;
  margin: 0 auto 26px;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.rpc-mk-card {
  border: 1px solid var(--rpc-border-subtle);
  border-top: 3px solid var(--rpc-border);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-mk-card-tier {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.rpc-mk-card-index {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 34px;
  line-height: 1;
  color: var(--rpc-text-primary);
}
.rpc-mk-card-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--rpc-text-muted);
  margin-top: 6px;
}
.rpc-mk-card-chg {
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 1px;
  margin-top: 8px;
  font-weight: 700;
}
.rpc-mk-up { color: #34D399; }
.rpc-mk-down { color: var(--rpc-red); }
.rpc-mk-chg-cap { color: var(--rpc-text-ghost); font-weight: 400; letter-spacing: 2px; }

.rpc-mk-chart-wrap {
  max-width: 1180px;
  margin: 0 auto 22px;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 2px;
  padding: 18px 18px 8px;
}
.rpc-mk-chart-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.rpc-mk-h2 {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin: 0;
}
.rpc-mk-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rpc-mk-legend-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  padding: 5px 10px;
  border: 1px solid var(--rpc-border);
  background: transparent;
  color: var(--rpc-text-secondary);
  cursor: pointer;
  border-radius: 2px;
  transition: opacity 120ms, border-color 120ms;
}
.rpc-mk-legend-btn:hover { border-color: var(--rpc-border-hover); }
.rpc-mk-legend-off { opacity: 0.4; }
.rpc-mk-legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

.rpc-mk-state {
  padding: 40px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}

.rpc-mk-footer {
  max-width: 1180px;
  margin: 14px auto 0;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-mk-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-mk-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-mk-method strong { color: var(--rpc-text-primary); }
.rpc-mk-method em { color: var(--rpc-text-primary); font-style: italic; }

.rpc-mk-share {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}
.rpc-mk-share-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--rpc-red);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  padding: 13px 18px;
  border-radius: 2px;
  text-decoration: none;
  transition: background 120ms;
}
.rpc-mk-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-mk-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-mk-back:hover { color: var(--rpc-red); }

@media (max-width: 880px) {
  .rpc-mk-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-mk-footer { grid-template-columns: 1fr; }
}
`
