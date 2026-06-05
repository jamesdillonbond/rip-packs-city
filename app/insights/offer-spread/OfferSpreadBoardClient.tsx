"use client"

// app/insights/offer-spread/OfferSpreadBoardClient.tsx
//
// Client interactivity layer for the public Bid vs Floor board. The server
// component (page.tsx) fetches the default board view (low_ask >= 5, tightest
// par first) from topshot_offer_ask_spread server-side and passes them in as
// `initialRows`, so the ranked table + per-row /nba-top-shot/edition/<id>
// drill-down links render in the raw server HTML (crawlable) instead of only
// after JS. This component layers on tier / bid-meets-floor / sort / drill-down
// as progressive enhancement and only refetches when those change.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  highest_offer: number | null
  low_ask: number | null
  offer_pct_of_ask: number | null
  par_distance: number | null
  spread_usd: number | null
  bid_meets_ask: boolean | null
  updated_at: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type TierFilter = "ALL" | "COMMON" | "RARE" | "LEGENDARY" | "FANDOM" | "ULTIMATE"
type SortKey = "par" | "spread" | "offer" | "ask" | "pct"

function normalizeTier(t: string | null): string | null {
  if (!t) return null
  return t.replace(/^MOMENT_TIER_/, "")
}

const TIERS: TierFilter[] = ["ALL", "COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"]

