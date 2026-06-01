"use client"

// app/insights/pack-reality/page.tsx
//
// Public Top Shot pack-reality board. No auth. Per the 2026-05-29 launch
// plan: "I ran the math on every Top Shot pack ripped in the last 60 days.
// 128,220 rips. Average pull value $5.86. Median $0. Half of all packs
// delivered nothing. 1% delivered over $100."
//
// Data source: GET /api/public/insights/pack-reality → reads three public
// views (topshot_pack_reality_stats, _dist, _top_ev) shipped 2026-05-30 via
// audit_20260530_topshot_pack_reality_views_for_surface_b.
//
// Anatomy:
//   1. Hero band (display H1 + lede with the headline stat)
//   2. KPI strip (rips, median, mean, % delivering $0, % over $100)
//   3. Pull-value distribution bar chart (HTML/CSS, no chart lib)
//   4. Top-EV pack ranker with high-variance caveat flag
//   5. Methodology + share button

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Stats = {
  rips_60d: number | null
  zero_value_rips: number | null
  zero_value_pct: number | null
  mean_pull_value_usd: number | null
  median_pull_value_usd: number | null
  p90_pull_value_usd: number | null
  p99_pull_value_usd: number | null
  rips_over_100: number | null
  rips_over_100_pct: number | null
  rips_over_1000: number | null
} | null

type DistRow = { bucket: string; rips: number | null; pct: number | null }

type TopEvRow = {
  pack_listing_id: string
  dist_id: string | null
  pack_name: string | null
  pack_price: number | null
  gross_ev: number | null
  pack_ev: number | null
  value_ratio: number | null
  fmv_coverage_pct: number | null
  edition_count: number | null
  total_unopened: number | null
  depletion_pct: number | null
  snapshotted_at: string | null
  price_source: string | null
  high_variance: boolean | null
  is_reward_pack: boolean | null
  retail_price_usd_normalized: number | null
}

type ApiResponse = {
  meta: { fetched_at: string }
  stats: Stats
  distribution: DistRow[]
  top_ev: TopEvRow[]
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}

