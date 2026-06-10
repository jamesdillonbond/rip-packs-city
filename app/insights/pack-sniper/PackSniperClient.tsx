"use client"

// app/insights/pack-sniper/PackSniperClient.tsx
//
// Client interactivity for the public Pack Sniper deal board. The server
// component (page.tsx) fetches the default view (Top Shot, honest deals only)
// and passes it as initialDeals, so the ranked table + outbound/drill-down
// links render in the raw server HTML (crawlable). This layer adds the
// collection toggle, the show/hide-high-variance toggle, and refetch.
//
// RANK, DON'T PRICE: we present ordering + "ask $X vs EV $Y", never a headline
// "92x return!". High-variance (chance-hit / single-chase / depleted) packs are
// hidden by default and revealed flagged red — gross_ev is a drop-weighted
// expectation whose modal outcome on those packs is far lower. Every row links
// to the simulator, which shows the real outcome distribution.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Deal = {
  distId: string
  title: string
  tier: string
  imageUrl: string
  slots: number
  lowestAsk: number
  grossEV: number
  liveValueRatio: number
  discountPct: number
  fmvCoveragePct: number
  evSnapshottedAt: string | null
  editionCount: number | null
  depletionPct: number | null
  highVariance: boolean
  highVarianceReasons: string[]
  buyUrl: string
  dapperUrl: string
  detailHref: string
  simulatorHref: string
}

type ApiResponse = {
  meta: { fetched_at: string; collection: string; stats?: { returned: number } }
  deals: Deal[]
}

type Collection = "nba-top-shot" | "nfl-all-day"

const COLLECTION_LABEL: Record<Collection, string> = {
  "nba-top-shot": "NBA Top Shot",
  "nfl-all-day": "NFL All Day",
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n >= 100) return `${Math.round(n)}×`
  if (n >= 10) return `${n.toFixed(0)}×`
  return `${n.toFixed(1)}×`
}

function tierColor(tier: string | null): string {
  switch ((tier ?? "").toLowerCase()) {
    case "legendary":
      return "var(--tier-legendary)"
    case "ultimate":
      return "var(--tier-ultimate)"
    case "rare":
      return "var(--tier-rare)"
    case "fandom":
      return "var(--tier-fandom)"
    case "common":
      return "var(--tier-common)"
    default:
      return "var(--rpc-text-muted)"
  }
}

const VARIANCE_REASON_LABEL: Record<string, string> = {
  ev_gt_3x_ask: "EV > 3× ask (tail-driven)",
  depleted_60pct: "60%+ depleted",
  thin_fmv_coverage: "thin FMV coverage",
  single_slot_chase: "single-slot chase",
}

type Props = {
  initialDeals: Deal[]
  initialFetchedAt: string | null
}

