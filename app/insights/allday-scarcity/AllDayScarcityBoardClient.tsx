"use client"

// app/insights/allday-scarcity/AllDayScarcityBoardClient.tsx
//
// Client interactivity layer for the public NFL All Day Scarcity Board. The
// server component (page.tsx) fetches the default-view rows (scarcity desc, the
// statistically-meaningful cohort) from allday_scarcity_board server-side and
// passes them in as `initialRows`, so the ranked table + per-row
// /nfl-all-day/edition/<external_id> drill-down links render in the raw server
// HTML (crawlable) instead of only after JS. This component layers on tier /
// sort filters as progressive enhancement and only refetches when those change.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  external_id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  team_name: string | null
  series: number | null
  mint_count: number | null
  family_avg_mint: number | null
  family_size: number | null
  scarcity_vs_family_pct: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
  thumbnail_url: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number }
  rows: Row[]
}

type SortKey = "scarcity" | "mint" | "fmv"
type TierFilter = "ALL" | "LEGENDARY" | "RARE" | "UNCOMMON" | "COMMON" | "ULTIMATE"

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

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function AllDayScarcityBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  // Server already gave us the default view — not "loading" on first paint.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [sort, setSort] = useState<SortKey>("scarcity")
  const [tier, setTier] = useState<TierFilter>("ALL")

  // Skip the very first fetch when params match the server-fetched default.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (sort === "scarcity" && tier === "ALL") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ sort, limit: "100" })
        if (tier !== "ALL") params.set("tier", tier)
        const r = await fetch(`/api/public/insights/allday-scarcity?${params.toString()}`, {
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
  }, [sort, tier])

  const tweetIntent = useMemo(() => {
    const text = `NFL All Day doesn't show you the supply story. We do.\n\nEditions ranked by how rare they actually are vs their set + tier family:`
    const url = `${SITE_URL}/insights/allday-scarcity`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-ads-hero">
        <div className="rpc-ads-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-ads-h1">NFL All Day Scarcity Board</h1>
        <p className="rpc-ads-lede">
          NFL All Day doesn&apos;t have Top Shot&apos;s lock + burn mechanic or
          Pinnacle&apos;s variant system. Its scarcity comes from{" "}
          <strong>low mint counts</strong> within a set + tier family —
          parallels, #1 mints, and premium-tier moments. This board ranks
          editions by how far below their family&apos;s average mint they sit.
        </p>
        <div className="rpc-ads-meta-row">
          <span className="rpc-ads-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-ads-meta-sep">·</span>
          <span className="rpc-ads-meta">Refreshes hourly</span>
          <span className="rpc-ads-meta-sep">·</span>
          <span className="rpc-ads-meta">No signup</span>
        </div>
      </section>

      <section className="rpc-ads-callout" aria-label="Cohort note">
        <div className="rpc-ads-callout-line">
          <strong>Honest cohort:</strong> the default view shows only editions in
          a <code>set + tier</code> family of at least 3 moments — so the family
          average means something — and only the ones actually scarcer than their
          family. Each row links to its edition page.
        </div>
      </section>

      <section className="rpc-ads-controls" aria-label="Filters">
        <div className="rpc-ads-pill-group">
          <span className="rpc-ads-pill-label">TIER</span>
          {(["ALL", "LEGENDARY", "RARE", "UNCOMMON", "COMMON", "ULTIMATE"] as TierFilter[]).map((t) => (
            <button
              key={t}
              className={`rpc-ads-pill ${tier === t ? "rpc-ads-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="rpc-ads-sort">
          <span className="rpc-ads-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-ads-select"
          >
            <option value="scarcity">Scarcity vs family (desc)</option>
            <option value="mint">Mint count (asc)</option>
            <option value="fmv">FMV (desc)</option>
          </select>
        </label>
      </section>

      <section className="rpc-ads-table-wrap">
        {error ? (
          <div className="rpc-ads-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ads-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-ads-state">No editions match those filters.</div>
        ) : (
          <table className="rpc-ads-table">
            <thead>
              <tr>
                <th>Player / Set</th>
                <th className="rpc-ads-th-num">Tier</th>
                <th className="rpc-ads-th-num">Mint</th>
                <th className="rpc-ads-th-num">Fam avg</th>
                <th className="rpc-ads-th-num rpc-ads-th-emph">Scarcity</th>
                <th className="rpc-ads-th-num">FMV</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.external_id}>
                  <td className="rpc-ads-td-edition">
                    <Link
                      href={`/nfl-all-day/edition/${encodeURIComponent(r.external_id)}`}
                      className="rpc-ads-edition-link"
                      title={`Open ${r.player_name ?? "this moment"} detail`}
                    >
                      <div className="rpc-ads-edition-name">{r.player_name ?? "—"}</div>
                      <div className="rpc-ads-edition-set">{r.set_name ?? "—"}</div>
                    </Link>
                  </td>
                  <td className="rpc-ads-td-num">{r.tier ?? "—"}</td>
                  <td className="rpc-ads-td-num">{fmtInt(r.mint_count)}</td>
                  <td className="rpc-ads-td-num">
                    {r.family_avg_mint ? fmtInt(Math.round(Number(r.family_avg_mint))) : "—"}
                  </td>
                  <td className="rpc-ads-td-num rpc-ads-td-emph">{fmtPct(r.scarcity_vs_family_pct)}</td>
                  <td className="rpc-ads-td-num">{fmtUsd(r.fmv_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-ads-footer">
        <div className="rpc-ads-method">
          <h3 className="rpc-ads-h3">Methodology</h3>
          <p>
            <strong>Scarcity vs family</strong> = how much rarer this edition is
            than the average edition in its <code>set + tier</code> family.
            Positive % = rarer. A #1-of-mint Rookie Honors Legendary sits ~95%
            below the 30-edition Rookie Honors Legendary cohort&apos;s average.
          </p>
          <p>
            <strong>Family</strong> = every All Day edition sharing the same set
            and tier — the natural mint cohort. <strong>FMV</strong> = the latest
            sales-weighted value; many of the scarcest editions have never traded
            (<code>NO_DATA</code>), which is exactly what makes them scarce.
          </p>
        </div>
        <div className="rpc-ads-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ads-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-ads-back">
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
.rpc-ads-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ads-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ads-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ads-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-ads-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ads-lede strong { color: var(--rpc-text-primary); }
.rpc-ads-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ads-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ads-callout { max-width: 1180px; margin: 0 auto 18px; }
.rpc-ads-callout-line {
  padding: 12px 14px;
  background: var(--rpc-red-bg);
  border-left: 3px solid var(--rpc-red);
  border-radius: 2px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
}
.rpc-ads-callout-line strong { color: var(--rpc-text-primary); margin-right: 4px; }
.rpc-ads-callout-line code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--rpc-text-primary);
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 2px;
}

.rpc-ads-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-ads-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ads-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-ads-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-ads-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ads-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ads-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-ads-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-ads-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-ads-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ads-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-ads-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-ads-th-num { text-align: right; }
.rpc-ads-th-emph { color: var(--rpc-red); }
.rpc-ads-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-ads-td-edition { min-width: 280px; }
.rpc-ads-edition-link { text-decoration: none; color: inherit; display: block; }
.rpc-ads-edition-link:hover .rpc-ads-edition-name { color: var(--rpc-red); }
.rpc-ads-edition-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); transition: color 100ms; }
.rpc-ads-edition-set { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-ads-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-ads-td-emph { color: var(--rpc-red); font-weight: 700; }

.rpc-ads-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-ads-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-ads-method strong { color: var(--rpc-text-primary); }
.rpc-ads-method code { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-primary); }
.rpc-ads-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ads-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-ads-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ads-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ads-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) { .rpc-ads-footer { grid-template-columns: 1fr; } }
`
