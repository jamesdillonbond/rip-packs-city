"use client"

// app/insights/squeeze/SqueezeBoardClient.tsx
//
// Client interactivity layer for the public lock-rate squeeze board. The
// server component (page.tsx) fetches the default-view rows server-side and
// passes them in as `initialRows`, so the ranked table + per-row entity
// drill-down links render in the raw server HTML (crawlable) instead of only
// after JS. This component layers on the filter / sort / drill-down behavior
// as progressive enhancement and only refetches when the user changes the
// sort or arrives via a set/player drill-down — the default view never
// refetches on mount.
//
// See app/insights/squeeze/page.tsx for the data source + server fetch.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  edition_id: string
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation: number | null
  locked: number | null
  burned: number | null
  lock_pct: number | null
  burn_pct: number | null
  squeeze_pct: number | null
  effectively_buyable: number | null
  low_ask: number | null
  fmv_usd: number | null
  confidence: string | null
  game_date: string | null
  thumbnail_url: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type TierFilter = "ALL" | "COMMON" | "RARE" | "LEGENDARY" | "FANDOM" | "ULTIMATE"
type SortKey = "squeeze" | "circulation" | "fmv" | "buyable"

// Normalize the dirty tier vocabulary in the view. Some rows are tagged with
// MOMENT_TIER_RARE / MOMENT_TIER_LEGENDARY (older catalog inserts); collapse
// them to the canonical tier set so the tier pill filter works.
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