export default function PackSniperClient({ initialDeals, initialFetchedAt }: Props) {
  const [collection, setCollection] = useState<Collection>("nba-top-shot")
  const [showHighVariance, setShowHighVariance] = useState(false)
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  // (No rewards earn wired for this surface yet — the rewards/track allowlist
  // has no view_pack_sniper rule, and adding one is a separate rewards-DB task.)

  // Skip the first fetch when params match the server-fetched default view
  // (Top Shot, high-variance hidden). Any toggle change refetches.
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (collection === "nba-top-shot" && !showHighVariance) return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("collection", collection)
        params.set("limit", "100")
        params.set("include_high_variance", showHighVariance ? "true" : "false")
        const r = await fetch(`/api/public/insights/pack-sniper?${params.toString()}`, {
          signal: ctrl.signal,
          cache: "no-store",
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as ApiResponse
        setDeals(j.deals ?? [])
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
  }, [collection, showHighVariance])

  // Server already filters by include_high_variance, but guard client-side too
  // so the toggle feels instant against already-loaded rows.
  const visible = useMemo(
    () => (showHighVariance ? deals : deals.filter((d) => !d.highVariance)),
    [deals, showHighVariance],
  )

  const kpis = useMemo(() => {
    if (visible.length === 0) return { count: 0, medianRatio: 0, bestRatio: 0, hiddenHiVar: 0 }
    const ratios = [...visible.map((d) => d.liveValueRatio)].sort((a, b) => a - b)
    const mid = Math.floor(ratios.length / 2)
    const medianRatio = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2
    const hiddenHiVar = showHighVariance ? 0 : deals.filter((d) => d.highVariance).length
    return { count: visible.length, medianRatio, bestRatio: ratios[ratios.length - 1], hiddenHiVar }
  }, [visible, deals, showHighVariance])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot shows a sealed pack's low ask. We show the ask vs the pack's expected pull value.\n\nThe Pack Sniper — sealed packs currently listed below EV:`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
      `${SITE_URL}/insights/pack-sniper`,
    )}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-ps-hero">
        <div className="rpc-ps-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-ps-h1">The Pack Sniper</h1>
        <p className="rpc-ps-lede">
          Top Shot&apos;s marketplace shows you a sealed pack&apos;s{" "}
          <em>low ask</em>. We show you that ask against the pack&apos;s{" "}
          <strong>expected pull value</strong> — so you can see which sealed
          packs are currently listed for less than what&apos;s statistically
          inside them.
        </p>
        <div className="rpc-ps-meta-row">
          <span className="rpc-ps-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-ps-meta-sep">·</span>
          <span className="rpc-ps-meta">Live asks · refreshes every few min</span>
          <span className="rpc-ps-meta-sep">·</span>
          <span className="rpc-ps-meta">No signup</span>
        </div>
      </section>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <section className="rpc-ps-controls" aria-label="Controls">
        <div className="rpc-ps-pill-group" role="tablist" aria-label="Collection">
          {(Object.keys(COLLECTION_LABEL) as Collection[]).map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={collection === c}
              className={`rpc-ps-pill ${collection === c ? "rpc-ps-pill-active" : ""}`}
              onClick={() => setCollection(c)}
            >
              {COLLECTION_LABEL[c]}
            </button>
          ))}
        </div>

        <label className="rpc-ps-toggle">
          <input
            type="checkbox"
            checked={showHighVariance}
            onChange={(e) => setShowHighVariance(e.target.checked)}
          />
          <span>
            Show high-variance (chance-hit) packs
            {kpis.hiddenHiVar > 0 ? ` (${kpis.hiddenHiVar} hidden)` : ""}
          </span>
        </label>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-ps-kpi-row" aria-label="Summary">
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Deals shown</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : kpis.count}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Median EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.medianRatio)}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Best EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.bestRatio)}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Collection</div>
          <div className="rpc-ps-kpi-value rpc-ps-kpi-coll">{COLLECTION_LABEL[collection]}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-ps-table-wrap" aria-label="Pack deals">
        {error ? (
          <div className="rpc-ps-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ps-state">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="rpc-ps-state">
            No sealed packs are currently listed below their expected value
            {showHighVariance ? "" : " (try showing high-variance packs)"}. The
            market is efficient right now — check back later.
          </div>
        ) : (
          <table className="rpc-ps-table">
            <thead>
              <tr>
                <th className="rpc-ps-th-pack">Pack</th>
                <th className="rpc-ps-th-num">Tier</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">Live ask</th>
                <th className="rpc-ps-th-num">Gross EV</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">EV / ask</th>
                <th className="rpc-ps-th-num">FMV cov.</th>
                <th className="rpc-ps-th-act">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={`${collection}-${d.distId}`} className="rpc-ps-row">
                  <td className="rpc-ps-td-pack">
                    <Link href={d.detailHref} className="rpc-ps-pack-link">
                      {d.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.imageUrl} alt={d.title} className="rpc-ps-pack-img" loading="lazy" />
                      ) : (
                        <div className="rpc-ps-pack-img rpc-ps-pack-img-empty" aria-hidden="true" />
                      )}
                      <span className="rpc-ps-pack-meta">
                        <span className="rpc-ps-pack-title">{d.title.trim() || "—"}</span>
                        <span className="rpc-ps-pack-sub">
                          {d.slots} {d.slots === 1 ? "slot" : "slots"}
                          {d.highVariance ? (
                            <span
                              className="rpc-ps-hivar-chip"
                              title={`High variance: ${d.highVarianceReasons
                                .map((r) => VARIANCE_REASON_LABEL[r] ?? r)
                                .join(", ")}`}
                            >
                              HIGH VARIANCE
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="rpc-ps-td-num">
                    <span className="rpc-ps-tier-chip" style={{ color: tierColor(d.tier) }}>
                      {(d.tier ?? "—").toUpperCase()}
                    </span>
                  </td>
                  <td className="rpc-ps-td-num rpc-ps-td-emph">{fmtUsd(d.lowestAsk)}</td>
                  <td className="rpc-ps-td-num">{fmtUsd(d.grossEV)}</td>
                  <td className={`rpc-ps-td-num rpc-ps-td-emph ${d.highVariance ? "rpc-ps-td-hivar" : ""}`}>
                    {fmtRatio(d.liveValueRatio)}
                  </td>
                  <td className="rpc-ps-td-num">{d.fmvCoveragePct}%</td>
                  <td className="rpc-ps-td-act">
                    <a
                      href={d.buyUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="rpc-ps-act rpc-ps-act-buy"
                    >
                      View Listing ↗
                    </a>
                    {d.dapperUrl && d.dapperUrl !== d.buyUrl ? (
                      <a
                        href={d.dapperUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="rpc-ps-act"
                      >
                        dapper.market ↗
                      </a>
                    ) : null}
                    <Link href={d.simulatorHref} className="rpc-ps-act">
                      Simulate
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Footer / methodology ──────────────────────────────────────── */}
      <section className="rpc-ps-footer">
        <div className="rpc-ps-method">
          <h3 className="rpc-ps-h3">Methodology — read this</h3>
          <p>
            <strong>Gross EV</strong> is the <em>drop-weighted expectation</em>{" "}
            of a single pack&apos;s pull value, summed across the live drop pool
            using RPC&apos;s FMV. <strong>EV / ask</strong> = gross EV ÷ the live
            lowest secondary ask. We rank by EV / ask — the <em>ordering</em> is
            the signal, not the number.
          </p>
          <p>
            <strong>Variance is huge.</strong> EV is an average, not what you
            should expect to pull. A pack with one rare chase can show a high EV
            while the <em>typical</em> rip returns far less. We hide
            chance-hit / single-chase / heavily-depleted packs by default
            (toggle above) and flag them when shown. The{" "}
            <strong>Simulate</strong> link on every row shows the real outcome
            distribution — use it before buying.
          </p>
          <p>
            Only packs with ≥80% FMV coverage, an EV snapshot from the last 72h,
            and a live secondary listing appear here. EV / ask updates as the EV
            recomputes and the market moves; a deal can close before you click.
          </p>
        </div>
        <div className="rpc-ps-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ps-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-ps-back">
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
.rpc-ps-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ps-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ps-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ps-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ps-lede strong { color: var(--rpc-text-primary); }
.rpc-ps-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-ps-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ps-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-ps-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ps-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-ps-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ps-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ps-toggle { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-secondary); cursor: pointer; }
.rpc-ps-toggle input { accent-color: var(--rpc-red); width: 15px; height: 15px; cursor: pointer; }

.rpc-ps-kpi-row { max-width: 1180px; margin: 0 auto 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.rpc-ps-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-ps-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-ps-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-ps-kpi-coll { font-size: 20px; }

.rpc-ps-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-ps-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 1.5px; color: var(--rpc-text-muted); line-height: 1.6; }
.rpc-ps-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-ps-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 14px 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-ps-th-num { text-align: right; }
.rpc-ps-th-act { text-align: right; }
.rpc-ps-th-emph { color: var(--rpc-red); }
.rpc-ps-row { border-bottom: 1px solid var(--rpc-border-subtle); transition: background 100ms; }
.rpc-ps-row:hover { background: var(--rpc-surface-hover); }
.rpc-ps-table td { padding: 12px; vertical-align: middle; }
.rpc-ps-td-pack { min-width: 280px; }
.rpc-ps-pack-link { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
.rpc-ps-pack-img { width: 44px; height: 44px; object-fit: contain; border-radius: 3px; background: var(--rpc-black); flex-shrink: 0; }
.rpc-ps-pack-img-empty { border: 1px solid var(--rpc-border-subtle); }
.rpc-ps-pack-meta { display: flex; flex-direction: column; gap: 3px; }
.rpc-ps-pack-title { font-family: var(--font-body); font-weight: 700; font-size: 14px; color: var(--rpc-text-primary); line-height: 1.25; }
.rpc-ps-pack-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-text-muted); display: inline-flex; align-items: center; gap: 8px; }
.rpc-ps-hivar-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; color: var(--rpc-red); border: 1px solid var(--rpc-red-border); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-ps-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-ps-td-hivar { color: var(--rpc-text-muted); }
.rpc-ps-tier-chip { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }
.rpc-ps-td-act { text-align: right; white-space: nowrap; }
.rpc-ps-act { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; color: var(--rpc-text-secondary); padding: 6px 8px; border-radius: 2px; }
.rpc-ps-act:hover { color: var(--rpc-red); }
.rpc-ps-act-buy { color: var(--rpc-red); border: 1px solid var(--rpc-red-border); margin-right: 6px; }
.rpc-ps-act-buy:hover { background: var(--rpc-red); color: #fff; }

.rpc-ps-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-ps-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-ps-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-ps-method strong { color: var(--rpc-text-primary); }
.rpc-ps-method em { color: var(--rpc-text-primary); font-style: italic; }
.rpc-ps-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ps-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-ps-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ps-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ps-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-ps-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-ps-footer { grid-template-columns: 1fr; }
  .rpc-ps-table { font-size: 13px; }
  .rpc-ps-td-pack { min-width: 200px; }
}
`
