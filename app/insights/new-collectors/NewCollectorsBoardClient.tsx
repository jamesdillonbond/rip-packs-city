"use client"

// app/insights/new-collectors/NewCollectorsBoardClient.tsx
//
// Client interactivity layer for the public New Collectors board. The server
// component (page.tsx) fetches the entire board (all three windows + the cohort
// series) and passes it in as `initialBoard`, so the acquisition headline, spend
// mix, gateway lists (with drill-down links), and the cohort table render in the
// raw server HTML (crawlable — the SEO thesis). The whole board arrives at once,
// so the window toggle just selects the loaded window locally; there is no
// refetch.
//
// COVERAGE HONESTY (surfaced on the page, not buried): active/returning/market-$
// and composition are reliable for recent windows; the new-collector COUNT is
// directional (partial historical buyer coverage). The page leads with the
// debiased count + the accurate metrics and carries the caveat inline + in the
// methodology footer.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { slugifyName } from "@/lib/entity-labels"
import type {
  NewCollectorsBoard,
  NCWindow,
  NCSummaryRow,
  NCSpendRow,
  NCGatewayRow,
  NCCohortRow,
} from "@/lib/new-collectors-board"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const WINDOWS: { val: NCWindow; label: string }[] = [
  { val: "7d", label: "7 days" },
  { val: "30d", label: "30 days" },
  { val: "90d", label: "90 days" },
]

const COHORT_DEFAULT_MONTHS = 15

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtMoneyCompact(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}

