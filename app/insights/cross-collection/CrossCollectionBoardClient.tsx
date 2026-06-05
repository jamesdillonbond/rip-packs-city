"use client"

// app/insights/cross-collection/CrossCollectionBoardClient.tsx
//
// Client interactivity layer for the public Cross-Collection Whale Map. The
// server component (page.tsx) fetches the default-view cohort stats + ranked
// wallets + TS set overlap server-side and passes them in as `initial`, so the
// ranked tables + the set drill-down links render in the raw server HTML
// (crawlable) instead of only after JS. This component layers on sort as
// progressive enhancement and only refetches when the sort changes.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Stats = {
  cohort_size: number | null
  three_coll_wallets: number | null
  four_coll_wallets: number | null
  five_plus_coll_wallets: number | null
  cohort_total_moments: number | null
  avg_moments_per_wallet: number | null
  median_moments_per_wallet: number | null
  cohort_total_fmv_usd: number | null
} | null

type Wallet = {
  wallet_address: string
  n_collections: number | null
  total_moments: number | null
  ts_moments: number | null
  allday_moments: number | null
  golazos_moments: number | null
  pinnacle_moments: number | null
  ufc_moments: number | null
  approx_fmv_usd: number | null
}

type SetOverlapRow = {
  set_id: string
  set_name: string | null
  cohort_holders: number | null
  moments_in_cohort: number | null
}

export type ApiResponse = {
  meta: { fetched_at: string }
  stats: Stats
  wallets: Wallet[]
  ts_set_overlap: SetOverlapRow[]
}