export default function SqueezeBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  // We already have the default-view rows from the server, so the table is
  // not "loading" on first paint — loading only flips true on a sort/filter
  // refetch.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [tier, setTier] = useState<TierFilter>("ALL")
  const [maxBuyable, setMaxBuyable] = useState<number | null>(null)
  // Trophy-circulation filter — exposes the API's max_circulation param so
  // users can drill straight to LEGENDARY / ULTIMATE-size editions.
  const [maxCirculation, setMaxCirculation] = useState<number | null>(null)
  const [sort, setSort] = useState<SortKey>("squeeze")
  // Pre-filter to a specific set or player when arriving from another
  // surface (set-squeeze / cross-collection / rookies / first-mint).
  // Read from window.location on mount (one-shot — page re-mounts on
  // hard-link nav).
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

  // Rewards: a logged-in user viewing the squeeze board earns view_squeeze_board
  // (daily_cap 1, enforced server-side). This is a public surface, so anon
  // viewers hit the auth gate and simply earn nothing — fire-and-forget, the
  // result is intentionally ignored and never blocks the page.
  useEffect(() => {
    fetch("/api/rewards/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "view_squeeze" }),
    }).catch(() => {})
  }, [])

  // Skip the very first fetch when the params match the server-fetched default
  // view (sort=squeeze, no set/player drill-down) — the server already gave us
  // those rows. Any sort change or drill-down arrival refetches normally.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (sort === "squeeze" && !setFilter && !playerFilter) {
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
        // Default min_squeeze = 50 (the "squeeze board" framing). When the
        // user arrives via a player or set drill-down, drop the floor to 0
        // so they see ALL of that player/set's editions, not just the
        // squeezed ones — e.g. a rookie with max squeeze 48% deserves to
        // be visible.
        params.set("min_squeeze", setFilter || playerFilter ? "0" : "50")
        // Set + player filters are server-side (ilike). Push them when
        // present. Tier/buyable/circulation stay client-side over the
        // already-fetched 200.
        if (setFilter) params.set("set", setFilter)
        if (playerFilter) params.set("player", playerFilter)
        const r = await fetch(`/api/public/insights/squeeze?${params.toString()}`, {
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
  }, [sort, setFilter, playerFilter])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tier !== "ALL" && normalizeTier(r.tier) !== tier) return false
      if (maxBuyable != null && (r.effectively_buyable ?? Infinity) > maxBuyable) return false
      if (maxCirculation != null && (r.circulation ?? Infinity) > maxCirculation) return false
      return true
    })
  }, [rows, tier, maxBuyable, maxCirculation])

  const kpis = useMemo(() => {
    if (filtered.length === 0) {
      return { count: 0, medianSqueeze: 0, medianBuyable: 0, totalLocked: 0 }
    }
    const squeezes = filtered.map((r) => Number(r.squeeze_pct ?? 0))
    const buyables = filtered.map((r) => Number(r.effectively_buyable ?? 0))
    const totalLocked = filtered.reduce((acc, r) => acc + Number(r.locked ?? 0), 0)
    return {
      count: filtered.length,
      medianSqueeze: median(squeezes),
      medianBuyable: median(buyables),
      totalLocked,
    }
  }, [filtered])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot displays circulation. We display effective supply.\n\nThe lock-rate squeeze board — what's actually buyable after locks + burns:`
    const url = `${SITE_URL}/insights/squeeze`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-sq-hero">
        <div className="rpc-sq-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-sq-h1">The Lock-Rate Squeeze Board</h1>
        <p className="rpc-sq-lede">
          Top Shot&apos;s marketplace shows you <em>circulation</em>. We show
          you <strong>effective supply</strong> — circulation minus the
          moments locked in challenges and the moments already burned.
          Editions with 50%+ squeeze are tighter than the listing page lets on.
        </p>
        <div className="rpc-sq-meta-row">
          <span className="rpc-sq-meta">
            Updated{" "}
            {fetchedAt ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}
          </span>
          <span className="rpc-sq-meta-sep">·</span>
          <span className="rpc-sq-meta">Refreshes hourly</span>
          <span className="rpc-sq-meta-sep">·</span>
          <span className="rpc-sq-meta">No signup</span>
        </div>
      </section>

      {setFilter || playerFilter ? (
        <section className="rpc-sq-active-filter" aria-label="Active drill-down filter">
          {setFilter ? (
            <>
              <span className="rpc-sq-active-label">FILTERED TO SET</span>
              <span className="rpc-sq-active-value">{setFilter}</span>
              <button
                type="button"
                className="rpc-sq-active-clear"
                onClick={() => {
                  setSetFilter(null)
                  if (typeof window !== "undefined") {
                    const url = new URL(window.location.href)
                    url.searchParams.delete("set")
                    window.history.replaceState({}, "", url.toString())
                  }
                }}
              >
                Clear ✕
              </button>
            </>
          ) : null}
          {playerFilter ? (
            <>
              <span className="rpc-sq-active-label">FILTERED TO PLAYER</span>
              <span className="rpc-sq-active-value">{playerFilter}</span>
              <button
                type="button"
                className="rpc-sq-active-clear"
                onClick={() => {
                  setPlayerFilter(null)
                  if (typeof window !== "undefined") {
                    const url = new URL(window.location.href)
                    url.searchParams.delete("player")
                    window.history.replaceState({}, "", url.toString())
                  }
                }}
              >
                Clear ✕
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── Filter row ────────────────────────────────────────────────── */}
      <section className="rpc-sq-controls" aria-label="Filters">
        <div className="rpc-sq-pill-group" role="tablist" aria-label="Tier">
          {TIERS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tier === t}
              className={`rpc-sq-pill ${tier === t ? "rpc-sq-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="rpc-sq-pill-group" aria-label="Max effectively buyable">
          <span className="rpc-sq-pill-label">MAX BUYABLE</span>
          {[null, 25, 10, 5].map((m) => (
            <button
              key={String(m)}
              className={`rpc-sq-pill ${maxBuyable === m ? "rpc-sq-pill-active" : ""}`}
              onClick={() => setMaxBuyable(m)}
            >
              {m == null ? "Any" : `≤ ${m}`}
            </button>
          ))}
        </div>

        <div className="rpc-sq-pill-group" aria-label="Max circulation">
          <span className="rpc-sq-pill-label">TROPHY-CIRC</span>
          {[
            { val: null, label: "Any" },
            { val: 100, label: "≤ 100" },
            { val: 75, label: "≤ 75 (Legendary)" },
            { val: 10, label: "≤ 10 (Ultimate)" },
          ].map((m) => (
            <button
              key={String(m.val)}
              className={`rpc-sq-pill ${maxCirculation === m.val ? "rpc-sq-pill-active" : ""}`}
              onClick={() => setMaxCirculation(m.val)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="rpc-sq-sort">
          <span className="rpc-sq-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-sq-select"
          >
            <option value="squeeze">Squeeze % (desc)</option>
            <option value="buyable">Effectively buyable (asc)</option>
            <option value="circulation">Circulation (asc)</option>
            <option value="fmv">FMV (desc)</option>
          </select>
        </label>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-sq-kpi-row" aria-label="Summary">
        <div className="rpc-sq-kpi">
          <div className="rpc-sq-kpi-label">Editions</div>
          <div className="rpc-sq-kpi-value">{loading ? "—" : fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-sq-kpi">
          <div className="rpc-sq-kpi-label">Median squeeze</div>
          <div className="rpc-sq-kpi-value">{loading ? "—" : fmtPct(kpis.medianSqueeze)}</div>
        </div>
        <div className="rpc-sq-kpi">
          <div className="rpc-sq-kpi-label">Median buyable</div>
          <div className="rpc-sq-kpi-value">{loading ? "—" : fmtInt(Math.round(kpis.medianBuyable))}</div>
        </div>
        <div className="rpc-sq-kpi">
          <div className="rpc-sq-kpi-label">Total locked</div>
          <div className="rpc-sq-kpi-value">{loading ? "—" : fmtInt(kpis.totalLocked)}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-sq-table-wrap" aria-label="Squeeze board">
        {error ? (
          <div className="rpc-sq-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-sq-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rpc-sq-state">No editions match those filters.</div>
        ) : (
          <table className="rpc-sq-table">
            <thead>
              <tr>
                <th className="rpc-sq-th-player">Edition</th>
                <th className="rpc-sq-th-num">Tier</th>
                <th className="rpc-sq-th-num">Circ</th>
                <th className="rpc-sq-th-num">Locked</th>
                <th className="rpc-sq-th-num">Burned</th>
                <th className="rpc-sq-th-num rpc-sq-th-emph">Squeeze</th>
                <th className="rpc-sq-th-num rpc-sq-th-emph">Buyable</th>
                <th className="rpc-sq-th-num">FMV</th>
                <th className="rpc-sq-th-num">Low ask</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                // Prefer the canonical edition page (corpus internal link);
                // fall back to /moment/<uuid> when external_id is absent.
                const href = r.external_id
                  ? `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`
                  : `/moment/${r.edition_id}`
                return (
                <tr
                  key={r.edition_id}
                  onClick={() => {
                    window.location.href = href
                  }}
                  className="rpc-sq-row"
                >
                  <td className="rpc-sq-td-player">
                    <Link href={href} className="rpc-sq-edition-link" onClick={(e) => e.stopPropagation()}>
                      <div className="rpc-sq-edition-name">{r.player_name ?? "—"}</div>
                      <div className="rpc-sq-edition-set">{r.set_name ?? "—"}</div>
                    </Link>
                  </td>
                  <td className="rpc-sq-td-num">
                    <span className="rpc-sq-tier-chip" style={{ color: tierColor(r.tier) }}>
                      {normalizeTier(r.tier) ?? "—"}
                    </span>
                  </td>
                  <td className="rpc-sq-td-num">{fmtInt(r.circulation)}</td>
                  <td className="rpc-sq-td-num">{fmtInt(r.locked)}</td>
                  <td className="rpc-sq-td-num">{fmtInt(r.burned)}</td>
                  <td className="rpc-sq-td-num rpc-sq-td-emph">{fmtPct(r.squeeze_pct)}</td>
                  <td className="rpc-sq-td-num rpc-sq-td-emph">{fmtInt(r.effectively_buyable)}</td>
                  <td className="rpc-sq-td-num">{fmtUsd(r.fmv_usd)}</td>
                  <td className="rpc-sq-td-num">{fmtUsd(r.low_ask)}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-sq-footer">
        <div className="rpc-sq-method">
          <h3 className="rpc-sq-h3">Methodology</h3>
          <p>
            <strong>Squeeze %</strong> = (locked + burned) / circulation.
            Lock %, burn %, and effectively-buyable % all share the same
            denominator (original circulation), so they sum to 100%.
            Squeeze % is bounded to [50%, 100%].
          </p>
          <p>
            <strong>Effectively buyable</strong> = circulation − locked −
            burned. Lock + burn data refreshes hourly from on-chain badge
            event ingestion. FMV from the RPC 1.7.0 sales-WAP model with
            outlier filtering; <em>—</em> indicates fewer than the minimum
            sale-count threshold for a confidence score.
          </p>
          <p>
            We start at 50% squeeze because below that, the marketplace UI
            is already close to honest. The interesting tail is the editions
            where Top Shot says &ldquo;229 minted&rdquo; and only 12 of them
            are actually purchasable.
          </p>
        </div>

        <div className="rpc-sq-share">
          <a
            href={tweetIntent}
            target="_blank"
            rel="noopener noreferrer"
            className="rpc-sq-share-btn"
          >
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-sq-back">
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
.rpc-sq-hero {
  max-width: 1180px;
  margin: 0 auto 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-sq-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-sq-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-sq-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 780px;
  margin: 0 0 16px;
}
.rpc-sq-lede strong { color: var(--rpc-text-primary); }
.rpc-sq-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-sq-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-sq-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-sq-active-filter {
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
.rpc-sq-active-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-red);
}
.rpc-sq-active-value {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--rpc-text-primary);
  font-weight: 700;
}
.rpc-sq-active-clear {
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
.rpc-sq-active-clear:hover { background: var(--rpc-red); color: #fff; }

.rpc-sq-controls {
  max-width: 1180px;
  margin: 0 auto 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  align-items: center;
}
.rpc-sq-pill-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.rpc-sq-pill-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-right: 4px;
}
.rpc-sq-pill {
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
.rpc-sq-pill:hover {
  border-color: var(--rpc-border-hover);
  color: var(--rpc-text-primary);
}
.rpc-sq-pill-active {
  background: var(--rpc-red-bg);
  border-color: var(--rpc-red);
  color: var(--rpc-red);
}
.rpc-sq-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-sq-select {
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

.rpc-sq-kpi-row {
  max-width: 1180px;
  margin: 0 auto 18px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-sq-kpi {
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-sq-kpi-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 6px;
}
.rpc-sq-kpi-value {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}

.rpc-sq-table-wrap {
  max-width: 1180px;
  margin: 0 auto;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  overflow-x: auto;
  border-radius: 2px;
}
.rpc-sq-state {
  padding: 32px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-sq-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-sq-table th {
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
.rpc-sq-th-num { text-align: right; }
.rpc-sq-th-emph { color: var(--rpc-red); }
.rpc-sq-row {
  cursor: pointer;
  border-bottom: 1px solid var(--rpc-border-subtle);
  transition: background 100ms;
}
.rpc-sq-row:hover { background: var(--rpc-surface-hover); }
.rpc-sq-table td { padding: 12px; vertical-align: middle; }
.rpc-sq-td-player { min-width: 260px; }
.rpc-sq-edition-link { text-decoration: none; color: inherit; display: block; }
.rpc-sq-edition-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  color: var(--rpc-text-primary);
  line-height: 1.25;
}
.rpc-sq-edition-set {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--rpc-text-muted);
  margin-top: 2px;
}
.rpc-sq-td-num {
  text-align: right;
  font-family: var(--font-mono);
  color: var(--rpc-text-primary);
  white-space: nowrap;
}
.rpc-sq-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-sq-tier-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.rpc-sq-footer {
  max-width: 1180px;
  margin: 36px auto 0;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-sq-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-sq-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-sq-method strong { color: var(--rpc-text-primary); }
.rpc-sq-method em { color: var(--rpc-text-primary); font-style: italic; }

.rpc-sq-share {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}
.rpc-sq-share-btn {
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
.rpc-sq-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-sq-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-sq-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-sq-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-sq-footer { grid-template-columns: 1fr; }
  .rpc-sq-table { font-size: 13px; }
  .rpc-sq-td-player { min-width: 180px; }
}
`
