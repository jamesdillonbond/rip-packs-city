"use client"

// app/insights/first-mint/page.tsx
//
// Public Top Shot First-Mint Trophy Tracker. No auth. Per the 2026-05-29
// launch plan's week-4 candidate + viral tweet template:
// "The 'first mint' trophy thesis is real and quantifiable. On TS Common
// moments, serial #1 typically sells for 14-36× the average serial price.
// Outliers go up to 194× (now 248× with newer data)."
//
// Data: GET /api/public/insights/first-mint → reads
// topshot_first_mint_trophy_stats + topshot_first_mint_trophies views,
// shipped 2026-05-30 via audit_20260530_topshot_first_mint_trophy_views_for_surface_d.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Stats = {
  trophies_90d: number | null
  mult_5x_plus: number | null
  mult_10x_plus: number | null
  mult_50x_plus: number | null
  mult_100x_plus: number | null
  avg_multiplier: number | null
  median_multiplier: number | null
  max_multiplier: number | null
  top_mint_one_price_usd: number | null
} | null

type Trophy = {
  edition_id: string
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  mint_one_sold_at: string | null
  mint_one_price_usd: number | null
  avg_other_serial_price_usd: number | null
  other_serial_sample_n: number | null
  multiplier: number | null
}

type ApiResponse = { meta: { fetched_at: string }; stats: Stats; trophies: Trophy[] }

