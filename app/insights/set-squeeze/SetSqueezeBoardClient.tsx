"use client"

// app/insights/set-squeeze/SetSqueezeBoardClient.tsx
//
// Client interactivity layer for the public Set Squeeze Leaderboard. The
// server component (page.tsx) fetches the default-view rows (avg_squeeze desc)
// from topshot_set_squeeze_board server-side and passes them in as
// `initialRows`, so the ranked table + per-row /nba-top-shot/set/<slug>
// drill-down links render in the raw server HTML (crawlable) instead of only
// after JS. This component layers on series/tier/sort filters as progressive
// enhancement and only refetches when those change.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { slugifyName } from "@/lib/entity-labels"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  set_id: string
  set_name: string | null
  series: number | null
  set_tier: string | null
  editions_covered: number | null
  avg_squeeze_pct: number | null
  median_squeeze_pct: number | null
  max_squeeze_pct: number | null
  min_squeeze_pct: number | null
  total_circ: number | null
  total_locked: number | null
  total_burned: number | null
  total_buyable: number | null
  avg_fmv_usd: number | null
  fmv_covered_editions: number | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number }
  rows: Row[]
}

type SortKey = "squeeze" | "buyable"
type SeriesFilter = "ALL" | "5" | "6" | "7" | "8"
type TierFilter = "ALL" | "COMMON" | "RARE" | "LEGENDARY" | "FANDOM" | "ULTIMATE"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
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
const SERIES_LABEL: Record<string, string> = {
  "5": "Series 4 (2022-23)",
  "6": "Series 2023-24",
  "7": "Series 2024-25",
  "8": "Series 2025-26",
}

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function SetSqueezeBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  // Server already gave us the default view — not "loading" on first paint.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [sort, setSort] = useState<SortKey>("squeeze")
  const [series, setSeries] = useState<SeriesFilter>("ALL")
  const [tier, setTier] = useState<TierFilter>("ALL")

  // Skip the very first fetch when params match the server-fetched default.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (sort === "squeeze" && series === "ALL" && tier === "ALL") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ sort, limit: "100" })
        if (series !== "ALL") params.set("series", series)
        if (tier !== "ALL") params.set("set_tier", tier)
        const r = await fetch(`/api/public/insights/set-squeeze?${params.toString()}`, {
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
  }, [sort, series, tier])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot sets ranked by lock + burn across editions. If you're completing this set, how scarce will it actually be?`
    const url = `${SITE_URL}/insights/set-squeeze`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-ss-hero">
        <div className="rpc-ss-eyebrow">RPC Insights · Public · Drill-down</div>
        <h1 className="rpc-ss-h1">Set Squeeze Leaderboard</h1>
        <p className="rpc-ss-lede">
          Companion to the <Link href="/insights/squeeze" className="rpc-ss-inline-link">squeeze board</Link>.
          Per-edition squeeze tells you which moments are tight. This view
          rolls up to whole sets — if you&apos;re completing a set, how
          scarce is the whole journey going to be?
        </p>
        <div className="rpc-ss-meta-row">
          <span className="rpc-ss-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-ss-meta-sep">·</span>
          <span className="rpc-ss-meta">Sets with ≥5 covered editions</span>
        </div>
      </section>

      <section className="rpc-ss-controls">
        <div className="rpc-ss-pill-group">
          <span className="rpc-ss-pill-label">SERIES</span>
          {(["ALL", "8", "7", "6", "5"] as SeriesFilter[]).map((s) => (
            <button
              key={s}
              className={`rpc-ss-pill ${series === s ? "rpc-ss-pill-active" : ""}`}
              onClick={() => setSeries(s)}
              title={s !== "ALL" ? SERIES_LABEL[s] : "Any series"}
            >
              {s === "ALL" ? "Any" : `S${s}`}
            </button>
          ))}
        </div>

        <div className="rpc-ss-pill-group">
          <span className="rpc-ss-pill-label">TIER</span>
          {(["ALL", "COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"] as TierFilter[]).map((t) => (
            <button
              key={t}
              className={`rpc-ss-pill ${tier === t ? "rpc-ss-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="rpc-ss-sort">
          <span className="rpc-ss-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-ss-select"
          >
            <option value="squeeze">Avg squeeze (desc)</option>
            <option value="buyable">Total buyable (asc)</option>
          </select>
        </label>
      </section>

      <section className="rpc-ss-table-wrap">
        {error ? (
          <div className="rpc-ss-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ss-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-ss-state">No sets match those filters.</div>
        ) : (
          <table className="rpc-ss-table">
            <thead>
              <tr>
                <th>Set</th>
                <th className="rpc-ss-th-num">Tier</th>
                <th className="rpc-ss-th-num">Eds</th>
                <th className="rpc-ss-th-num">Circ</th>
                <th className="rpc-ss-th-num">Locked</th>
                <th className="rpc-ss-th-num">Burned</th>
                <th className="rpc-ss-th-num">Buyable</th>
                <th className="rpc-ss-th-num rpc-ss-th-emph">Avg squeeze</th>
                <th className="rpc-ss-th-num">Max</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.set_id}>
                  <td className="rpc-ss-td-set">
                    {r.set_name ? (
                      <div className="rpc-ss-set-cell">
                        <Link
                          href={`/nba-top-shot/set/${encodeURIComponent(slugifyName(r.set_name))}`}
                          className="rpc-ss-set-link"
                          title={`${r.set_name} on NBA Top Shot`}
                        >
                          <div className="rpc-ss-set-name">{r.set_name}</div>
                          <div className="rpc-ss-set-sub">{r.series ? `S${r.series}` : "—"}</div>
                        </Link>
                        <Link
                          href={`/insights/squeeze?set=${encodeURIComponent(r.set_name)}`}
                          className="rpc-ss-trophy-link"
                          title={`Drill into ${r.set_name} on the squeeze board`}
                        >
                          squeeze →
                        </Link>
                        <Link
                          href={`/insights/first-mint?set=${encodeURIComponent(r.set_name)}`}
                          className="rpc-ss-trophy-link"
                          title={`See first-mint trophies from ${r.set_name}`}
                        >
                          trophies →
                        </Link>
                      </div>
                    ) : (
                      <>
                        <div className="rpc-ss-set-name">—</div>
                        <div className="rpc-ss-set-sub">{r.series ? `S${r.series}` : "—"}</div>
                      </>
                    )}
                  </td>
                  <td className="rpc-ss-td-num">
                    <span className="rpc-ss-tier" style={{ color: tierColor(r.set_tier) }}>
                      {r.set_tier ?? "—"}
                    </span>
                  </td>
                  <td className="rpc-ss-td-num">{fmtInt(r.editions_covered)}</td>
                  <td className="rpc-ss-td-num">{fmtInt(r.total_circ)}</td>
                  <td className="rpc-ss-td-num">{fmtInt(r.total_locked)}</td>
                  <td className="rpc-ss-td-num">{fmtInt(r.total_burned)}</td>
                  <td className="rpc-ss-td-num">{fmtInt(r.total_buyable)}</td>
                  <td className="rpc-ss-td-num rpc-ss-td-emph">{fmtPct(r.avg_squeeze_pct)}</td>
                  <td className="rpc-ss-td-num">{fmtPct(r.max_squeeze_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-ss-footer">
        <div className="rpc-ss-method">
          <h3 className="rpc-ss-h3">Methodology</h3>
          <p>
            <strong>Avg squeeze</strong> = average of <code>(locked + burned)
            / circulation</code> across every covered edition in the set —
            including editions below 50% squeeze. This means a set with a
            few very-squeezed editions and many low-squeezed editions reads
            honestly as a moderately-squeezed set, not a hot one. Sets with
            fewer than 5 covered editions are excluded so single-edition
            outliers don&apos;t dominate. Numbers refresh hourly from
            on-chain badge ingestion.
          </p>
          <p>
            <strong>Why "covered editions" might be less than the set&apos;s
            real edition count:</strong> some legacy TS sets aren&apos;t in
            our badge data yet. The Avg figure is over the covered subset;
            Total Circ / Locked / Burned / Buyable are also subset sums. The
            ranking is honest within the subset.
          </p>
          {fetchedAt ? <div className="rpc-ss-fav">Tip: pair with{" "}
            <Link href="/insights/squeeze" className="rpc-ss-inline-link">/insights/squeeze</Link>
            {" "}to drill into the highest-squeeze editions inside a set you found here.
          </div> : null}
        </div>
        <div className="rpc-ss-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ss-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-ss-back">
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
.rpc-ss-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ss-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ss-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ss-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-ss-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ss-inline-link { color: var(--rpc-red); text-decoration: none; }
.rpc-ss-inline-link:hover { color: var(--rpc-red-hover); }
.rpc-ss-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ss-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ss-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-ss-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ss-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-ss-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-ss-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ss-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ss-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-ss-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-ss-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-ss-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ss-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-ss-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-ss-th-num { text-align: right; }
.rpc-ss-th-emph { color: var(--rpc-red); }
.rpc-ss-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-ss-td-set { min-width: 280px; }
.rpc-ss-set-cell { display: flex; align-items: center; gap: 12px; }
.rpc-ss-set-link { text-decoration: none; color: inherit; display: block; flex: 1; min-width: 0; }
.rpc-ss-set-link:hover .rpc-ss-set-name { color: var(--rpc-red); }
.rpc-ss-set-link:hover .rpc-ss-drill-hint { color: var(--rpc-red); opacity: 1; }
.rpc-ss-set-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); transition: color 100ms; }
.rpc-ss-drill-hint { margin-left: 10px; font-size: 10px; letter-spacing: 1.5px; color: var(--rpc-text-muted); opacity: 0.6; transition: color 100ms, opacity 100ms; }
.rpc-ss-trophy-link { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-decoration: none; padding: 4px 8px; border: 1px solid var(--rpc-border); border-radius: 2px; white-space: nowrap; opacity: 0.65; transition: color 100ms, border-color 100ms, opacity 100ms; }
.rpc-ss-trophy-link:hover { color: var(--rpc-red); border-color: var(--rpc-red); opacity: 1; }
.rpc-ss-set-sub { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-ss-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-ss-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-ss-tier { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }

.rpc-ss-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-ss-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-ss-method strong { color: var(--rpc-text-primary); }
.rpc-ss-method code { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-primary); }
.rpc-ss-fav { margin-top: 14px; padding: 10px 12px; background: var(--rpc-red-bg); border-left: 3px solid var(--rpc-red); font-size: 13px; color: var(--rpc-text-secondary); }
.rpc-ss-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ss-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-ss-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ss-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ss-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) { .rpc-ss-footer { grid-template-columns: 1fr; } }
`