type SortKey = "moments" | "fmv" | "n_coll" | "ts" | "allday" | "golazos" | "pinnacle" | "ufc"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${v.toFixed(0)}`
}
function shortAddr(a: string): string {
  if (!a) return "—"
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

function CollDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`rpc-cc-dot ${on ? "rpc-cc-dot-on" : ""}`} title={label} aria-label={label} />
  )
}

type Props = {
  initial: ApiResponse
}

export default function CrossCollectionBoardClient({ initial }: Props) {
  const [data, setData] = useState<ApiResponse | null>(initial)
  // Server already gave us the default (moments-desc) view — not "loading" on
  // first paint; loading only flips true on a sort refetch.
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>("moments")

  // Skip the very first fetch when params match the server-fetched default.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (sort === "moments") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(`/api/public/insights/cross-collection?sort=${sort}&limit=100`, {
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

  const stats = data?.stats
  const wallets = data?.wallets ?? []
  const overlap = data?.ts_set_overlap ?? []

  const tweetIntent = useMemo(() => {
    const text = `143 wallets hold 3+ Flow collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. The cross-collection cohort, no signup:`
    const url = `${SITE_URL}/insights/cross-collection`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-cc-hero">
        <div className="rpc-cc-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-cc-h1">Cross-Collection Whale Map</h1>
        <p className="rpc-cc-lede">
          {fmtInt(stats?.cohort_size)} wallets hold 3+ Flow blockchain
          collections — Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle,
          and UFC Strike. Top Shot&apos;s site can&apos;t surface this cohort
          because it doesn&apos;t cross collection boundaries. We can.
        </p>
      </section>

      <section className="rpc-cc-kpi-row" aria-label="Cohort summary">
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">Cohort size</div>
          <div className="rpc-cc-kpi-value">{fmtInt(stats?.cohort_size)}</div>
        </div>
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">3-collection</div>
          <div className="rpc-cc-kpi-value">{fmtInt(stats?.three_coll_wallets)}</div>
        </div>
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">4-collection</div>
          <div className="rpc-cc-kpi-value">{fmtInt(stats?.four_coll_wallets)}</div>
        </div>
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">5-collection</div>
          <div className="rpc-cc-kpi-value">{fmtInt(stats?.five_plus_coll_wallets)}</div>
        </div>
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">Cohort moments</div>
          <div className="rpc-cc-kpi-value">{fmtInt(stats?.cohort_total_moments)}</div>
        </div>
        <div className="rpc-cc-kpi">
          <div className="rpc-cc-kpi-label">Cohort FMV est.</div>
          <div className="rpc-cc-kpi-value">{fmtUsd(stats?.cohort_total_fmv_usd)}</div>
        </div>
      </section>

      <section className="rpc-cc-controls" aria-label="Sort">
        <span className="rpc-cc-pill-label">SORT</span>
        {[
          { v: "moments", l: "Total moments" },
          { v: "fmv", l: "Approx FMV" },
          { v: "n_coll", l: "# collections" },
          { v: "ts", l: "TS" },
          { v: "allday", l: "AllDay" },
          { v: "golazos", l: "Golazos" },
          { v: "pinnacle", l: "Pinnacle" },
          { v: "ufc", l: "UFC" },
        ].map((opt) => (
          <button
            key={opt.v}
            className={`rpc-cc-pill ${sort === opt.v ? "rpc-cc-pill-active" : ""}`}
            onClick={() => setSort(opt.v as SortKey)}
          >
            {opt.l}
          </button>
        ))}
      </section>

      <section className="rpc-cc-table-wrap" aria-label="Cohort wallets">
        {error ? (
          <div className="rpc-cc-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-cc-state">Loading…</div>
        ) : wallets.length === 0 ? (
          <div className="rpc-cc-state">No wallets found.</div>
        ) : (
          <table className="rpc-cc-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th className="rpc-cc-th-num">Coll</th>
                <th className="rpc-cc-th-num">Total</th>
                <th className="rpc-cc-th-num">TS</th>
                <th className="rpc-cc-th-num">AllDay</th>
                <th className="rpc-cc-th-num">Golazos</th>
                <th className="rpc-cc-th-num">Pinnacle</th>
                <th className="rpc-cc-th-num">UFC</th>
                <th className="rpc-cc-th-num rpc-cc-th-emph">Approx FMV</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => {
                const hasTs = Number(w.ts_moments ?? 0) > 0
                // The cohort is mostly anonymous Flow wallets (no RPC profile
                // bio), so the historical /profile/<hex> target 404'd. Route
                // the primary wallet click to a destination that actually
                // works: /insights/squeeze-check for wallets with a TS bag,
                // Flowscan for the rest. Tail-anchor by Flow address so the
                // chain reference always works.
                const primaryHref = hasTs
                  ? `/insights/squeeze-check?wallet=${encodeURIComponent(w.wallet_address)}`
                  : `https://www.flowscan.io/account/${encodeURIComponent(w.wallet_address)}`
                const primaryRel = hasTs ? undefined : "noopener noreferrer"
                const primaryTarget = hasTs ? undefined : "_blank"
                return (
                  <tr key={w.wallet_address}>
                    <td>
                      <Link
                        href={primaryHref}
                        className="rpc-cc-wallet-link"
                        title={
                          hasTs
                            ? `See ${shortAddr(w.wallet_address)}'s squeeze exposure`
                            : `${w.wallet_address} on Flowscan`
                        }
                        rel={primaryRel}
                        target={primaryTarget}
                      >
                        <span className="rpc-cc-wallet-addr">{shortAddr(w.wallet_address)}</span>
                        <span className="rpc-cc-dots" aria-label="Collections held">
                          <CollDot on={Number(w.ts_moments ?? 0) > 0} label="Top Shot" />
                          <CollDot on={Number(w.allday_moments ?? 0) > 0} label="AllDay" />
                          <CollDot on={Number(w.golazos_moments ?? 0) > 0} label="Golazos" />
                          <CollDot on={Number(w.pinnacle_moments ?? 0) > 0} label="Pinnacle" />
                          <CollDot on={Number(w.ufc_moments ?? 0) > 0} label="UFC" />
                        </span>
                      </Link>
                    </td>
                    <td className="rpc-cc-td-num">{fmtInt(w.n_collections)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.total_moments)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.ts_moments)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.allday_moments)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.golazos_moments)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.pinnacle_moments)}</td>
                    <td className="rpc-cc-td-num">{fmtInt(w.ufc_moments)}</td>
                    <td className="rpc-cc-td-num rpc-cc-td-emph">{fmtUsd(w.approx_fmv_usd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-cc-overlap">
        <h2 className="rpc-cc-h2">What the cohort collects on Top Shot</h2>
        <p className="rpc-cc-sub">
          Top {Math.min(overlap.length, 30)} TS sets ranked by cohort-holder count.
          What multi-collection collectors actually own.
        </p>
        {overlap.length === 0 ? (
          <div className="rpc-cc-state">{loading ? "Loading…" : "No overlap data."}</div>
        ) : (
          <table className="rpc-cc-table">
            <thead>
              <tr>
                <th>Set</th>
                <th className="rpc-cc-th-num">Cohort holders</th>
                <th className="rpc-cc-th-num">Cohort moments</th>
              </tr>
            </thead>
            <tbody>
              {overlap.map((o) => (
                <tr key={o.set_id}>
                  <td>
                    {o.set_name ? (
                      <div className="rpc-cc-set-cell">
                        <Link
                          href={`/insights/squeeze?set=${encodeURIComponent(o.set_name)}`}
                          className="rpc-cc-set-link"
                          title={`Drill into ${o.set_name} on the squeeze board`}
                        >
                          {o.set_name}
                          <span className="rpc-cc-drill-hint">squeeze →</span>
                        </Link>
                        <Link
                          href={`/insights/first-mint?set=${encodeURIComponent(o.set_name)}`}
                          className="rpc-cc-trophy-link"
                          title={`See first-mint trophies from ${o.set_name}`}
                        >
                          trophies →
                        </Link>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="rpc-cc-td-num rpc-cc-td-emph">{fmtInt(o.cohort_holders)}</td>
                  <td className="rpc-cc-td-num">{fmtInt(o.moments_in_cohort)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-cc-footer">
        <div className="rpc-cc-method">
          <h3 className="rpc-cc-h3">Methodology</h3>
          <p>
            <strong>Cohort</strong> = any wallet appearing in our wallet
            tracker with at least one moment in 3 or more Flow blockchain
            collections (out of the 5 currently published: Top Shot, All
            Day, Golazos, Pinnacle, UFC Strike). Cohort refreshes manually
            via a SECURITY DEFINER RPC.
          </p>
          <p>
            <strong>Approx FMV</strong> sums each moment&apos;s last-cached
            FMV in <code>wallet_moments_cache</code>. Per-collection FMV
            quality varies (TS / Pinnacle high; AllDay / Golazos / UFC
            sparser) so treat the column as a lower-bound indicator, not
            a portfolio valuation.
          </p>
        </div>
        <div className="rpc-cc-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-cc-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-cc-back">
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
.rpc-cc-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-cc-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-cc-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-cc-h2 { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 36px 0 8px; }
.rpc-cc-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-cc-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-cc-lede strong { color: var(--rpc-text-primary); }

.rpc-cc-kpi-row { max-width: 1180px; margin: 0 auto 18px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.rpc-cc-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-cc-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-cc-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 26px; color: var(--rpc-red); }

.rpc-cc-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-cc-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-cc-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-cc-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-cc-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-cc-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-cc-overlap { max-width: 1180px; margin: 0 auto; }
.rpc-cc-sub { font-size: 14px; line-height: 1.6; color: var(--rpc-text-secondary); margin: 0 0 14px; max-width: 760px; }
.rpc-cc-state { padding: 28px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-cc-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-cc-overlap .rpc-cc-table { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-cc-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-cc-th-num { text-align: right; }
.rpc-cc-th-emph { color: var(--rpc-red); }
.rpc-cc-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-cc-wallet-link { text-decoration: none; color: inherit; display: inline-flex; align-items: center; gap: 10px; }
.rpc-cc-wallet-link:hover .rpc-cc-wallet-addr { color: var(--rpc-red); }
.rpc-cc-wallet-addr { font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.5px; color: var(--rpc-text-primary); }
.rpc-cc-dots { display: inline-flex; gap: 4px; }
.rpc-cc-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.10); display: inline-block; }
.rpc-cc-dot-on { background: var(--rpc-red); }
.rpc-cc-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-cc-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-cc-set-cell { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rpc-cc-set-link { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }
.rpc-cc-set-link:hover { color: var(--rpc-red); }
.rpc-cc-drill-hint { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); opacity: 0.5; transition: color 100ms, opacity 100ms; }
.rpc-cc-set-link:hover .rpc-cc-drill-hint { color: var(--rpc-red); opacity: 1; }
.rpc-cc-trophy-link { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-decoration: none; padding: 4px 8px; border: 1px solid var(--rpc-border); border-radius: 2px; white-space: nowrap; opacity: 0.65; transition: color 100ms, border-color 100ms, opacity 100ms; }
.rpc-cc-trophy-link:hover { color: var(--rpc-red); border-color: var(--rpc-red); opacity: 1; }

.rpc-cc-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-cc-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-cc-method strong { color: var(--rpc-text-primary); }
.rpc-cc-method code { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-primary); }
.rpc-cc-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-cc-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-cc-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-cc-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-cc-back:hover { color: var(--rpc-red); }

@media (max-width: 880px) {
  .rpc-cc-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-cc-footer { grid-template-columns: 1fr; }
}
`
