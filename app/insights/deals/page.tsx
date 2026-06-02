"use client"

// app/insights/deals/page.tsx
//
// Public Below FMV board. No auth. Top Shot editions listed below a
// trustworthy (HIGH/MEDIUM-confidence) FMV. The public, top-of-funnel
// counterpart to the auth-gated sniper — "what's underpriced right now" is the
// single most commercially-relevant collector signal, and no native Top Shot
// surface ranks listings against a confidence-rated FMV.
//
// HONEST FRAMING (per the "rank, not price" lesson): a big gap can be a real
// steal — or a low-serial / stale listing. We show the FMV, its confidence,
// and the floor ask side by side so the reader can judge. NOT promoted as
// guaranteed arbitrage.
//
// Data source: GET /api/public/insights/deals -> reads the public
// `topshot_deals_vs_fmv` view (security_invoker=on, anon SELECT-only; gated
// low_ask>=5 + confidence IN (HIGH,MEDIUM) + low_ask<fmv). Board view sends
// min_discount=10; player/set drill-downs send min_discount=0.
//
// Brand tokens only. Per-row link -> /nba-top-shot/edition/<external_id>.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Row = {
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  fmv_usd: number | null
  confidence: string | null
  low_ask: number | null
  discount_pct: number | null
  discount_usd: number | null
  ask_updated_at: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type TierFilter = "ALL" | "COMMON" | "RARE" | "LEGENDARY" | "FANDOM" | "ULTIMATE"
type SortKey = "discount" | "fmv" | "ask" | "circulation"

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