function fmtDays(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}d`
}

function cohortLabel(month: string): string {
  // month is a 'YYYY-MM-01' date string.
  const d = new Date(`${month.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return month
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

const SET_HUB = (name: string) =>
  `/nba-top-shot/set/${encodeURIComponent(slugifyName(name))}`
const PLAYER_HUB = (name: string) =>
  `/nba-top-shot/player/${encodeURIComponent(slugifyName(name))}`

const SPEND_BUCKETS: { key: keyof NCSpendRow; label: string }[] = [
  { key: "b_lt5", label: "< $5" },
  { key: "b_5_25", label: "$5–25" },
  { key: "b_25_100", label: "$25–100" },
  { key: "b_100_500", label: "$100–500" },
  { key: "b_500plus", label: "$500+" },
]

type Props = {
  initialBoard: NewCollectorsBoard
  initialFetchedAt: string | null
}

export default function NewCollectorsBoardClient({ initialBoard, initialFetchedAt }: Props) {
  const board = initialBoard
  const [window, setWindow] = useState<NCWindow>("30d")
  const [showAllCohorts, setShowAllCohorts] = useState(false)

  // Referral attribution on copy-link for signed-in sharers (same loop as the
  // other public boards). /api/profile/me returns { user: null } for anon.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/profile/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMyUserId(data?.user?.id ?? null))
      .catch(() => {})
  }, [])

  const summary: NCSummaryRow | null = useMemo(
    () => board.summary.find((s) => s.window_label === window) ?? null,
    [board.summary, window]
  )
  const spend: NCSpendRow | null = useMemo(
    () => board.spend.find((s) => s.window_label === window) ?? null,
    [board.spend, window]
  )

  // Gateway only has 30d + 90d windows; the 7d toggle reflects the 30d gateway.
  const gatewayWindow = window === "90d" ? "90d" : "30d"
  const gateway = board.gateway[gatewayWindow] ?? { sets: [], players: [] }

  const cohortsDesc = board.cohorts // already sorted desc by the lib
  const visibleCohorts = showAllCohorts
    ? cohortsDesc
    : cohortsDesc.slice(0, COHORT_DEFAULT_MONTHS)

  const newSharePct =
    summary && summary.market_usd > 0
      ? (summary.new_usd / summary.market_usd) * 100
      : null

  const computedAtLabel = board.computed_at
    ? new Date(board.computed_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : initialFetchedAt
      ? new Date(initialFetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : "—"

  const shareUrl = `${SITE_URL}/insights/new-collectors`
  const tweetIntent = useMemo(() => {
    const text =
      "Who's actually entering NBA Top Shot right now — new vs returning buyers, what they buy first, and how cohorts retain.\n\nNew Collectors:"
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  }, [shareUrl])
  const copyUrl = myUserId ? `${shareUrl}?ref=${encodeURIComponent(myUserId)}` : shareUrl
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(copyUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard can be blocked — non-fatal */
    }
  }

  const spendMax = spend
    ? Math.max(spend.b_lt5, spend.b_5_25, spend.b_25_100, spend.b_100_500, spend.b_500plus, 1)
    : 1

  const hasData = board.summary.length > 0

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-nc-head">
        <div className="rpc-nc-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-nc-h1">New Collectors</h1>
        <p className="rpc-nc-lede">
          Who is <strong>actually entering</strong> NBA Top Shot — new vs returning
          buyers, what they pay for their first moment, the sets and players they
          pick first, and how each monthly cohort <strong>retains and spends</strong>.
          Built from buyer-resolved on-chain sales — the acquisition picture
          nbatopshot.com doesn&apos;t show you.
        </p>
        <div className="rpc-nc-meta-row">
          <span className="rpc-nc-meta">Updated {computedAtLabel}</span>
          <span className="rpc-nc-meta-sep">·</span>
          <span className="rpc-nc-meta">NBA Top Shot</span>
          <span className="rpc-nc-meta-sep">·</span>
          <span className="rpc-nc-meta">No signup</span>
        </div>
      </section>

      {!hasData ? (
        <section className="rpc-nc-wrap">
          <div className="rpc-nc-state">The board is refreshing — check back shortly.</div>
        </section>
      ) : (
        <>
          <section className="rpc-nc-controls" aria-label="Window">
            <div className="rpc-nc-pill-group" role="tablist" aria-label="Window">
              <span className="rpc-nc-pill-label">WINDOW</span>
              {WINDOWS.map((w) => (
                <button
                  key={w.val}
                  role="tab"
                  aria-selected={window === w.val}
                  className={`rpc-nc-pill ${window === w.val ? "rpc-nc-pill-active" : ""}`}
                  onClick={() => setWindow(w.val)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </section>

          {/* ACQUISITION */}
          <section className="rpc-nc-wrap" aria-label="Acquisition">
            <div className="rpc-nc-section-label">Acquisition · last {window}</div>
            <div className="rpc-nc-kpi-row">
              <div className="rpc-nc-kpi">
                <div className="rpc-nc-kpi-label">Active buyers</div>
                <div className="rpc-nc-kpi-value">{fmtInt(summary?.active_buyers)}</div>
                <div className="rpc-nc-kpi-sub">made ≥1 buy in window</div>
              </div>
              <div className="rpc-nc-kpi">
                <div className="rpc-nc-kpi-label">New collectors</div>
                <div className="rpc-nc-kpi-value">{fmtInt(summary?.new_debiased)}</div>
                <div className="rpc-nc-kpi-sub">
                  {fmtInt(summary?.new_first_seen)} first-seen · directional
                </div>
              </div>
              <div className="rpc-nc-kpi">
                <div className="rpc-nc-kpi-label">Returning buyers</div>
                <div className="rpc-nc-kpi-value">{fmtInt(summary?.returning_buyers)}</div>
                <div className="rpc-nc-kpi-sub">bought before this window</div>
              </div>
              <div className="rpc-nc-kpi">
                <div className="rpc-nc-kpi-label">New $ share</div>
                <div className="rpc-nc-kpi-value">{fmtPct(newSharePct)}</div>
                <div className="rpc-nc-kpi-sub">
                  {fmtMoneyCompact(summary?.new_usd)} of {fmtMoneyCompact(summary?.market_usd)}
                </div>
              </div>
            </div>
            <p className="rpc-nc-caption">
              New-collector counts are a directional lower bound — see methodology. Active
              buyers, returning buyers and market $ are reliable for recent windows.
            </p>
          </section>

          {/* SPEND */}
          <section className="rpc-nc-wrap" aria-label="First-buy spend">
            <div className="rpc-nc-section-label">First-buy spend · last {window}</div>
            <div className="rpc-nc-spend-grid">
              <div className="rpc-nc-spend-cards">
                <div className="rpc-nc-kpi">
                  <div className="rpc-nc-kpi-label">Median first buy</div>
                  <div className="rpc-nc-kpi-value">{fmtMoney(summary?.median_first_buy)}</div>
                </div>
                <div className="rpc-nc-kpi">
                  <div className="rpc-nc-kpi-label">Avg first buy</div>
                  <div className="rpc-nc-kpi-value">{fmtMoney(summary?.avg_first_buy)}</div>
                </div>
              </div>
              <div className="rpc-nc-hist">
                <div className="rpc-nc-hist-title">
                  What new collectors paid for their first moment
                </div>
                {SPEND_BUCKETS.map((b) => {
                  const count = spend ? (spend[b.key] as number) : 0
                  const pct = spend && spend.total_new > 0 ? (count / spend.total_new) * 100 : 0
                  const w = Math.max(2, (count / spendMax) * 100)
                  return (
                    <div className="rpc-nc-hist-row" key={b.key}>
                      <div className="rpc-nc-hist-label">{b.label}</div>
                      <div className="rpc-nc-hist-bar-track">
                        <div className="rpc-nc-hist-bar" style={{ width: `${w}%` }} />
                      </div>
                      <div className="rpc-nc-hist-count">
                        {fmtInt(count)} <span className="rpc-nc-hist-pct">({pct.toFixed(0)}%)</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          {/* GATEWAY */}
          <section className="rpc-nc-wrap" aria-label="Gateway sets and players">
            <div className="rpc-nc-section-label">
              Gateway · what new collectors buy first · last {gatewayWindow}
            </div>
            <div className="rpc-nc-gateway-grid">
              <GatewayList title="Gateway sets" rows={gateway.sets} kind="set" />
              <GatewayList title="Gateway players" rows={gateway.players} kind="player" />
            </div>
          </section>

          {/* COHORTS */}
          <section className="rpc-nc-wrap" aria-label="Monthly cohorts">
            <div className="rpc-nc-section-label">Monthly cohorts · retention &amp; LTV</div>
            <div className="rpc-nc-table-scroll">
              <table className="rpc-nc-table">
                <thead>
                  <tr>
                    <th className="rpc-nc-th-left">Cohort</th>
                    <th>Size</th>
                    <th>Repeat 30d</th>
                    <th>Repeat 60d</th>
                    <th>Repeat 90d</th>
                    <th>LTV (median)</th>
                    <th>Whales</th>
                    <th>Days to 10th</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCohorts.map((c: NCCohortRow) => (
                    <tr key={c.cohort_month}>
                      <td className="rpc-nc-td-left">{cohortLabel(c.cohort_month)}</td>
                      <td>{fmtInt(c.cohort_size)}</td>
                      <td>{fmtPct(c.repeat_30d_pct)}</td>
                      <td>{fmtPct(c.repeat_60d_pct)}</td>
                      <td>{fmtPct(c.repeat_90d_pct)}</td>
                      <td>{fmtMoney(c.ltv_median)}</td>
                      <td>{fmtInt(c.whales)}</td>
                      <td>{fmtDays(c.median_days_to_10th)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cohortsDesc.length > COHORT_DEFAULT_MONTHS ? (
              <button className="rpc-nc-showall" onClick={() => setShowAllCohorts((v) => !v)}>
                {showAllCohorts
                  ? "Show recent cohorts"
                  : `Show all cohorts (back to ${cohortLabel(cohortsDesc[cohortsDesc.length - 1].cohort_month)})`}
              </button>
            ) : null}
            <p className="rpc-nc-caption">
              Cohort = wallets whose first observed marketplace buy fell in that month.
              <strong> Retention and LTV are reliable</strong>; cohort <em>size</em> for
              older months undercounts (those buyers&apos; first buys predate full buyer
              resolution) and rises as the deep-history backfill lands.
            </p>
          </section>

          {/* METHODOLOGY + SHARE */}
          <section className="rpc-nc-footer">
            <div className="rpc-nc-method">
              <h3 className="rpc-nc-h3">How this is measured</h3>
              <p>
                A <strong>new collector</strong> is a wallet&apos;s first observed
                marketplace buy. Buyer identity is resolved from on-chain sales, so
                coverage is near-complete for recent windows and partial before 2026.
                That means <strong>active buyers, returning buyers, market $</strong> and
                all composition (spend mix, gateway sets/players, cohort retention &amp;
                LTV) are reliable, while the absolute <strong>new-collector count</strong>{" "}
                is a directional lower bound that self-corrects as historical buyer
                resolution backfills. Refreshed daily.
              </p>
              <p className="rpc-nc-fresh">Data computed {computedAtLabel}.</p>
            </div>
            <div className="rpc-nc-share">
              <a
                href={tweetIntent}
                target="_blank"
                rel="noopener noreferrer"
                className="rpc-nc-share-btn"
              >
                Share on Twitter
              </a>
              <button type="button" onClick={copyLink} className="rpc-nc-copy-btn">
                {copied ? "Copied!" : "Copy link"}
              </button>
              <Link href="/insights" className="rpc-nc-back">
                More public insights →
              </Link>
            </div>
          </section>
        </>
      )}
    </main>
  )
}

function GatewayList({
  title,
  rows,
  kind,
}: {
  title: string
  rows: NCGatewayRow[]
  kind: "set" | "player"
}) {
  return (
    <div className="rpc-nc-gateway">
      <div className="rpc-nc-gateway-title">{title}</div>
      {rows.length === 0 ? (
        <div className="rpc-nc-gateway-empty">No data in this window.</div>
      ) : (
        <ol className="rpc-nc-gateway-list">
          {rows.map((r) => {
            const href = kind === "set" ? SET_HUB(r.name) : PLAYER_HUB(r.name)
            return (
              <li key={`${r.kind}-${r.rnk}-${r.name}`} className="rpc-nc-gateway-row">
                <span className="rpc-nc-gateway-rank">{r.rnk}</span>
                <Link href={href} className="rpc-nc-gateway-name">
                  {r.name || "—"}
                  {kind === "set" && r.series != null ? (
                    <span className="rpc-nc-gateway-series">S{r.series}</span>
                  ) : null}
                </Link>
                <span className="rpc-nc-gateway-buyers">{fmtInt(r.buyers)}</span>
              </li>
            )
          })}
        </ol>
      )}
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
.rpc-nc-head { max-width: 1180px; margin: 0 auto 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-nc-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-nc-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-nc-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 860px; margin: 0 0 16px; }
.rpc-nc-lede strong { color: var(--rpc-text-primary); }
.rpc-nc-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-nc-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-nc-controls { max-width: 1180px; margin: 0 auto 22px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-nc-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-nc-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-nc-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-nc-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-nc-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-nc-wrap { max-width: 1180px; margin: 0 auto 30px; }
.rpc-nc-section-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 12px; }
.rpc-nc-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-nc-caption { font-family: var(--font-body); font-size: 12.5px; line-height: 1.55; color: var(--rpc-text-muted); margin: 14px 0 0; }
.rpc-nc-caption strong { color: var(--rpc-text-secondary); }

.rpc-nc-kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.rpc-nc-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-nc-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-nc-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; line-height: 1.1; }
.rpc-nc-kpi-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-text-muted); margin-top: 6px; }

.rpc-nc-spend-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; align-items: stretch; }
.rpc-nc-spend-cards { display: grid; grid-template-rows: 1fr 1fr; gap: 12px; }
.rpc-nc-hist { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); padding: 16px 18px; border-radius: 2px; display: flex; flex-direction: column; gap: 10px; }
.rpc-nc-hist-title { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 4px; }
.rpc-nc-hist-row { display: grid; grid-template-columns: 76px minmax(0, 1fr) 110px; align-items: center; gap: 12px; }
.rpc-nc-hist-label { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-secondary); }
.rpc-nc-hist-bar-track { height: 16px; background: var(--rpc-surface-raised); border-radius: 2px; overflow: hidden; }
.rpc-nc-hist-bar { height: 100%; background: var(--rpc-red); border-radius: 2px; transition: width 200ms; }
.rpc-nc-hist-count { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-primary); text-align: right; }
.rpc-nc-hist-pct { color: var(--rpc-text-muted); }

.rpc-nc-gateway-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.rpc-nc-gateway { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; padding: 16px 18px; }
.rpc-nc-gateway-title { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); margin-bottom: 12px; }
.rpc-nc-gateway-empty { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-muted); padding: 12px 0; }
.rpc-nc-gateway-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rpc-nc-gateway-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--rpc-border-subtle); }
.rpc-nc-gateway-row:first-child { border-top: none; }
.rpc-nc-gateway-rank { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-muted); text-align: center; }
.rpc-nc-gateway-name { font-family: var(--font-body); font-size: 14px; font-weight: 600; color: var(--rpc-text-primary); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: baseline; gap: 8px; }
.rpc-nc-gateway-name:hover { color: var(--rpc-red); }
.rpc-nc-gateway-series { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-text-muted); }
.rpc-nc-gateway-buyers { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--rpc-text-primary); white-space: nowrap; }