type MultBucket = "ALL" | "5X" | "10X" | "50X" | "100X"
type TierFilter = "ALL" | "COMMON" | "RARE" | "LEGENDARY" | "FANDOM" | "ULTIMATE"

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
function fmtMult(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}×`
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function tierColor(tier: string | null): string {
  switch (tier) {
    case "LEGENDARY":
      return "var(--tier-legendary)"
    case "ULTIMATE":
      return "var(--tier-ultimate)"
    case "RARE":
      return "var(--tier-rare)"
    case "FANDOM":
      return "var(--tier-fandom)"
    case "COMMON":
      return "var(--tier-common)"
    default:
      return "var(--rpc-text-muted)"
  }
}

export default function FirstMintPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bucket, setBucket] = useState<MultBucket>("ALL")
  const [tier, setTier] = useState<TierFilter>("ALL")

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ limit: "100" })
        if (bucket === "5X") params.set("min_multiplier", "5")
        if (bucket === "10X") params.set("min_multiplier", "10")
        if (bucket === "50X") params.set("min_multiplier", "50")
        if (bucket === "100X") params.set("min_multiplier", "100")
        if (tier !== "ALL") params.set("tier", tier)
        const r = await fetch(`/api/public/insights/first-mint?${params.toString()}`, {
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
  }, [bucket, tier])

  const tweetIntent = useMemo(() => {
    const text = `The "first mint" trophy thesis is real and quantifiable.\n\nOn TS, serial #1 typically sells for 8-15× the average serial price. Outliers go up to 248×.\n\nLive tracker:`
    const url = `${SITE_URL}/insights/first-mint`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  const trophies = data?.trophies ?? []
  const stats = data?.stats

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-fm-hero">
        <div className="rpc-fm-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-fm-h1">First-Mint Trophies</h1>
        <p className="rpc-fm-lede">
          Every Top Shot serial #1 sale of the last 90 days, paired with the
          average serial price for the same edition. Trophies aren&apos;t a
          vibe — they&apos;re math.
        </p>
      </section>

      <section className="rpc-fm-kpi-row" aria-label="Cohort summary">
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">Trophies 90d</div>
          <div className="rpc-fm-kpi-value">{fmtInt(stats?.trophies_90d)}</div>
        </div>
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">Avg multiplier</div>
          <div className="rpc-fm-kpi-value">{fmtMult(stats?.avg_multiplier)}</div>
        </div>
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">Median</div>
          <div className="rpc-fm-kpi-value">{fmtMult(stats?.median_multiplier)}</div>
        </div>
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">Max multiplier</div>
          <div className="rpc-fm-kpi-value">{fmtMult(stats?.max_multiplier)}</div>
        </div>
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">≥ 10× sales</div>
          <div className="rpc-fm-kpi-value">{fmtInt(stats?.mult_10x_plus)}</div>
        </div>
        <div className="rpc-fm-kpi">
          <div className="rpc-fm-kpi-label">Top $ sale</div>
          <div className="rpc-fm-kpi-value">{fmtUsd(stats?.top_mint_one_price_usd)}</div>
        </div>
      </section>

      <section className="rpc-fm-controls" aria-label="Filters">
        <div className="rpc-fm-pill-group">
          <span className="rpc-fm-pill-label">MIN MULTIPLIER</span>
          {(["ALL", "5X", "10X", "50X", "100X"] as MultBucket[]).map((b) => (
            <button
              key={b}
              className={`rpc-fm-pill ${bucket === b ? "rpc-fm-pill-active" : ""}`}
              onClick={() => setBucket(b)}
            >
              {b === "ALL" ? "All" : `≥ ${b}`}
            </button>
          ))}
        </div>

        <div className="rpc-fm-pill-group">
          <span className="rpc-fm-pill-label">TIER</span>
          {(["ALL", "COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"] as TierFilter[]).map((t) => (
            <button
              key={t}
              className={`rpc-fm-pill ${tier === t ? "rpc-fm-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section className="rpc-fm-table-wrap" aria-label="Trophy list">
        {error ? (
          <div className="rpc-fm-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-fm-state">Loading…</div>
        ) : trophies.length === 0 ? (
          <div className="rpc-fm-state">No trophies match.</div>
        ) : (
          <table className="rpc-fm-table">
            <thead>
              <tr>
                <th>Edition</th>
                <th className="rpc-fm-th-num">Tier</th>
                <th className="rpc-fm-th-num">Circ</th>
                <th className="rpc-fm-th-num">#1 sold</th>
                <th className="rpc-fm-th-num">#1 price</th>
                <th className="rpc-fm-th-num">Avg other</th>
                <th className="rpc-fm-th-num rpc-fm-th-emph">Multiplier</th>
              </tr>
            </thead>
            <tbody>
              {trophies.map((r) => (
                <tr key={`${r.edition_id}-${r.mint_one_sold_at}`}>
                  <td className="rpc-fm-td-edition">
                    <div className="rpc-fm-edition-cell">
                      <Link href={`/moment/${r.edition_id}`} className="rpc-fm-edition-link">
                        <div className="rpc-fm-edition-name">{r.player_name ?? "—"}</div>
                        <div className="rpc-fm-edition-set">{r.set_name ?? "—"}</div>
                      </Link>
                      {r.player_name ? (
                        <Link
                          href={`/insights/squeeze?player=${encodeURIComponent(r.player_name)}`}
                          className="rpc-fm-squeeze-link"
                          title={`See ${r.player_name}'s editions on the squeeze board`}
                        >
                          squeeze →
                        </Link>
                      ) : null}
                    </div>
                  </td>
                  <td className="rpc-fm-td-num">
                    <span className="rpc-fm-tier" style={{ color: tierColor(r.tier) }}>
                      {r.tier ?? "—"}
                    </span>
                  </td>
                  <td className="rpc-fm-td-num">{fmtInt(r.circulation_count)}</td>
                  <td className="rpc-fm-td-num">{fmtDate(r.mint_one_sold_at)}</td>
                  <td className="rpc-fm-td-num">{fmtUsd(r.mint_one_price_usd)}</td>
                  <td className="rpc-fm-td-num">{fmtUsd(r.avg_other_serial_price_usd)}</td>
                  <td className="rpc-fm-td-num rpc-fm-td-emph">{fmtMult(r.multiplier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-fm-footer">
        <div className="rpc-fm-method">
          <h3 className="rpc-fm-h3">Methodology</h3>
          <p>
            <strong>Trophy</strong> = a serial #1 sale of any Top Shot edition
            in the last 90 days, with a USD price &gt; $0.
          </p>
          <p>
            <strong>Avg other serial price</strong> = average of all non-#1
            serial sales of the same edition in the last 180 days (minimum 3
            comparison sales). Editions without 3 comparison sales are
            excluded — we don&apos;t want a single thin-volume sale forming
            the basis for a multiplier headline.
          </p>
          <p>
            <strong>Multiplier</strong> = #1 sale price ÷ avg other serial
            price. A 100× multiplier means the trophy sold for 100 times what
            a typical serial of the same edition sells for.
          </p>
        </div>
        <div className="rpc-fm-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-fm-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-fm-back">
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
.rpc-fm-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-fm-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-fm-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-fm-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-fm-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-fm-lede strong { color: var(--rpc-text-primary); }

.rpc-fm-kpi-row { max-width: 1180px; margin: 0 auto 18px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.rpc-fm-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-fm-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-fm-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 26px; color: var(--rpc-red); }

.rpc-fm-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-fm-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-fm-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-fm-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-fm-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-fm-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-fm-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-fm-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-fm-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-fm-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-fm-th-num { text-align: right; }
.rpc-fm-th-emph { color: var(--rpc-red); }
.rpc-fm-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-fm-td-edition { min-width: 240px; }
.rpc-fm-edition-cell { display: flex; align-items: center; gap: 14px; }
.rpc-fm-edition-link { text-decoration: none; color: inherit; display: block; flex: 1; min-width: 0; }
.rpc-fm-edition-link:hover .rpc-fm-edition-name { color: var(--rpc-red); }
.rpc-fm-edition-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); transition: color 100ms; }
.rpc-fm-squeeze-link { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-decoration: none; padding: 4px 8px; border: 1px solid var(--rpc-border); border-radius: 2px; white-space: nowrap; opacity: 0.65; transition: color 100ms, border-color 100ms, opacity 100ms; }
.rpc-fm-squeeze-link:hover { color: var(--rpc-red); border-color: var(--rpc-red); opacity: 1; }
.rpc-fm-edition-set { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-fm-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-fm-td-emph { color: var(--rpc-red); font-weight: 700; font-size: 15px; }
.rpc-fm-tier { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }

.rpc-fm-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-fm-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-fm-method strong { color: var(--rpc-text-primary); }
.rpc-fm-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-fm-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-fm-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-fm-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-fm-back:hover { color: var(--rpc-red); }

@media (max-width: 880px) {
  .rpc-fm-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-fm-footer { grid-template-columns: 1fr; }
}
`