export default function PackRealityPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch("/api/public/insights/pack-reality?limit=10", {
          signal: ctrl.signal,
          cache: "no-store",
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as ApiResponse
        setData(j)
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

  const maxPct = useMemo(() => {
    const rows = data?.distribution ?? []
    return Math.max(1, ...rows.map((r) => Number(r.pct ?? 0)))
  }, [data])

  const tweetIntent = useMemo(() => {
    const text = `I ran the math on every Top Shot pack ripped in the last 60 days.\n\n128,220 rips. Median pull value $0. Half deliver nothing.\n\nHonest pack ranker:`
    const url = `${SITE_URL}/insights/pack-reality`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-pr-hero">
        <div className="rpc-pr-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-pr-h1">Pack Reality</h1>
        <p className="rpc-pr-lede">
          We audited every Top Shot pack ripped in the last 60 days.{" "}
          <strong>{fmtInt(data?.stats?.rips_60d)} rips.</strong> Median pull
          value <strong>$0.00</strong>. Mean{" "}
          <strong>{fmtUsd(data?.stats?.mean_pull_value_usd)}</strong>.{" "}
          {data?.stats?.zero_value_pct != null ? (
            <>
              <strong>{Number(data.stats.zero_value_pct).toFixed(0)}% delivered nothing.</strong>{" "}
            </>
          ) : null}
          {data?.stats?.rips_over_100_pct != null ? (
            <>{Number(data.stats.rips_over_100_pct).toFixed(2)}% delivered over $100.</>
          ) : null}
        </p>
      </section>

      <section className="rpc-pr-kpi-row" aria-label="Summary">
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Rips (60d)</div>
          <div className="rpc-pr-kpi-value">{fmtInt(data?.stats?.rips_60d)}</div>
        </div>
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Delivered $0</div>
          <div className="rpc-pr-kpi-value">{fmtPct(data?.stats?.zero_value_pct)}</div>
        </div>
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Mean value</div>
          <div className="rpc-pr-kpi-value">{fmtUsd(data?.stats?.mean_pull_value_usd)}</div>
        </div>
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Median</div>
          <div className="rpc-pr-kpi-value">{fmtUsd(data?.stats?.median_pull_value_usd)}</div>
        </div>
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Over $100</div>
          <div className="rpc-pr-kpi-value">{fmtPct(data?.stats?.rips_over_100_pct)}</div>
        </div>
        <div className="rpc-pr-kpi">
          <div className="rpc-pr-kpi-label">Over $1k</div>
          <div className="rpc-pr-kpi-value">{fmtInt(data?.stats?.rips_over_1000)}</div>
        </div>
      </section>

      <section className="rpc-pr-dist" aria-label="Pull value distribution">
        <h2 className="rpc-pr-h2">Pull-value distribution</h2>
        {error ? (
          <div className="rpc-pr-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-pr-state">Loading…</div>
        ) : (
          <div className="rpc-pr-bars">
            {(data?.distribution ?? []).map((row) => (
              <div key={row.bucket} className="rpc-pr-bar-row">
                <div className="rpc-pr-bar-label">{row.bucket}</div>
                <div className="rpc-pr-bar-track">
                  <div
                    className="rpc-pr-bar-fill"
                    style={{ width: `${(Number(row.pct ?? 0) / maxPct) * 100}%` }}
                  />
                </div>
                <div className="rpc-pr-bar-meta">
                  <span className="rpc-pr-bar-pct">{fmtPct(row.pct)}</span>
                  <span className="rpc-pr-bar-count">{fmtInt(row.rips)} rips</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rpc-pr-ranker" aria-label="Top +EV packs">
        <h2 className="rpc-pr-h2">Honest +EV ranker</h2>
        <p className="rpc-pr-sub">
          Top {data?.top_ev?.length ?? 0} positive-EV TS packs currently listed.{" "}
          <strong>High-variance</strong> = FMV coverage below 80% — the headline
          EV rests on a small fraction of priced editions, so treat the number
          as a lower bound on confidence, not on dollars.
        </p>
        {(data?.top_ev ?? []).length === 0 ? (
          <div className="rpc-pr-state">{loading ? "Loading…" : "No +EV packs right now."}</div>
        ) : (
          <div className="rpc-scroll-x">
          <table className="rpc-pr-table">
            <thead>
              <tr>
                <th>Pack</th>
                <th className="rpc-pr-th-num">Price</th>
                <th className="rpc-pr-th-num">Pack EV</th>
                <th className="rpc-pr-th-num">Value ratio</th>
                <th className="rpc-pr-th-num">FMV cov.</th>
                <th className="rpc-pr-th-num">Sealed</th>
                <th className="rpc-pr-th-num">Flag</th>
              </tr>
            </thead>
            <tbody>
              {(data?.top_ev ?? []).map((row) => (
                <tr key={row.pack_listing_id}>
                  <td className="rpc-pr-td-pack">
                    {row.dist_id ? (
                      <Link
                        href={`/nba-top-shot/pack/dist/${encodeURIComponent(row.dist_id)}`}
                        className="rpc-pr-pack-link"
                        title={`Open ${row.pack_name ?? "this pack"} distribution page`}
                      >
                        <div className="rpc-pr-pack-name">{row.pack_name ?? "—"}</div>
                        <div className="rpc-pr-pack-sub">
                          {row.price_source ?? "—"} · {row.edition_count ?? "—"} eds
                          <span className="rpc-pr-pack-drill">open pack →</span>
                        </div>
                      </Link>
                    ) : (
                      <>
                        <div className="rpc-pr-pack-name">{row.pack_name ?? "—"}</div>
                        <div className="rpc-pr-pack-sub">
                          {row.price_source ?? "—"} · {row.edition_count ?? "—"} eds
                        </div>
                      </>
                    )}
                  </td>
                  <td className="rpc-pr-td-num">{fmtUsd(row.pack_price)}</td>
                  <td className="rpc-pr-td-num rpc-pr-td-emph">{fmtUsd(row.pack_ev)}</td>
                  <td className="rpc-pr-td-num">
                    {row.value_ratio != null ? `${Number(row.value_ratio).toFixed(1)}×` : "—"}
                  </td>
                  <td className="rpc-pr-td-num">{fmtPct(row.fmv_coverage_pct)}</td>
                  <td className="rpc-pr-td-num">{fmtInt(row.total_unopened)}</td>
                  <td className="rpc-pr-td-num">
                    {row.high_variance ? (
                      <span className="rpc-pr-variance-chip">high variance</span>
                    ) : (
                      <span className="rpc-pr-clean-chip">clean</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="rpc-pr-footer">
        <div className="rpc-pr-method">
          <h3 className="rpc-pr-h3">Methodology</h3>
          <p>
            <strong>Rip = a pack opened in the last 60 days</strong>, joined to
            the FMV of the moments it released, summed per pack. Pull value
            uses the RPC 1.7.0 sales-WAP model. Editions without FMV are
            counted as $0, so all values are honest lower bounds.
          </p>
          <p>
            <strong>Pack EV</strong> uses the existing pack-EV pipeline (gross
            EV − pack price). The high-variance flag fires when{" "}
            <strong>FMV coverage &lt; 80%</strong>; in those cases a single
            stale-priced moment can dominate the EV calc.
          </p>
        </div>
        <div className="rpc-pr-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-pr-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-pr-back">
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
.rpc-pr-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pr-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-pr-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-pr-h2 { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0 0 16px; }
.rpc-pr-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-pr-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-pr-lede strong { color: var(--rpc-text-primary); }

.rpc-pr-kpi-row { max-width: 1180px; margin: 0 auto 28px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.rpc-pr-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-pr-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-pr-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 28px; color: var(--rpc-red); }

.rpc-pr-dist { max-width: 1180px; margin: 0 auto 36px; }
.rpc-pr-bars { display: flex; flex-direction: column; gap: 10px; }
.rpc-pr-bar-row { display: grid; grid-template-columns: 90px 1fr 220px; gap: 14px; align-items: center; }
.rpc-pr-bar-label { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; color: var(--rpc-text-secondary); }
.rpc-pr-bar-track { background: var(--rpc-surface-raised); border: 1px solid var(--rpc-border-subtle); height: 28px; border-radius: 2px; overflow: hidden; }
.rpc-pr-bar-fill { height: 100%; background: linear-gradient(90deg, var(--rpc-red), var(--rpc-red-hover)); }
.rpc-pr-bar-meta { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-secondary); display: flex; justify-content: space-between; }
.rpc-pr-bar-pct { color: var(--rpc-red); font-weight: 700; }
.rpc-pr-bar-count { color: var(--rpc-text-muted); }

.rpc-pr-ranker { max-width: 1180px; margin: 0 auto 36px; }
.rpc-pr-sub { font-size: 14px; line-height: 1.6; color: var(--rpc-text-secondary); margin: 0 0 18px; max-width: 820px; }
.rpc-pr-sub strong { color: var(--rpc-text-primary); }
.rpc-pr-table { width: 100%; border-collapse: collapse; font-size: 14px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-pr-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-pr-th-num { text-align: right; }
.rpc-pr-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-pr-td-pack { min-width: 260px; }
.rpc-pr-pack-link { text-decoration: none; color: inherit; display: block; }
.rpc-pr-pack-link:hover .rpc-pr-pack-name { color: var(--rpc-red); }
.rpc-pr-pack-link:hover .rpc-pr-pack-drill { color: var(--rpc-red); opacity: 1; }
.rpc-pr-pack-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); transition: color 100ms; }
.rpc-pr-pack-drill { margin-left: 10px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); opacity: 0.6; transition: color 100ms, opacity 100ms; }
.rpc-pr-pack-sub { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-pr-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-pr-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-pr-variance-chip { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; padding: 4px 8px; background: rgba(245,158,11,0.10); color: var(--rpc-warning); border: 1px solid rgba(245,158,11,0.30); border-radius: 2px; }
.rpc-pr-clean-chip { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; padding: 4px 8px; background: rgba(52,211,153,0.10); color: var(--rpc-success); border: 1px solid rgba(52,211,153,0.30); border-radius: 2px; }

.rpc-pr-state { padding: 28px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }

.rpc-pr-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-pr-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-pr-method strong { color: var(--rpc-text-primary); }
.rpc-pr-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-pr-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-pr-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-pr-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-pr-back:hover { color: var(--rpc-red); }

@media (max-width: 880px) {
  .rpc-pr-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-pr-footer { grid-template-columns: 1fr; }
  .rpc-pr-bar-row { grid-template-columns: 70px 1fr 140px; }
}
`
