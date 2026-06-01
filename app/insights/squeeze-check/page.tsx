"use client"

// app/insights/squeeze-check/page.tsx
//
// Public Wallet Squeeze Exposure tool — the "paste your wallet" demo from
// the 2026-05-29 launch plan Week 2. Anyone can paste a Flow wallet address
// and see how much of their TS collection is actually liquid vs locked /
// burned. No signup. Trust model is identical to nbatopshot.com/profile/<addr>
// (the user is naming the wallet themselves).

import { useEffect, useState } from "react"
import Link from "next/link"

type Bucket = { editions: number; moments: number }
type Buckets = { liquid: Bucket; moderate: Bucket; squeezed: Bucket; extreme: Bucket }
type TopRow = {
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
type Summary = {
  wallet: string
  collection: string
  total_moments: number
  total_editions: number
  editions_with_badge_coverage: number
  buckets: Buckets
  top_squeezed: TopRow[]
  computed_at: string
} | null

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function pct(n: number | null | undefined, total: number | null | undefined): string {
  if (n == null || !total) return "—"
  return `${Math.round((Number(n) / Number(total)) * 100)}%`
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

export default function SqueezeCheckPage() {
  const [wallet, setWallet] = useState("")
  const [summary, setSummary] = useState<Summary>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Shared fetcher so the form submit AND the URL-param auto-load can
  // reuse the same code path.
  async function runCheck(rawWallet: string) {
    const w = rawWallet.trim().toLowerCase()
    if (!/^0x[a-f0-9]{16}$/.test(w)) {
      setError("Wallet must look like a Flow address — 0x + 16 hex chars.")
      return
    }
    setError(null)
    setLoading(true)
    try {
      const r = await fetch(`/api/public/insights/squeeze-check?wallet=${encodeURIComponent(w)}`, {
        cache: "no-store",
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      setSummary(j.summary)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  // Auto-load when a wallet is pre-filled via ?wallet= URL param (used by
  // drill-down links from /insights/cross-collection wallet rows).
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

  const total = summary?.total_moments ?? 0
  const b = summary?.buckets

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-sc-hero">
        <div className="rpc-sc-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-sc-h1">What&apos;s Liquid In Your Bag?</h1>
        <p className="rpc-sc-lede">
          Paste your Flow wallet. We&apos;ll show you how much of your Top
          Shot collection is actually liquid vs how much is sitting in
          challenge-locked or burned editions. Top Shot&apos;s site doesn&apos;t
          do this. We do.
        </p>
      </section>

      <section className="rpc-sc-form-wrap">
        <form className="rpc-sc-form" onSubmit={submit}>
          <input
            className="rpc-sc-input"
            type="text"
            placeholder="0x1234567890abcdef"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            aria-label="Flow wallet address"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="rpc-sc-btn" type="submit" disabled={loading}>
            {loading ? "Checking…" : "Check exposure"}
          </button>
        </form>
        {error ? <div className="rpc-sc-error">{error}</div> : null}
      </section>

      {summary ? (
        <>
          <section className="rpc-sc-bar-row" aria-label="Exposure buckets">
            {b ? (
              <>
                <BucketBar label="Liquid" sub="< 25% squeeze" value={b.liquid.moments} total={total} accent="success" />
                <BucketBar label="Moderate" sub="25–50%" value={b.moderate.moments} total={total} accent="warn-soft" />
                <BucketBar label="Squeezed" sub="50–75%" value={b.squeezed.moments} total={total} accent="warn" />
                <BucketBar label="Extreme" sub="≥ 75%" value={b.extreme.moments} total={total} accent="danger" />
              </>
            ) : null}
          </section>

          <section className="rpc-sc-summary">
            <div className="rpc-sc-summary-line">
              <strong>{fmtInt(summary.total_moments)}</strong> moments across{" "}
              <strong>{fmtInt(summary.total_editions)}</strong> editions.{" "}
              {summary.editions_with_badge_coverage > 0 ? (
                <>
                  {fmtInt(summary.editions_with_badge_coverage)} have current lock/burn data
                  ({pct(summary.editions_with_badge_coverage, summary.total_editions)}).{" "}
                </>
              ) : null}
              {b
                ? `Bag is ${pct(b.liquid.moments, total)} liquid, ${pct(
                    (b.squeezed.moments ?? 0) + (b.extreme.moments ?? 0),
                    total
                  )} sitting in squeeze territory.`
                : null}
            </div>
          </section>

          <section className="rpc-sc-top">
            <h2 className="rpc-sc-h2">Your top squeezed holdings</h2>
            {summary.top_squeezed.length === 0 ? (
              <div className="rpc-sc-state">
                Nothing in your bag is over 0% squeezed. Either no badge coverage on your editions
                yet, or you&apos;ve dodged every challenge so far.
              </div>
            ) : (
              <div className="rpc-scroll-x">
              <table className="rpc-sc-table">
                <thead>
                  <tr>
                    <th>Edition</th>
                    <th className="rpc-sc-th-num">Tier</th>
                    <th className="rpc-sc-th-num">Held</th>
                    <th className="rpc-sc-th-num">Circ</th>
                    <th className="rpc-sc-th-num">Locked</th>
                    <th className="rpc-sc-th-num">Burned</th>
                    <th className="rpc-sc-th-num rpc-sc-th-emph">Squeeze</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.top_squeezed.map((r) => (
                    <tr key={r.edition_key ?? Math.random()}>
                      <td className="rpc-sc-td-ed">
                        <div className="rpc-sc-ed-name">{r.player_name ?? "—"}</div>
                        <div className="rpc-sc-ed-set">{r.set_name ?? "—"}</div>
                      </td>
                      <td className="rpc-sc-td-num">
                        <span className="rpc-sc-tier" style={{ color: tierColor(r.tier) }}>
                          {r.tier ?? "—"}
                        </span>
                      </td>
                      <td className="rpc-sc-td-num">{fmtInt(r.held)}</td>
                      <td className="rpc-sc-td-num">{fmtInt(r.circulation)}</td>
                      <td className="rpc-sc-td-num">{fmtInt(r.locked)}</td>
                      <td className="rpc-sc-td-num">{fmtInt(r.burned)}</td>
                      <td className="rpc-sc-td-num rpc-sc-td-emph">{fmtPct(r.squeeze_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="rpc-sc-empty">
          <div className="rpc-sc-empty-text">
            Try one of these to see the shape:{" "}
            <button
              className="rpc-sc-sample-btn"
              onClick={() => setWallet("0xbd94cade097e50ac")}
              type="button"
            >
              Founder&apos;s wallet
            </button>
          </div>
        </section>
      )}

      <section className="rpc-sc-footer">
        <div className="rpc-sc-method">
          <h3 className="rpc-sc-h3">Methodology</h3>
          <p>
            <strong>Squeeze %</strong> = (locked + burned) / circulation, per
            edition. Buckets are moments-weighted (a 50× duplicate of one
            edition reads as 50, not 1). Editions without badge coverage are
            treated as liquid by default — when challenge data lands they may
            re-bucket.
          </p>
          <p>
            <strong>What this misses:</strong> AllDay, Golazos, Pinnacle, and
            UFC moments aren&apos;t in this view yet. Top Shot only for now.
          </p>
        </div>
        <div className="rpc-sc-side">
          <Link href="/insights" className="rpc-sc-back">
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
    <div className={`rpc-sc-bucket rpc-sc-bucket-${accent}`}>
      <div className="rpc-sc-bucket-label">{label}</div>
      <div className="rpc-sc-bucket-sub">{sub}</div>
      <div className="rpc-sc-bucket-val">{value.toLocaleString("en-US")}</div>
      <div className="rpc-sc-bucket-pct">{pctNum.toFixed(1)}%</div>
      <div className="rpc-sc-bucket-track">
        <div className="rpc-sc-bucket-fill" style={{ width: `${Math.min(pctNum, 100)}%` }} />
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
.rpc-sc-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-sc-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-sc-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-sc-h2 { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 36px 0 16px; }
.rpc-sc-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-sc-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-sc-lede strong { color: var(--rpc-text-primary); }

.rpc-sc-form-wrap { max-width: 1180px; margin: 0 auto 24px; }
.rpc-sc-form { display: flex; gap: 12px; flex-wrap: wrap; }
.rpc-sc-input { flex: 1; min-width: 240px; font-family: var(--font-mono); font-size: 16px; letter-spacing: 0.5px; padding: 14px 16px; background: var(--rpc-surface); border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); border-radius: 2px; }
.rpc-sc-input:focus { outline: none; border-color: var(--rpc-red); }
.rpc-sc-btn { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; background: var(--rpc-red); color: #fff; padding: 14px 26px; border: 0; border-radius: 2px; cursor: pointer; }
.rpc-sc-btn:hover { background: var(--rpc-red-hover); }
.rpc-sc-btn:disabled { opacity: 0.6; cursor: progress; }
.rpc-sc-error { margin-top: 10px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-danger); }

.rpc-sc-bar-row { max-width: 1180px; margin: 0 auto 24px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.rpc-sc-bucket { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 16px; border-radius: 2px; display: flex; flex-direction: column; gap: 4px; }
.rpc-sc-bucket-success { border-left: 4px solid var(--rpc-success); }
.rpc-sc-bucket-warn-soft { border-left: 4px solid var(--rpc-warning); }
.rpc-sc-bucket-warn { border-left: 4px solid #FB923C; }
.rpc-sc-bucket-danger { border-left: 4px solid var(--rpc-red); }
.rpc-sc-bucket-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-sc-bucket-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; color: var(--rpc-text-muted); }
.rpc-sc-bucket-val { font-family: var(--font-display); font-weight: 800; font-size: 28px; color: var(--rpc-red); margin-top: 4px; }
.rpc-sc-bucket-pct { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-secondary); }
.rpc-sc-bucket-track { background: var(--rpc-surface); height: 4px; border-radius: 2px; overflow: hidden; margin-top: 4px; }
.rpc-sc-bucket-fill { height: 100%; background: var(--rpc-red); }

.rpc-sc-summary { max-width: 1180px; margin: 0 auto 12px; }
.rpc-sc-summary-line { font-size: 14px; line-height: 1.6; color: var(--rpc-text-secondary); }
.rpc-sc-summary-line strong { color: var(--rpc-text-primary); font-family: var(--font-mono); }

.rpc-sc-top { max-width: 1180px; margin: 0 auto; }
.rpc-sc-state { padding: 28px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); }
.rpc-sc-table { width: 100%; border-collapse: collapse; font-size: 14px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-sc-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-sc-th-num { text-align: right; }
.rpc-sc-th-emph { color: var(--rpc-red); }
.rpc-sc-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-sc-td-ed { min-width: 240px; }
.rpc-sc-ed-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); }
.rpc-sc-ed-set { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-sc-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-sc-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-sc-tier { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }

.rpc-sc-empty { max-width: 1180px; margin: 0 auto; padding: 36px 0; text-align: center; }
.rpc-sc-empty-text { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; color: var(--rpc-text-muted); }
.rpc-sc-sample-btn { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-red); padding: 6px 12px; border-radius: 2px; cursor: pointer; margin-left: 6px; }
.rpc-sc-sample-btn:hover { border-color: var(--rpc-red); }

.rpc-sc-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-sc-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-sc-method strong { color: var(--rpc-text-primary); }
.rpc-sc-side { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-sc-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-sc-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-sc-bar-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-sc-footer { grid-template-columns: 1fr; }
}
`