.rpc-nc-table-scroll { overflow-x: auto; border: 1px solid var(--rpc-border-subtle); border-radius: 2px; }
.rpc-nc-table { width: 100%; border-collapse: collapse; min-width: 720px; }
.rpc-nc-table thead th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: right; padding: 11px 14px; background: var(--rpc-surface-raised); border-bottom: 1px solid var(--rpc-border-subtle); white-space: nowrap; }
.rpc-nc-table th.rpc-nc-th-left { text-align: left; }
.rpc-nc-table tbody td { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-primary); text-align: right; padding: 9px 14px; border-top: 1px solid var(--rpc-border-subtle); white-space: nowrap; }
.rpc-nc-table tbody td.rpc-nc-td-left { text-align: left; font-family: var(--font-body); font-weight: 600; }
.rpc-nc-table tbody tr:hover { background: var(--rpc-surface); }
.rpc-nc-showall { margin-top: 14px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; padding: 10px 16px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms; }
.rpc-nc-showall:hover { border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-nc-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-nc-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-nc-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-nc-method strong { color: var(--rpc-text-primary); }
.rpc-nc-fresh { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; color: var(--rpc-text-muted); }
.rpc-nc-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-nc-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-nc-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-nc-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-nc-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-nc-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-nc-back:hover { color: var(--rpc-red); }

@media (max-width: 860px) {
  .rpc-nc-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-nc-spend-grid { grid-template-columns: 1fr; }
  .rpc-nc-gateway-grid { grid-template-columns: 1fr; }
  .rpc-nc-footer { grid-template-columns: 1fr; }
}
`
