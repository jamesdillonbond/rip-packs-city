"use client"

// app/insights/tc-report/page.tsx
//
// Public "Top Collector Report" tool — Surface I from the 2026-05-29 launch
// plan. Paste a Flow wallet and get a comprehensive bag analytics dashboard:
// squeeze exposure (shared with squeeze-check), top set completion,
// cross-collection breakdown, rookie + WNBA coverage, and recent
// acquisitions. Wraps the get_wallet_tc_report SECDEF RPC via the public
// /api/public/insights/tc-report route. Same wallet-paste trust model as
// squeeze-check.

import { useEffect, useState } from "react"
import Link from "next/link"

type Bucket = { editions: number; moments: number }
type Buckets = { liquid: Bucket; moderate: Bucket; squeezed: Bucket; extreme: Bucket }
type SqueezeTopRow = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  edition_key: string | null
  circulation: number | null
  locked: number | null
  burned: number | null
  squeeze_pct: number | null
  held: number | null
}
type Squeeze = {
  wallet: string
  collection: string
  total_moments: number
  total_editions: number
  editions_with_badge_coverage: number
  buckets: Buckets
  top_squeezed: SqueezeTopRow[]
  computed_at: string
}
type TopSet = {
  set_name: string
  owned_eds: number
  set_total_eds: number
  completion_pct: number
  total_moments_held: number
}
type WnbaCoverage = {
  per_set: { set_name: string; owned: number; total: number }[] | null
  sets_total: number
  sets_touched: number
  editions_owned: number
  editions_in_cohort_total: number
}
type RookieCoverage = {
  cohort_size: number
  owned_count: number
  best_holding: { player_name: string | null; edition_count: number } | null
}
type CrossCollection = {
  slug: string
  moments: number
  editions: number
  approx_fmv_usd: number | null
}
type RecentAcquisition = {
  edition_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  price_usd: number | null
  sold_at: string | null
}
type Report = {
  wallet: string
  computed_at: string
  squeeze: Squeeze
  top_sets: TopSet[]
  wnba_coverage: WnbaCoverage | null
  rookie_coverage: RookieCoverage | null
  cross_collection: CrossCollection[]
  recent_acquisitions: RecentAcquisition[]
} | null

