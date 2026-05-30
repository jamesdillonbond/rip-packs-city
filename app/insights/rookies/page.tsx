"use client"

// app/insights/rookies/page.tsx
//
// Public 2025 NBA Rookie Class Index. No auth. Per the 2026-05-29 launch
// plan: "The 2025 NBA rookie class on Top Shot, ranked by 30d GMV +
// lock-rate. Dylan Harper ($21k GMV), Kon Knueppel (54% locked, $392 avg),
// Harper Rookie Revelation #1 → $3,512."
//
// Data source: GET /api/public/insights/rookies → reads
// topshot_2025_rookie_cohort_stats + topshot_2025_rookie_index views,
// shipped 2026-05-30 via audit_20260530_topshot_rookie_index_views_for_surface_c.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type CohortStats = {
  rookie_count: number | null
  total_sales_30d: number | null
  total_gmv_30d: number | null
  avg_price_active: number | null
  rookies_with_activity_30d: number | null
  rookies_with_mint_one_sale: number | null
  top_mint_one_sale: number | null
} | null

type Row = {
  player_name: string
  edition_count: number | null
  sales_30d: number | null
  gmv_30d: number | null
  avg_price_30d: number | null
  max_sale_30d: number | null
  total_locked: number | null
  total_burned: number | null
  total_circ: number | null
  cohort_squeeze_pct: number | null
  avg_lock_rate_pct: number | null
  mint_one_eds_with_history: number | null
  max_mint_one_sale_usd: number | null
}

type ApiResponse = {
  meta: { fetched_at: string }
  cohort_stats: CohortStats
  rows: Row[]
}

type SortKey = "gmv" | "lock" | "avg_price" | "sales" | "mint_one"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number(n) === 0) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}