export default function DealsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  const [tier, setTier] = useState<TierFilter>("ALL")
  const [highOnly, setHighOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>("discount")
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

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "200")
        params.set("sort", sort)
        // Board view filters to >=10% gaps. On a player/set drill-down drop to
        // 0 so the reader sees every below-FMV edition (QA point 6).
        params.set("min_discount", setFilter || playerFilter ? "0" : "10")
        if (tier !== "ALL") params.set("tier", tier)
        if (highOnly) params.set("confidence", "HIGH")
        if (setFilter) params.set("set", setFilter)
        if (playerFilter) params.set("player", playerFilter)
        const r = await fetch(`/api/public/insights/deals?${params.toString()}`, {
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
  }, [sort, tier, highOnly, setFilter, playerFilter])

  const kpis = useMemo(() => {
    if (rows.length === 0) {
      return { count: 0, big: 0, medianDiscount: 0 }
    }
    const big = rows.filter((r) => Number(r.discount_pct ?? 0) >= 25).length
    const discounts = rows.map((r) => Number(r.discount_pct ?? 0))
    return {
      count: rows.length,
      big,
      medianDiscount: median(discounts),
    }
  }, [rows])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot shows you a listing. We rank listings against a confidence-rated FMV.\n\nThe Below FMV board — what's underpriced right now:`
    const url = `${SITE_URL}/insights/deals`
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

      <section className="rpc-dl-hero">
        <div className="rpc-dl-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-dl-h1">Below FMV</h1>
        <p className="rpc-dl-lede">
          Top Shot editions listed <strong>below a trustworthy FMV</strong> —
          HIGH or MEDIUM confidence only. A big gap can be a real{" "}
          <em>steal</em> — or a low-serial / stale listing. We show the FMV, its
          confidence, and the floor ask side by side so you can judge.
        </p>
        <div className="rpc-dl-meta-row">
          <span className="rpc-dl-meta">
            Updated{" "}
            {fetchedAt ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}
          </span>
          <span className="rpc-dl-meta-sep">·</span>
          <span className="rpc-dl-meta">Asks refresh continuously</span>
          <span className="rpc-dl-meta-sep">·</span>
          <span className="rpc-dl-meta">No signup</span>
        </div>
      </section>

      {setFilter || playerFilter ? (
        <section className="rpc-dl-active-filter" aria-label="Active drill-down filter">
          {setFilter ? (
            <>
              <span className="rpc-dl-active-label">FILTERED TO SET</span>
              <span className="rpc-dl-active-value">{setFilter}</span>
              <button type="button" className="rpc-dl-active-clear" onClick={() => clearDrill("set")}>
                Clear ✕
              </button>
            </>
          ) : null}
          {playerFilter ? (
            <>
              <span className="rpc-dl-active-label">FILTERED TO PLAYER</span>
              <span className="rpc-dl-active-value">{playerFilter}</span>
              <button type="button" className="rpc-dl-active-clear" onClick={() => clearDrill("player")}>
                Clear ✕
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── Filter row ────────────────────────────────────────────────── */}
      <section className="rpc-dl-controls" aria-label="Filters">
        <div className="rpc-dl-pill-group" role="tablist" aria-label="Tier">
          {TIERS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tier === t}
              className={`rpc-dl-pill ${tier === t ? "rpc-dl-pill-active" : ""}`}
              onClick={() => setTier(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="rpc-dl-pill-group" aria-label="Confidence">
          <span className="rpc-dl-pill-label">CONFIDENCE</span>
          <button
            className={`rpc-dl-pill ${!highOnly ? "rpc-dl-pill-active" : ""}`}
            onClick={() => setHighOnly(false)}
          >
            High + Med
          </button>
          <button
            className={`rpc-dl-pill ${highOnly ? "rpc-dl-pill-active" : ""}`}
            onClick={() => setHighOnly(true)}
          >
            High only
          </button>
        </div>

        <label className="rpc-dl-sort">
          <span className="rpc-dl-pill-label">SORT</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rpc-dl-select">
            <option value="discount">Discount % (desc)</option>
            <option value="fmv">FMV (desc)</option>
            <option value="ask">Floor ask (asc)</option>
            <option value="circulation">Circulation (asc)</option>
          </select>
        </label>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-dl-kpi-row" aria-label="Summary">
        <div className="rpc-dl-kpi">
          <div className="rpc-dl-kpi-label">Deals</div>
          <div className="rpc-dl-kpi-value">{loading ? "—" : fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-dl-kpi">
          <div className="rpc-dl-kpi-label">≥ 25% off</div>
          <div className="rpc-dl-kpi-value">{loading ? "—" : fmtInt(kpis.big)}</div>
        </div>
        <div className="rpc-dl-kpi">
          <div className="rpc-dl-kpi-label">Median discount</div>
          <div className="rpc-dl-kpi-value">{loading ? "—" : fmtPct(kpis.medianDiscount)}</div>
        </div>
        <div className="rpc-dl-kpi">
          <div className="rpc-dl-kpi-label">Rows shown</div>
          <div className="rpc-dl-kpi-value">{loading ? "—" : fmtInt(kpis.count)}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-dl-table-wrap" aria-label="Below FMV board">
        {error ? (
          <div className="rpc-dl-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-dl-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-dl-state">No editions listed below a trustworthy FMV match.</div>
        ) : (
          <div className="rpc-dl-scroll-x">
            <table className="rpc-dl-table">
              <thead>
                <tr>
                  <th className="rpc-dl-th-player">Edition</th>
                  <th className="rpc-dl-th-num">Tier</th>
                  <th className="rpc-dl-th-num">FMV</th>
                  <th className="rpc-dl-th-num">Floor ask</th>
                  <th className="rpc-dl-th-num rpc-dl-th-emph">Discount</th>
                  <th className="rpc-dl-th-num">Mint</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.external_id ?? `${r.player_name}-${r.set_name}`} className="rpc-dl-row">
                    <td className="rpc-dl-td-player">
                      {r.external_id ? (
                        <Link href={`/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`} className="rpc-dl-edition-link">
                          <div className="rpc-dl-edition-name">{r.player_name ?? r.name ?? "—"}</div>
                          <div className="rpc-dl-edition-set">{r.set_name ?? "—"}</div>
                        </Link>
                      ) : (
                        <div>
                          <div className="rpc-dl-edition-name">{r.player_name ?? r.name ?? "—"}</div>
                          <div className="rpc-dl-edition-set">{r.set_name ?? "—"}</div>
                        </div>
                      )}
                    </td>
                    <td className="rpc-dl-td-num">
                      <span className="rpc-dl-tier-chip" style={{ color: tierColor(r.tier) }}>
                        {normalizeTier(r.tier) ?? "—"}
                      </span>
                    </td>
                    <td className="rpc-dl-td-num">
                      {fmtUsd(r.fmv_usd)}
                      {r.confidence ? (
                        <span className={`rpc-dl-conf-chip ${r.confidence === "HIGH" ? "rpc-dl-conf-high" : "rpc-dl-conf-med"}`}>
                          {r.confidence === "HIGH" ? "HI" : "MED"}
                        </span>
                      ) : null}
                    </td>
                    <td className="rpc-dl-td-num">{fmtUsd(r.low_ask)}</td>
                    <td className="rpc-dl-td-num rpc-dl-td-emph">
                      {fmtPct(r.discount_pct)}
                      <span className="rpc-dl-discount-usd">−{fmtUsd(r.discount_usd)}</span>
                    </td>
                    <td className="rpc-dl-td-num">{fmtInt(r.circulation_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-dl-footer">
        <div className="rpc-dl-method">
          <h3 className="rpc-dl-h3">Methodology</h3>
          <p>
            <strong>Discount %</strong> = (FMV − floor ask) ÷ FMV × 100. We only
            list an edition when its floor ask sits below an FMV scored{" "}
            <strong>HIGH or MEDIUM</strong> confidence — a stale or thin-sales
            FMV is excluded so a gap means something.
          </p>
          <p>
            The board is gated to a floor ask of <strong>$5+</strong> so
            penny-floor artifacts don&apos;t headline. Drill into a player or
            set to see every below-FMV edition there, regardless of size.
          </p>
          <p>
            A big discount is <em>not</em> a guaranteed flip — it can be a
            low-serial listing priced below the edition average, or a stale ask
            that hasn&apos;t been pulled. Always open the actual listing before
            acting. FMV from the RPC 1.7.0 model; asks from continuous on-chain
            marketplace ingestion.
          </p>
        </div>

        <div className="rpc-dl-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-dl-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-dl-back">
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
.rpc-dl-hero {
  max-width: 1180px;
  margin: 0 auto 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-dl-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-dl-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-dl-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 780px;
  margin: 0 0 16px;
}
.rpc-dl-lede strong { color: var(--rpc-text-primary); }
.rpc-dl-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-dl-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-dl-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-dl-active-filter {
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
.rpc-dl-active-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-red);
}
.rpc-dl-active-value {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--rpc-text-primary);
  font-weight: 700;
}
.rpc-dl-active-clear {
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
.rpc-dl-active-clear:hover { background: var(--rpc-red); color: #fff; }

.rpc-dl-controls {
  max-width: 1180px;
  margin: 0 auto 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  align-items: center;
}
.rpc-dl-pill-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.rpc-dl-pill-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-right: 4px;
}
.rpc-dl-pill {
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
.rpc-dl-pill:hover {
  border-color: var(--rpc-border-hover);
  color: var(--rpc-text-primary);
}
.rpc-dl-pill-active {
  background: var(--rpc-red-bg);
  border-color: var(--rpc-red);
  color: var(--rpc-red);
}
.rpc-dl-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-dl-select {
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

.rpc-dl-kpi-row {
  max-width: 1180px;
  margin: 0 auto 18px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-dl-kpi {
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-dl-kpi-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 6px;
}
.rpc-dl-kpi-value {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}

.rpc-dl-table-wrap {
  max-width: 1180px;
  margin: 0 auto;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 2px;
}
.rpc-dl-scroll-x { overflow-x: auto; }
.rpc-dl-state {
  padding: 32px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-dl-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-dl-table th {
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
.rpc-dl-th-num { text-align: right; }
.rpc-dl-th-emph { color: var(--rpc-red); }
.rpc-dl-row {
  border-bottom: 1px solid var(--rpc-border-subtle);
  transition: background 100ms;
}
.rpc-dl-row:hover { background: var(--rpc-surface-hover); }
.rpc-dl-table td { padding: 12px; vertical-align: middle; }
.rpc-dl-td-player { min-width: 260px; }
.rpc-dl-edition-link { text-decoration: none; color: inherit; display: block; }
.rpc-dl-edition-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  color: var(--rpc-text-primary);
  line-height: 1.25;
}
.rpc-dl-edition-set {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--rpc-text-muted);
  margin-top: 2px;
}
.rpc-dl-td-num {
  text-align: right;
  font-family: var(--font-mono);
  color: var(--rpc-text-primary);
  white-space: nowrap;
}
.rpc-dl-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-dl-discount-usd {
  display: block;
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--rpc-text-muted);
  font-weight: 400;
  margin-top: 2px;
}
.rpc-dl-tier-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
}
.rpc-dl-conf-chip {
  display: inline-block;
  margin-left: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 2px;
  vertical-align: middle;
}
.rpc-dl-conf-high { color: var(--tier-legendary); border: 1px solid var(--rpc-border); }
.rpc-dl-conf-med { color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); }

.rpc-dl-footer {
  max-width: 1180px;
  margin: 36px auto 0;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-dl-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-dl-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-dl-method strong { color: var(--rpc-text-primary); }
.rpc-dl-method em { color: var(--rpc-text-primary); font-style: italic; }

.rpc-dl-share {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}
.rpc-dl-share-btn {
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
.rpc-dl-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-dl-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-dl-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-dl-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-dl-footer { grid-template-columns: 1fr; }
  .rpc-dl-table { font-size: 13px; }
  .rpc-dl-td-player { min-width: 180px; }
}
`