const COLLECTION_LABEL: Record<string, string> = {
  nba_top_shot: "NBA Top Shot",
  nfl_all_day: "NFL All Day",
  laliga_golazos: "LaLiga Golazos",
  ufc_strike: "UFC Strike",
  disney_pinnacle: "Disney Pinnacle",
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
function pct(n: number | null | undefined, total: number | null | undefined): string {
  if (n == null || !total) return "—"
  return `${Math.round((Number(n) / Number(total)) * 100)}%`
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}
function fmtRelDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
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

export default function TcReportPage() {
  const [wallet, setWallet] = useState("")
  const [report, setReport] = useState<Report>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runCheck(rawWallet: string) {
    const w = rawWallet.trim().toLowerCase()
    if (!/^0x[a-f0-9]{16}$/.test(w)) {
      setError("Wallet must look like a Flow address — 0x + 16 hex chars.")
      return
    }
    setError(null)
    setLoading(true)
    try {
      const r = await fetch(`/api/public/insights/tc-report?wallet=${encodeURIComponent(w)}`, {
        cache: "no-store",
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      setReport(j.report)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  // Auto-load when a wallet is pre-filled via ?wallet= URL param (same
  // pattern as squeeze-check).
  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    const w = url.searchParams.get("wallet")
    if (w && /^0x[a-f0-9]{16}$/i.test(w)) {
      setWallet(w)
      runCheck(w)
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    await runCheck(wallet)
  }

  const sq = report?.squeeze
  const total = sq?.total_moments ?? 0
  const b = sq?.buckets
  const cc = report?.cross_collection ?? []
  const topSets = report?.top_sets ?? []
  const rookies = report?.rookie_coverage
  const wnba = report?.wnba_coverage
  const acq = report?.recent_acquisitions ?? []

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-tc-hero">
        <div className="rpc-tc-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-tc-h1">Top Collector Report</h1>
        <p className="rpc-tc-lede">
          Paste your Flow wallet. We pull squeeze exposure, set progress,
          cross-collection footprint, and rookie / WNBA cohort coverage in
          one shot. Top Shot&apos;s profile page shows you what you own. This
          shows you what it means.
        </p>
      </section>

      <section className="rpc-tc-form-wrap">
        <form className="rpc-tc-form" onSubmit={submit}>
          <input
            className="rpc-tc-input"
            type="text"
            placeholder="0x1234567890abcdef"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            aria-label="Flow wallet address"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="rpc-tc-btn" type="submit" disabled={loading}>
            {loading ? "Loading…" : "Run report"}
          </button>
        </form>
        {error ? <div className="rpc-tc-error">{error}</div> : null}
      </section>

      {report ? (
        <>
          {/* Squeeze section — mirrors squeeze-check */}
          <section className="rpc-tc-section">
            <h2 className="rpc-tc-h2">Squeeze Exposure</h2>
            <div className="rpc-tc-bar-row" aria-label="Exposure buckets">
              {b ? (
                <>
                  <BucketBar label="Liquid" sub="< 25% squeeze" value={b.liquid.moments} total={total} accent="success" />
                  <BucketBar label="Moderate" sub="25–50%" value={b.moderate.moments} total={total} accent="warn-soft" />
                  <BucketBar label="Squeezed" sub="50–75%" value={b.squeezed.moments} total={total} accent="warn" />
                  <BucketBar label="Extreme" sub="≥ 75%" value={b.extreme.moments} total={total} accent="danger" />
                </>
              ) : null}
            </div>
            <div className="rpc-tc-summary-line">
              <strong>{fmtInt(sq?.total_moments)}</strong> moments across{" "}
              <strong>{fmtInt(sq?.total_editions)}</strong> editions.{" "}
              {b ? (
                <>
                  Bag is {pct(b.liquid.moments, total)} liquid,{" "}
                  {pct((b.squeezed.moments ?? 0) + (b.extreme.moments ?? 0), total)} in squeeze territory.
                </>
              ) : null}
            </div>
            {sq?.top_squeezed && sq.top_squeezed.length > 0 ? (
              <table className="rpc-tc-table">
                <thead>
                  <tr>
                    <th>Edition</th>
                    <th className="rpc-tc-th-num">Tier</th>
                    <th className="rpc-tc-th-num">Held</th>
                    <th className="rpc-tc-th-num">Circ</th>
                    <th className="rpc-tc-th-num">Locked</th>
                    <th className="rpc-tc-th-num">Burned</th>
                    <th className="rpc-tc-th-num rpc-tc-th-emph">Squeeze</th>
                  </tr>
                </thead>
                <tbody>
                  {sq.top_squeezed.slice(0, 10).map((r) => (
                    <tr key={r.edition_key ?? Math.random()}>
                      <td className="rpc-tc-td-ed">
                        <div className="rpc-tc-ed-name">{r.player_name ?? "—"}</div>
                        <div className="rpc-tc-ed-set">{r.set_name ?? "—"}</div>
                      </td>
                      <td className="rpc-tc-td-num">
                        <span className="rpc-tc-tier" style={{ color: tierColor(r.tier) }}>
                          {r.tier ?? "—"}
                        </span>
                      </td>
                      <td className="rpc-tc-td-num">{fmtInt(r.held)}</td>
                      <td className="rpc-tc-td-num">{fmtInt(r.circulation)}</td>
                      <td className="rpc-tc-td-num">{fmtInt(r.locked)}</td>
                      <td className="rpc-tc-td-num">{fmtInt(r.burned)}</td>
                      <td className="rpc-tc-td-num rpc-tc-td-emph">{fmtPct(r.squeeze_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>

          {/* Cross-collection footprint */}
          {cc.length > 0 ? (
            <section className="rpc-tc-section">
              <h2 className="rpc-tc-h2">Cross-Collection Footprint</h2>
              <div className="rpc-tc-cc-grid">
                {cc.map((c) => (
                  <div key={c.slug} className="rpc-tc-cc-card">
                    <div className="rpc-tc-cc-label">{COLLECTION_LABEL[c.slug] ?? c.slug}</div>
                    <div className="rpc-tc-cc-val">{fmtInt(c.moments)}</div>
                    <div className="rpc-tc-cc-sub">moments · {fmtInt(c.editions)} editions</div>
                    {c.approx_fmv_usd != null ? (
                      <div className="rpc-tc-cc-fmv">≈ {fmtUsd(c.approx_fmv_usd)} FMV</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Top sets in progress */}
          {topSets.length > 0 ? (
            <section className="rpc-tc-section">
              <h2 className="rpc-tc-h2">Top Sets In Progress</h2>
              <table className="rpc-tc-table">
                <thead>
                  <tr>
                    <th>Set</th>
                    <th className="rpc-tc-th-num">Owned</th>
                    <th className="rpc-tc-th-num">Total</th>
                    <th className="rpc-tc-th-num">Moments</th>
                    <th className="rpc-tc-th-num rpc-tc-th-emph">Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {topSets.map((s) => (
                    <tr key={s.set_name}>
                      <td className="rpc-tc-td-ed">
                        <Link
                          href={`/insights/set-squeeze`}
                          className="rpc-tc-set-link"
                          title={`See ${s.set_name} on the set-squeeze board`}
                        >
                          {s.set_name}
                        </Link>
                      </td>
                      <td className="rpc-tc-td-num">{fmtInt(s.owned_eds)}</td>
                      <td className="rpc-tc-td-num">{fmtInt(s.set_total_eds)}</td>
                      <td className="rpc-tc-td-num">{fmtInt(s.total_moments_held)}</td>
                      <td className="rpc-tc-td-num rpc-tc-td-emph">{fmtPct(s.completion_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {/* Cohort coverage (rookies + WNBA) */}
          {rookies || wnba ? (
            <section className="rpc-tc-section">
              <h2 className="rpc-tc-h2">Cohort Coverage</h2>
              <div className="rpc-tc-cohort-grid">
                {rookies ? (
                  <div className="rpc-tc-cohort-card">
                    <div className="rpc-tc-cohort-label">Rookies (90d)</div>
                    <div className="rpc-tc-cohort-val">
                      {fmtInt(rookies.owned_count)}<span className="rpc-tc-cohort-of"> of {fmtInt(rookies.cohort_size)}</span>
                    </div>
                    {rookies.best_holding?.player_name ? (
                      <div className="rpc-tc-cohort-sub">
                        Deepest: {rookies.best_holding.player_name} ({fmtInt(rookies.best_holding.edition_count)} editions)
                      </div>
                    ) : (
                      <div className="rpc-tc-cohort-sub">No rookie editions held.</div>
                    )}
                  </div>
                ) : null}
                {wnba ? (
                  <div className="rpc-tc-cohort-card">
                    <div className="rpc-tc-cohort-label">WNBA Sets</div>
                    <div className="rpc-tc-cohort-val">
                      {fmtInt(wnba.sets_touched)}<span className="rpc-tc-cohort-of"> of {fmtInt(wnba.sets_total)}</span>
                    </div>
                    <div className="rpc-tc-cohort-sub">
                      {fmtInt(wnba.editions_owned)} editions held of {fmtInt(wnba.editions_in_cohort_total)} cohort total
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Recent acquisitions */}
          {acq.length > 0 ? (
            <section className="rpc-tc-section">
              <h2 className="rpc-tc-h2">Recent Acquisitions</h2>
              <table className="rpc-tc-table">
                <thead>
                  <tr>
                    <th>Edition</th>
                    <th className="rpc-tc-th-num">Tier</th>
                    <th className="rpc-tc-th-num">Price</th>
                    <th className="rpc-tc-th-num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {acq.map((a, i) => (
                    <tr key={a.edition_id ?? i}>
                      <td className="rpc-tc-td-ed">
                        {a.edition_id ? (
                          <Link href={`/moment/${a.edition_id}`} className="rpc-tc-set-link">
                            <div className="rpc-tc-ed-name">{a.player_name ?? "—"}</div>
                            <div className="rpc-tc-ed-set">{a.set_name ?? "—"}</div>
                          </Link>
                        ) : (
                          <>
                            <div className="rpc-tc-ed-name">{a.player_name ?? "—"}</div>
                            <div className="rpc-tc-ed-set">{a.set_name ?? "—"}</div>
                          </>
                        )}
                      </td>
                      <td className="rpc-tc-td-num">
                        <span className="rpc-tc-tier" style={{ color: tierColor(a.tier) }}>
                          {a.tier ?? "—"}
                        </span>
                      </td>
                      <td className="rpc-tc-td-num">{fmtUsd(a.price_usd)}</td>
                      <td className="rpc-tc-td-num">{fmtRelDate(a.sold_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : (
        <section className="rpc-tc-empty">
          <div className="rpc-tc-empty-text">
            Try one of these to see the shape:{" "}
            <button
              className="rpc-tc-sample-btn"
              onClick={() => setWallet("0xbd94cade097e50ac")}
              type="button"
            >
              Founder&apos;s wallet
            </button>
          </div>
        </section>
      )}

      <section className="rpc-tc-footer">
        <div className="rpc-tc-method">
          <h3 className="rpc-tc-h3">Methodology</h3>
          <p>
            <strong>Squeeze %</strong> = (locked + burned) / circulation, per
            edition. Buckets are moments-weighted. <strong>Completion %</strong>{" "}
            uses the canonical set catalog; sub-100% rolls into
            &quot;in progress&quot;. <strong>Recent acquisitions</strong> are
            sourced from our sales ingest — V1 Dapper buys from before the
            buyer-address backfill may not appear.
          </p>
          <p>
            <strong>Cohort coverage</strong> reflects 90d rookie GMV leaders
            and known WNBA sets. <strong>Cross-collection FMV</strong> uses
            each chain&apos;s native FMV snapshot table.
          </p>
        </div>
        <div className="rpc-tc-side">
          <Link href="/insights/squeeze-check" className="rpc-tc-back">
            ← Just the squeeze check
          </Link>
          <Link href="/insights" className="rpc-tc-back">
            More public insights →
          </Link>
        </div>
      </section>
    </main>
  )
}

function BucketBar({
  label,
  sub,
  value,
  total,
  accent,
}: {
  label: string
  sub: string
  value: number
  total: number
  accent: "success" | "warn-soft" | "warn" | "danger"
}) {
  const pctNum = total > 0 ? (value / total) * 100 : 0
  return (
    <div className={`rpc-tc-bucket rpc-tc-bucket-${accent}`}>
      <div className="rpc-tc-bucket-label">{label}</div>
      <div className="rpc-tc-bucket-sub">{sub}</div>
      <div className="rpc-tc-bucket-val">{value.toLocaleString("en-US")}</div>
      <div className="rpc-tc-bucket-pct">{pctNum.toFixed(1)}%</div>
      <div className="rpc-tc-bucket-track">
        <div className="rpc-tc-bucket-fill" style={{ width: `${Math.min(pctNum, 100)}%` }} />
      </div>
    </div>
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
.rpc-tc-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-tc-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-tc-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-tc-h2 { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0 0 18px; }
.rpc-tc-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-tc-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }

.rpc-tc-form-wrap { max-width: 1180px; margin: 0 auto 28px; }
.rpc-tc-form { display: flex; gap: 12px; flex-wrap: wrap; }
.rpc-tc-input { flex: 1; min-width: 240px; font-family: var(--font-mono); font-size: 16px; letter-spacing: 0.5px; padding: 14px 16px; background: var(--rpc-surface); border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); border-radius: 2px; }
.rpc-tc-input:focus { outline: none; border-color: var(--rpc-red); }
.rpc-tc-btn { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; background: var(--rpc-red); color: #fff; padding: 14px 26px; border: 0; border-radius: 2px; cursor: pointer; }
.rpc-tc-btn:hover { background: var(--rpc-red-hover); }
.rpc-tc-btn:disabled { opacity: 0.6; cursor: progress; }
.rpc-tc-error { margin-top: 10px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-danger); }

.rpc-tc-section { max-width: 1180px; margin: 0 auto 36px; }

.rpc-tc-bar-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.rpc-tc-bucket { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 16px; border-radius: 2px; display: flex; flex-direction: column; gap: 4px; }
.rpc-tc-bucket-success { border-left: 4px solid var(--rpc-success); }
.rpc-tc-bucket-warn-soft { border-left: 4px solid var(--rpc-warning); }
.rpc-tc-bucket-warn { border-left: 4px solid #FB923C; }
.rpc-tc-bucket-danger { border-left: 4px solid var(--rpc-red); }
.rpc-tc-bucket-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-tc-bucket-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; color: var(--rpc-text-muted); }
.rpc-tc-bucket-val { font-family: var(--font-display); font-weight: 800; font-size: 28px; color: var(--rpc-red); margin-top: 4px; }
.rpc-tc-bucket-pct { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-secondary); }
.rpc-tc-bucket-track { background: var(--rpc-surface); height: 4px; border-radius: 2px; overflow: hidden; margin-top: 4px; }
.rpc-tc-bucket-fill { height: 100%; background: var(--rpc-red); }

.rpc-tc-summary-line { font-size: 14px; line-height: 1.6; color: var(--rpc-text-secondary); margin-bottom: 18px; }
.rpc-tc-summary-line strong { color: var(--rpc-text-primary); font-family: var(--font-mono); }

.rpc-tc-table { width: 100%; border-collapse: collapse; font-size: 14px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-tc-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-tc-th-num { text-align: right; }
.rpc-tc-th-emph { color: var(--rpc-red); }
.rpc-tc-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-tc-td-ed { min-width: 240px; }
.rpc-tc-ed-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); }
.rpc-tc-ed-set { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-tc-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-tc-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-tc-tier { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }
.rpc-tc-set-link { color: var(--rpc-text-primary); text-decoration: none; }
.rpc-tc-set-link:hover { color: var(--rpc-red); }

.rpc-tc-cc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.rpc-tc-cc-card { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 18px; border-radius: 2px; }
.rpc-tc-cc-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-tc-cc-val { font-family: var(--font-display); font-weight: 800; font-size: 32px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-tc-cc-sub { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 4px; }
.rpc-tc-cc-fmv { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-secondary); letter-spacing: 1px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--rpc-border-subtle); }

.rpc-tc-cohort-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.rpc-tc-cohort-card { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 18px; border-radius: 2px; }
.rpc-tc-cohort-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-tc-cohort-val { font-family: var(--font-display); font-weight: 800; font-size: 32px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-tc-cohort-of { font-size: 18px; color: var(--rpc-text-secondary); font-weight: 400; }
.rpc-tc-cohort-sub { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 6px; }

.rpc-tc-empty { max-width: 1180px; margin: 0 auto; padding: 36px 0; text-align: center; }
.rpc-tc-empty-text { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; color: var(--rpc-text-muted); }
.rpc-tc-sample-btn { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-red); padding: 6px 12px; border-radius: 2px; cursor: pointer; margin-left: 6px; }
.rpc-tc-sample-btn:hover { border-color: var(--rpc-red); }

.rpc-tc-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-tc-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-tc-method strong { color: var(--rpc-text-primary); }
.rpc-tc-side { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-tc-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; border: 1px solid var(--rpc-border-subtle); border-radius: 2px; }
.rpc-tc-back:hover { color: var(--rpc-red); border-color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-tc-bar-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-tc-footer { grid-template-columns: 1fr; }
}
`