export default function RookiesPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>("gmv")

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(`/api/public/insights/rookies?sort=${sort}&limit=100`, {
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
  }, [sort])

  const tweetIntent = useMemo(() => {
    const text = `The 2025 NBA rookie class on Top Shot, ranked by 30d GMV + lock-rate.\n\nTop mover, mint-#1 trophies, locked-and-pricey leader — all live:`
    const url = `${SITE_URL}/insights/rookies`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  const rows = data?.rows ?? []
  const cohort = data?.cohort_stats

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-rk-hero">
        <div className="rpc-rk-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-rk-h1">2025 NBA Rookie Index</h1>
        <p className="rpc-rk-lede">
          The 2025 NBA rookie class on Top Shot as a cohort. 30-day GMV,
          lock-rate, average serial price, mint-#1 trophy presence. Refreshes
          daily.
        </p>
      </section>

      <section className="rpc-rk-kpi-row" aria-label="Cohort summary">
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Rookies tracked</div>
          <div className="rpc-rk-kpi-value">{fmtInt(cohort?.rookie_count)}</div>
        </div>
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Total GMV 30d</div>
          <div className="rpc-rk-kpi-value">{fmtUsd(cohort?.total_gmv_30d)}</div>
        </div>
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Sales 30d</div>
          <div className="rpc-rk-kpi-value">{fmtInt(cohort?.total_sales_30d)}</div>
        </div>
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Avg active price</div>
          <div className="rpc-rk-kpi-value">{fmtUsd(cohort?.avg_price_active)}</div>
        </div>
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Mint #1 trophies</div>
          <div className="rpc-rk-kpi-value">{fmtInt(cohort?.rookies_with_mint_one_sale)}</div>
        </div>
        <div className="rpc-rk-kpi">
          <div className="rpc-rk-kpi-label">Top mint-1 sale</div>
          <div className="rpc-rk-kpi-value">{fmtUsd(cohort?.top_mint_one_sale)}</div>
        </div>
      </section>

      <section className="rpc-rk-controls" aria-label="Sort">
        <span className="rpc-rk-pill-label">SORT</span>
        {[
          { v: "gmv", l: "GMV 30d" },
          { v: "lock", l: "Lock rate" },
          { v: "avg_price", l: "Avg price" },
          { v: "sales", l: "Sales 30d" },
          { v: "mint_one", l: "Top mint-1" },
        ].map((opt) => (
          <button
            key={opt.v}
            className={`rpc-rk-pill ${sort === opt.v ? "rpc-rk-pill-active" : ""}`}
            onClick={() => setSort(opt.v as SortKey)}
          >
            {opt.l}
          </button>
        ))}
      </section>

      <section className="rpc-rk-table-wrap" aria-label="Rookie index">
        {error ? (
          <div className="rpc-rk-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-rk-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-rk-state">No rookies found.</div>
        ) : (
          <table className="rpc-rk-table">
            <thead>
              <tr>
                <th>Player</th>
                <th className="rpc-rk-th-num">Eds</th>
                <th className="rpc-rk-th-num">Sales 30d</th>
                <th className="rpc-rk-th-num">GMV 30d</th>
                <th className="rpc-rk-th-num">Avg price</th>
                <th className="rpc-rk-th-num">Max sale 30d</th>
                <th className="rpc-rk-th-num">Lock %</th>
                <th className="rpc-rk-th-num">Squeeze %</th>
                <th className="rpc-rk-th-num">Top mint-1</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.player_name}>
                  <td>
                    <div className="rpc-rk-player">{r.player_name}</div>
                  </td>
                  <td className="rpc-rk-td-num">{fmtInt(r.edition_count)}</td>
                  <td className="rpc-rk-td-num">{fmtInt(r.sales_30d)}</td>
                  <td className="rpc-rk-td-num rpc-rk-td-emph">{fmtUsd(r.gmv_30d)}</td>
                  <td className="rpc-rk-td-num">{fmtUsd(r.avg_price_30d)}</td>
                  <td className="rpc-rk-td-num">{fmtUsd(r.max_sale_30d)}</td>
                  <td className="rpc-rk-td-num">{fmtPct(r.avg_lock_rate_pct)}</td>
                  <td className="rpc-rk-td-num">{fmtPct(r.cohort_squeeze_pct)}</td>
                  <td className="rpc-rk-td-num">{fmtUsd(r.max_mint_one_sale_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-rk-footer">
        <div className="rpc-rk-method">
          <h3 className="rpc-rk-h3">Methodology</h3>
          <p>
            <strong>Cohort</strong> = any player with at least one Top Shot
            edition in a Series 8 rookie-themed set (Rookie Debut COMMON,
            Origins RARE, Rookie Revelation LEGENDARY, 2025 Rookie Ultimates
            ULTIMATE). Currently {fmtInt(cohort?.rookie_count)} players.
          </p>
          <p>
            <strong>GMV 30d</strong> sums every USD-priced sale of those
            editions in the last 30 days. <strong>Avg price</strong> averages
            those sale prices.
          </p>
          <p>
            <strong>Lock %</strong> averages the per-edition lock rate from
            badge_editions (locked / circulation-after-burn).{" "}
            <strong>Squeeze %</strong> = (locked + burned) / circulation
            summed across the player&apos;s editions. <strong>Top mint-1</strong>{" "}
            = highest USD sale of a serial #1 across the player&apos;s editions.
          </p>
        </div>
        <div className="rpc-rk-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-rk-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-rk-back">
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
.rpc-rk-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-rk-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-rk-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-rk-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-rk-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-rk-lede strong { color: var(--rpc-text-primary); }

.rpc-rk-kpi-row { max-width: 1180px; margin: 0 auto 24px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.rpc-rk-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-rk-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-rk-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 26px; color: var(--rpc-red); }

.rpc-rk-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-rk-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-rk-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-rk-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-rk-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-rk-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-rk-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-rk-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-rk-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-rk-th-num { text-align: right; }
.rpc-rk-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-rk-player { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); }
.rpc-rk-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-rk-td-emph { color: var(--rpc-red); font-weight: 700; }

.rpc-rk-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-rk-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-rk-method strong { color: var(--rpc-text-primary); }
.rpc-rk-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-rk-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-rk-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-rk-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-rk-back:hover { color: var(--rpc-red); }

@media (max-width: 880px) {
  .rpc-rk-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-rk-footer { grid-template-columns: 1fr; }
}
`