function fmtPct(n: number | null): string {
  if (n == null) return "—"
  return `${Math.round(Number(n))}%`
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function tierColor(tier: string | null): string {
  switch (normalizeTier(tier)) {
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

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function OfferSpreadBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  // Server already gave us the default board view — not "loading" on first paint.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [tier, setTier] = useState<TierFilter>("ALL")
  const [bidMeetsOnly, setBidMeetsOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>("par")
  // Pre-filter to a set or player when arriving from another surface.
  const [setFilter, setSetFilter] = useState<string | null>(null)
  const [playerFilter, setPlayerFilter] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      const s = url.searchParams.get("set")
      const p = url.searchParams.get("player")
      if (s) setSetFilter(s)
      if (p) setPlayerFilter(p)
    }
  }, [])

  // Skip the very first fetch when params match the server-fetched default board.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (sort === "par" && tier === "ALL" && !bidMeetsOnly && !setFilter && !playerFilter) {
        return
      }
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "200")
        params.set("sort", sort)
        // Board view hides penny-floor ratio noise with min_ask=5. On a
        // player/set drill-down drop to 0 so the reader sees every edition
        // with both sides, not just the >=$5 ones (QA point 6).
        params.set("min_ask", setFilter || playerFilter ? "0" : "5")
        if (tier !== "ALL") params.set("tier", tier)
        if (bidMeetsOnly) params.set("bid_meets_ask", "true")
        if (setFilter) params.set("set", setFilter)
        if (playerFilter) params.set("player", playerFilter)
        const r = await fetch(`/api/public/insights/offer-spread?${params.toString()}`, {
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
  }, [sort, tier, bidMeetsOnly, setFilter, playerFilter])

  const kpis = useMemo(() => {
    if (rows.length === 0) {
      return { bidMeets: 0, within10: 0, medianSpread: 0, count: 0 }
    }
    const bidMeets = rows.filter((r) => r.bid_meets_ask).length
    const within10 = rows.filter((r) => Number(r.par_distance ?? Infinity) <= 10).length
    const spreads = rows.map((r) => Number(r.spread_usd ?? 0))
    return {
      bidMeets,
      within10,
      medianSpread: median(spreads),
      count: rows.length,
    }
  }, [rows])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot doesn't show you the top bid next to the floor ask. We do.\n\nThe Bid vs Floor board — editions where the best offer meets the floor:`
    const url = `${SITE_URL}/insights/offer-spread`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  function clearDrill(kind: "set" | "player") {
    if (kind === "set") setSetFilter(null)
    else setPlayerFilter(null)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.delete(kind)
      window.history.replaceState({}, "", url.toString())
    }
  }

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-os-hero">
        <div className="rpc-os-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-os-h1">Bid vs Floor</h1>
        <p className="rpc-os-lede">
          Top Shot editions where the highest standing <strong>offer</strong>{" "}
          meets or approaches the lowest <strong>ask</strong>. A bid at or
          above the floor can mean <em>instant liquidity</em> — or a stale /
          different-serial listing. We show the floor ask next to the bid so
          you can judge.
        </p>
        <div className="rpc-os-meta-row">
          <span className="rpc-os-meta">
            Updated{" "}
            {fetchedAt ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}
          </span>
          <span className="rpc-os-meta-sep">·</span>
          <span className="rpc-os-meta">Refreshes continuously</span>
          <span className="rpc-os-meta-sep">·</span>
          <span className="rpc-os-meta">No signup</span>
        </div>
      </section>

      {setFilter || playerFilter ? (
        <section className="rpc-os-active-filter" aria-label="Active drill-down filter">
          {setFilter ? (
            <>
              <span className="rpc-os-active-label">FILTERED TO SET</span>
              <span className="rpc-os-active-value">{setFilter}</span>
              <button type="button" className="rpc-os-active-clear" onClick={() => clearDrill("set")}>
                Clear ✕
              </button>
            </>
          ) : null}
          {playerFilter ? (
            <>
              <span className="rpc-os-active-label">FILTERED TO PLAYER</span>
              <span className="rpc-os-active-value">{playerFilter}</span>
              <button type="button" className="rpc-os-active-clear" onClick={() => clearDrill("player")}>
                Clear ✕
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── Filter row ────────────────────────────────────────────────── */}
      <section className="rpc-os-controls" aria-label="Filters">
        <div className="rpc-os-pill-group" role="tablist" aria-label="Tier">
          {TIERS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tier === t}
              className={`rpc-os-pill ${tier === t ? "rpc-os-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="rpc-os-pill-group" aria-label="Bid meets floor">
          <span className="rpc-os-pill-label">BID</span>
          <button
            className={`rpc-os-pill ${!bidMeetsOnly ? "rpc-os-pill-active" : ""}`}
            onClick={() => setBidMeetsOnly(false)}
          >
            Any
          </button>
          <button
            className={`rpc-os-pill ${bidMeetsOnly ? "rpc-os-pill-active" : ""}`}
            onClick={() => setBidMeetsOnly(true)}
          >
            ≥ floor only
          </button>
        </div>

        <label className="rpc-os-sort">
          <span className="rpc-os-pill-label">SORT</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rpc-os-select">
            <option value="par">Tightest spread (par)</option>
            <option value="spread">Spread $ (asc)</option>
            <option value="offer">Top bid (desc)</option>
            <option value="ask">Floor ask (desc)</option>
            <option value="pct">Bid % of floor (desc)</option>
          </select>
        </label>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-os-kpi-row" aria-label="Summary">
        <div className="rpc-os-kpi">
          <div className="rpc-os-kpi-label">Bid ≥ floor</div>
          <div className="rpc-os-kpi-value">{loading ? "—" : fmtInt(kpis.bidMeets)}</div>
        </div>
        <div className="rpc-os-kpi">
          <div className="rpc-os-kpi-label">Within 10% of floor</div>
          <div className="rpc-os-kpi-value">{loading ? "—" : fmtInt(kpis.within10)}</div>
        </div>
        <div className="rpc-os-kpi">
          <div className="rpc-os-kpi-label">Median spread</div>
          <div className="rpc-os-kpi-value">{loading ? "—" : fmtUsd(kpis.medianSpread)}</div>
        </div>
        <div className="rpc-os-kpi">
          <div className="rpc-os-kpi-label">Rows shown</div>
          <div className="rpc-os-kpi-value">{loading ? "—" : fmtInt(kpis.count)}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-os-table-wrap" aria-label="Bid vs floor board">
        {error ? (
          <div className="rpc-os-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-os-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-os-state">No editions with both a live bid and a floor ask match.</div>
        ) : (
          <div className="rpc-os-scroll-x">
            <table className="rpc-os-table">
              <thead>
                <tr>
                  <th className="rpc-os-th-player">Edition</th>
                  <th className="rpc-os-th-num">Tier</th>
                  <th className="rpc-os-th-num rpc-os-th-emph">Top bid</th>
                  <th className="rpc-os-th-num">Floor ask</th>
                  <th className="rpc-os-th-num rpc-os-th-emph">Bid % of floor</th>
                  <th className="rpc-os-th-num">Spread</th>
                  <th className="rpc-os-th-num">Mint</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.external_id ?? `${r.player_name}-${r.set_name}`} className="rpc-os-row">
                    <td className="rpc-os-td-player">
                      {r.external_id ? (
                        <Link href={`/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`} className="rpc-os-edition-link">
                          <div className="rpc-os-edition-name">{r.player_name ?? r.name ?? "—"}</div>
                          <div className="rpc-os-edition-set">{r.set_name ?? "—"}</div>
                        </Link>
                      ) : (
                        <div>
                          <div className="rpc-os-edition-name">{r.player_name ?? r.name ?? "—"}</div>
                          <div className="rpc-os-edition-set">{r.set_name ?? "—"}</div>
                        </div>
                      )}
                    </td>
                    <td className="rpc-os-td-num">
                      <span className="rpc-os-tier-chip" style={{ color: tierColor(r.tier) }}>
                        {normalizeTier(r.tier) ?? "—"}
                      </span>
                    </td>
                    <td className="rpc-os-td-num rpc-os-td-emph">{fmtUsd(r.highest_offer)}</td>
                    <td className="rpc-os-td-num">{fmtUsd(r.low_ask)}</td>
                    <td className="rpc-os-td-num rpc-os-td-emph">
                      {fmtPct(r.offer_pct_of_ask)}
                      {r.bid_meets_ask ? <span className="rpc-os-meets-chip">≥ floor</span> : null}
                    </td>
                    <td className="rpc-os-td-num">{fmtUsd(r.spread_usd)}</td>
                    <td className="rpc-os-td-num">{fmtInt(r.circulation_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-os-footer">
        <div className="rpc-os-method">
          <h3 className="rpc-os-h3">Methodology</h3>
          <p>
            <strong>Bid % of floor</strong> = highest standing offer ÷ lowest
            ask × 100. <strong>Spread</strong> = floor ask − top bid. We sort by{" "}
            <em>par distance</em> (how far the bid % sits from 100) so the
            tightest two-sided markets surface first.
          </p>
          <p>
            The board is gated to a floor ask of <strong>$5+</strong> so
            penny-floor ratio artifacts (a $1 listing with a $400 bid reads as
            40,000%) don&apos;t headline. Drill into a player or set to see
            every edition with both sides, regardless of price.
          </p>
          <p>
            A bid that <em>meets or beats</em> the floor is not automatically a
            free trade — it can be a serial-mismatched or stale cheap listing.
            Always check the actual listing before acting. Offer + ask data
            refreshes continuously from on-chain marketplace ingestion.
          </p>
        </div>

        <div className="rpc-os-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-os-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-os-back">
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
.rpc-os-hero {
  max-width: 1180px;
  margin: 0 auto 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-os-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-os-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-os-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 780px;
  margin: 0 0 16px;
}
.rpc-os-lede strong { color: var(--rpc-text-primary); }
.rpc-os-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-os-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-os-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-os-active-filter {
  max-width: 1180px;
  margin: 0 auto 14px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--rpc-red-bg);
  border: 1px solid var(--rpc-red-border);
  border-radius: 2px;
}
.rpc-os-active-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-red);
}
.rpc-os-active-value {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--rpc-text-primary);
  font-weight: 700;
}
.rpc-os-active-clear {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid var(--rpc-red-border);
  color: var(--rpc-red);
  padding: 4px 8px;
  border-radius: 2px;
  cursor: pointer;
  margin-left: 4px;
}
.rpc-os-active-clear:hover { background: var(--rpc-red); color: #fff; }

.rpc-os-controls {
  max-width: 1180px;
  margin: 0 auto 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  align-items: center;
}
.rpc-os-pill-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.rpc-os-pill-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-right: 4px;
}
.rpc-os-pill {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  padding: 7px 14px;
  border: 1px solid var(--rpc-border);
  background: transparent;
  color: var(--rpc-text-secondary);
  cursor: pointer;
  border-radius: 2px;
  transition: border-color 120ms, color 120ms, background 120ms;
}
.rpc-os-pill:hover {
  border-color: var(--rpc-border-hover);
  color: var(--rpc-text-primary);
}
.rpc-os-pill-active {
  background: var(--rpc-red-bg);
  border-color: var(--rpc-red);
  color: var(--rpc-red);
}
.rpc-os-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-os-select {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 1px;
  background: transparent;
  border: 1px solid var(--rpc-border);
  color: var(--rpc-text-primary);
  padding: 7px 10px;
  border-radius: 2px;
  cursor: pointer;
}

.rpc-os-kpi-row {
  max-width: 1180px;
  margin: 0 auto 18px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-os-kpi {
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-os-kpi-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 6px;
}
.rpc-os-kpi-value {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}

.rpc-os-table-wrap {
  max-width: 1180px;
  margin: 0 auto;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 2px;
}
.rpc-os-scroll-x { overflow-x: auto; }
.rpc-os-state {
  padding: 32px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-os-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-os-table th {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  text-align: left;
  padding: 14px 12px;
  border-bottom: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  white-space: nowrap;
}
.rpc-os-th-num { text-align: right; }
.rpc-os-th-emph { color: var(--rpc-red); }
.rpc-os-row {
  border-bottom: 1px solid var(--rpc-border-subtle);
  transition: background 100ms;
}
.rpc-os-row:hover { background: var(--rpc-surface-hover); }
.rpc-os-table td { padding: 12px; vertical-align: middle; }
.rpc-os-td-player { min-width: 260px; }
.rpc-os-edition-link { text-decoration: none; color: inherit; display: block; }
.rpc-os-edition-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  color: var(--rpc-text-primary);
  line-height: 1.25;
}
.rpc-os-edition-set {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--rpc-text-muted);
  margin-top: 2px;
}
.rpc-os-td-num {
  text-align: right;
  font-family: var(--font-mono);
  color: var(--rpc-text-primary);
  white-space: nowrap;
}
.rpc-os-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-os-tier-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
}
.rpc-os-meets-chip {
  display: inline-block;
  margin-left: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--rpc-red);
  border: 1px solid var(--rpc-red-border);
  background: var(--rpc-red-bg);
  padding: 2px 6px;
  border-radius: 2px;
  vertical-align: middle;
}

.rpc-os-footer {
  max-width: 1180px;
  margin: 36px auto 0;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-os-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-os-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-os-method strong { color: var(--rpc-text-primary); }
.rpc-os-method em { color: var(--rpc-text-primary); font-style: italic; }

.rpc-os-share {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}
.rpc-os-share-btn {
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
.rpc-os-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-os-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-os-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-os-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-os-footer { grid-template-columns: 1fr; }
  .rpc-os-table { font-size: 13px; }
  .rpc-os-td-player { min-width: 180px; }
}
`
