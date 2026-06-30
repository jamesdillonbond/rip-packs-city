"use client"

// app/insights/pack-drops/PackDropsBoardClient.tsx
//
// Client presentation layer for the public Pack Drops board. The server
// component (page.tsx) discovers + scores the live Vaultopolis re-pack drops and
// passes them in as `initialDrops`, so the scored RPC-vs-operator tables render
// in the raw server HTML (crawlable — the SEO thesis). This component layers a
// refresh + light interactivity on top.
//
// The differentiator: every drop is scored against RPC FMV — RPC pool, pack EV
// vs the FLOW listing price, value concentration, matched-count — the
// "is this re-pack worth it?" read no marketplace ships. Honest about what RPC
// can't price yet: parallel/subedition chases are priced at the BASE edition
// level (the parallel premium is the serial-FMV layer's job), and a name/set
// mismatch can miss an edition — both flagged, never papered over.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import type { ScoredDrop, ScoredEdition } from "@/lib/pack-drops-board"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type ApiResponse = {
  meta: { fetched_at: string; total_drops: number; elapsed_ms: number }
  drops: ScoredDrop[]
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (!Number.isFinite(v)) return "—"
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function fmtFlow(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (!Number.isFinite(v)) return "—"
  const s = v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)
  return `${s} FLOW`
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(0)}%`
}

function fmtProb(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${(Number(n) * 100).toFixed(1)}%`
}

function confidenceColor(c: string | null): string {
  switch ((c ?? "").toUpperCase()) {
    case "HIGH":
      return "var(--rpc-success)"
    case "MEDIUM":
      return "var(--rpc-text-primary)"
    case "LOW":
    case "STALE":
      return "var(--rpc-warning)"
    case "ASK_ONLY":
    case "SALES_ONLY":
      return "var(--rpc-text-secondary)"
    default:
      return "var(--rpc-text-muted)"
  }
}

function verdictColor(kind: ScoredDrop["verdict_kind"]): string {
  switch (kind) {
    case "value":
      return "var(--rpc-success)"
    case "premium":
      return "var(--rpc-warning)"
    case "fair":
      return "var(--rpc-text-primary)"
    default:
      return "var(--rpc-text-muted)"
  }
}

function editionHref(r: ScoredEdition): string | null {
  // Best-effort entity drill-down: the player page on Top Shot. We don't carry
  // the exact external_id (name-matched, not nft-resolved), so the player page
  // is the honest target.
  if (!r.player) return null
  const slug = r.player
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug) return null
  return `/nba-top-shot/player/${slug}`
}

function EditionRow({ r }: { r: ScoredEdition }) {
  const href = editionHref(r)
  const name = r.player || r.set || "—"
  const rpc = r.matched ? fmtMoney(r.rpc_fmv_avg) : r.used_fallback ? `${fmtMoney(r.their_est)}*` : "—"
  return (
    <tr className="rpc-pd-tr">
      <td className="rpc-pd-td rpc-pd-td-name">
        {href ? (
          <Link href={href} className="rpc-pd-namelink">
            {name}
          </Link>
        ) : (
          name
        )}
        {r.count > 1 ? <span className="rpc-pd-x">×{r.count}</span> : null}
        {r.is_parallel ? (
          <span className="rpc-pd-parallel" title="Parallel / subedition — priced at the base edition level; the parallel premium is not yet priced.">
            Parallel
          </span>
        ) : null}
      </td>
      <td className="rpc-pd-td rpc-pd-td-set">{r.set ?? "—"}</td>
      <td className="rpc-pd-td rpc-pd-td-tier">{r.value_tier ?? "—"}</td>
      <td className="rpc-pd-td rpc-pd-num">{fmtMoney(r.their_est)}</td>
      <td className="rpc-pd-td rpc-pd-num rpc-pd-rpc">{rpc}</td>
      <td className="rpc-pd-td rpc-pd-conf" style={{ color: confidenceColor(r.confidence) }}>
        {r.matched ? r.confidence ?? "—" : r.used_fallback ? "their est." : "no match"}
      </td>
      <td className="rpc-pd-td rpc-pd-match">{r.matched ? "✓" : "—"}</td>
    </tr>
  )
}

function OddsTable({ drop }: { drop: ScoredDrop }) {
  const tiers = drop.odds?.tiers ?? []
  if (tiers.length === 0) return null
  return (
    <div className="rpc-pd-odds">
      <div className="rpc-pd-sub">Published odds</div>
      <table className="rpc-pd-table rpc-pd-odds-table">
        <thead>
          <tr>
            <th className="rpc-pd-th">Tier</th>
            <th className="rpc-pd-th rpc-pd-num">Count</th>
            <th className="rpc-pd-th rpc-pd-num">Per card</th>
            <th className="rpc-pd-th rpc-pd-num">≥1 per pack</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.tier} className="rpc-pd-tr">
              <td className="rpc-pd-td">{t.tier}</td>
              <td className="rpc-pd-td rpc-pd-num">{fmtInt(t.count)}</td>
              <td className="rpc-pd-td rpc-pd-num">{fmtProb(t.perCardProb)}</td>
              <td className="rpc-pd-td rpc-pd-num">{fmtProb(t.perPackAtLeastOne)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {drop.odds?.disclaimer ? <p className="rpc-pd-disclaimer">{drop.odds.disclaimer}</p> : null}
    </div>
  )
}

function DropCard({ drop }: { drop: ScoredDrop }) {
  const ss = drop.sale_state
  const sold = ss?.sold ?? null
  const total = ss?.total ?? drop.pack_count ?? null
  const left = total != null && sold != null ? total - sold : ss?.listed ?? null

  return (
    <article className="rpc-pd-card">
      <header className="rpc-pd-card-head">
        <div className="rpc-pd-card-titlewrap">
          <h2 className="rpc-pd-card-title">{drop.name}</h2>
          {drop.status ? <span className="rpc-pd-status">{drop.status}</span> : null}
        </div>
        {drop.description ? <p className="rpc-pd-card-desc">{drop.description}</p> : null}
        <div className="rpc-pd-stats">
          <span className="rpc-pd-stat">
            <span className="rpc-pd-stat-label">Price</span>
            <span className="rpc-pd-stat-value">{fmtFlow(drop.pack_price_flow)}</span>
            {drop.pack_price_usd != null ? (
              <span className="rpc-pd-stat-sub">~{fmtMoney(drop.pack_price_usd)}/pack</span>
            ) : null}
          </span>
          <span className="rpc-pd-stat">
            <span className="rpc-pd-stat-label">RPC pack EV</span>
            <span className="rpc-pd-stat-value rpc-pd-accent">{fmtMoney(drop.rpc_pack_ev_usd)}</span>
            <span className="rpc-pd-stat-sub">pool {fmtMoney(drop.rpc_pool_usd)}</span>
          </span>
          <span className="rpc-pd-stat">
            <span className="rpc-pd-stat-label">Packs</span>
            <span className="rpc-pd-stat-value">{fmtInt(drop.pack_count)}</span>
            <span className="rpc-pd-stat-sub">
              {sold != null ? `${fmtInt(sold)} sold` : "—"}
              {left != null ? ` · ${fmtInt(left)} left` : ""}
            </span>
          </span>
          <span className="rpc-pd-stat">
            <span className="rpc-pd-stat-label">Top edition</span>
            <span className="rpc-pd-stat-value">{fmtPct(drop.value_concentration_pct)}</span>
            <span className="rpc-pd-stat-sub">of pool value</span>
          </span>
        </div>
      </header>

      <div className="rpc-pd-verdict" style={{ borderLeftColor: verdictColor(drop.verdict_kind) }}>
        <span className="rpc-pd-verdict-dot" style={{ background: verdictColor(drop.verdict_kind) }} />
        {drop.verdict}
      </div>

      <div className="rpc-pd-table-wrap">
        <table className="rpc-pd-table">
          <thead>
            <tr>
              <th className="rpc-pd-th">Moment</th>
              <th className="rpc-pd-th">Set</th>
              <th className="rpc-pd-th">Their tier</th>
              <th className="rpc-pd-th rpc-pd-num">Their est.</th>
              <th className="rpc-pd-th rpc-pd-num">RPC FMV</th>
              <th className="rpc-pd-th">Confidence</th>
              <th className="rpc-pd-th rpc-pd-match">Matched</th>
            </tr>
          </thead>
          <tbody>
            {drop.rows.map((r, i) => (
              <EditionRow key={`${r.player}-${r.set}-${r.series}-${i}`} r={r} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="rpc-pd-caveats">
        RPC priced <strong>{fmtInt(drop.matched_count)}</strong> of{" "}
        <strong>{fmtInt(drop.total_distinct)}</strong> distinct editions against on-chain
        FMV; unmatched rows (a name/set mismatch) fall back to the operator&apos;s estimate,
        shown with a <span className="rpc-pd-star">*</span>.
        {drop.has_parallel ? (
          <>
            {" "}
            <span className="rpc-pd-parallel-inline">Parallel</span> rows are priced at the
            base edition level — RPC undervalues the parallel chase until the serial/parallel-FMV
            layer prices it.
          </>
        ) : null}
      </p>

      <OddsTable drop={drop} />
    </article>
  )
}

type Props = {
  initialDrops: ScoredDrop[]
  initialFetchedAt: string | null
}

export default function PackDropsBoardClient({ initialDrops, initialFetchedAt }: Props) {
  const [drops, setDrops] = useState<ScoredDrop[]>(initialDrops)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  // Referral attribution on copy-link for signed-in sharers (same loop as the
  // other public boards). /api/profile/me returns { user: null } for anon.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/profile/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMyUserId(data?.user?.id ?? null))
      .catch(() => {})
  }, [])

  // The server already rendered the default view; only refetch on explicit refresh.
  const didMount = useRef(false)
  useEffect(() => {
    didMount.current = true
  }, [])

  async function refresh() {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/public/insights/pack-drops", { signal: ctrl.signal, cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as ApiResponse
      setDrops(j.drops ?? [])
      setFetchedAt(j.meta?.fetched_at ?? null)
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") return
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  const kpis = useMemo(() => {
    const liveCount = drops.filter((d) => d.sale_state?.saleOpen).length
    const valueCount = drops.filter((d) => d.verdict_kind === "value").length
    return { total: drops.length, live: liveCount, value: valueCount }
  }, [drops])

  const shareUrl = `${SITE_URL}/insights/pack-drops`
  const tweetIntent = useMemo(() => {
    const text = `Is this Top Shot re-pack worth it? RPC scores every Vaultopolis drop against real on-chain FMV — pool, pack EV vs the FLOW price, and odds.\n\nPack Drops:`
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

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-pd-hero-head">
        <div className="rpc-pd-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-pd-h1">Pack Drops</h1>
        <p className="rpc-pd-lede">
          Vaultopolis sells curated <strong>re-packs</strong> of real NBA Top Shot
          moments, priced in FLOW. RPC scores every drop against{" "}
          <strong>real on-chain FMV</strong> — the RPC pool, the{" "}
          <strong>pack EV vs the price to buy</strong>, where the value is
          concentrated, and the published odds. The &quot;is this worth it?&quot;
          read no marketplace ships.
        </p>
        <div className="rpc-pd-meta-row">
          <span className="rpc-pd-meta">
            Updated <FreshnessStamp iso={fetchedAt} />
          </span>
          <span className="rpc-pd-meta-sep">·</span>
          <span className="rpc-pd-meta">NBA Top Shot</span>
          <span className="rpc-pd-meta-sep">·</span>
          <span className="rpc-pd-meta">No signup</span>
        </div>
      </section>

      <section className="rpc-pd-kpi-row" aria-label="Summary">
        <div className="rpc-pd-kpi">
          <div className="rpc-pd-kpi-label">Drops scored</div>
          <div className="rpc-pd-kpi-value">{fmtInt(kpis.total)}</div>
        </div>
        <div className="rpc-pd-kpi">
          <div className="rpc-pd-kpi-label">Sale open</div>
          <div className="rpc-pd-kpi-value">{fmtInt(kpis.live)}</div>
        </div>
        <div className="rpc-pd-kpi">
          <div className="rpc-pd-kpi-label">RPC ≥ ask</div>
          <div className="rpc-pd-kpi-value">{fmtInt(kpis.value)}</div>
        </div>
      </section>

      <section className="rpc-pd-controls" aria-label="Controls">
        <button type="button" onClick={refresh} disabled={loading} className="rpc-pd-refresh">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      <section className="rpc-pd-list" aria-label="Pack drops">
        {error ? (
          <div className="rpc-pd-state">Failed to load: {error}</div>
        ) : loading && drops.length === 0 ? (
          <div className="rpc-pd-state">Loading…</div>
        ) : drops.length === 0 ? (
          <div className="rpc-pd-state">
            No live re-pack drops to score right now. Check back when the next Vaultopolis drop lists.
          </div>
        ) : (
          drops.map((d) => <DropCard key={d.drop_id} drop={d} />)
        )}
      </section>

      <section className="rpc-pd-footer">
        <div className="rpc-pd-method">
          <h3 className="rpc-pd-h3">How this board scores a drop</h3>
          <p>
            For each Vaultopolis drop, RPC rolls the included moments to distinct
            editions, prices each against the latest <strong>RPC FMV</strong> (real
            on-chain sales), and sums to an <strong>RPC pool</strong>. The{" "}
            <strong>pack EV</strong> is that pool ÷ pack count — compare it to the FLOW
            price (converted to USD at the live rate) to judge whether the drop is a
            value or a premium.
          </p>
          <p>
            Honest about the gaps: editions RPC can&apos;t name-match fall back to the
            operator&apos;s own estimate (marked <span className="rpc-pd-star">*</span>),
            and <span className="rpc-pd-parallel-inline">parallel</span> /
            subedition chases are priced at the base edition level — so RPC{" "}
            <em>undervalues</em> the chase until the serial/parallel-FMV layer prices
            it. Odds are fixed at the operator&apos;s publication and shown as-is.
          </p>
        </div>

        <div className="rpc-pd-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-pd-share-btn">
            Share on Twitter
          </a>
          <button type="button" onClick={copyLink} className="rpc-pd-copy-btn">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <Link href="/insights" className="rpc-pd-back">
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
.rpc-pd-hero-head { max-width: 1180px; margin: 0 auto 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pd-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-pd-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-pd-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 860px; margin: 0 0 16px; }
.rpc-pd-lede strong { color: var(--rpc-text-primary); }
.rpc-pd-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-pd-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-pd-kpi-row { max-width: 1180px; margin: 0 auto 22px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rpc-pd-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-pd-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-pd-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-pd-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; gap: 12px; }
.rpc-pd-refresh { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 8px 16px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms; }
.rpc-pd-refresh:hover:not(:disabled) { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-pd-refresh:disabled { opacity: 0.5; cursor: default; }

.rpc-pd-list { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
.rpc-pd-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 1.5px; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }

.rpc-pd-card { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 6px; padding: 20px 22px 22px; }
.rpc-pd-card-head { margin-bottom: 16px; }
.rpc-pd-card-titlewrap { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rpc-pd-card-title { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0; }
.rpc-pd-status { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; padding: 3px 8px; border: 1px solid var(--rpc-border); border-radius: 2px; color: var(--rpc-text-muted); }
.rpc-pd-card-desc { font-family: var(--font-body); font-size: 14px; line-height: 1.5; color: var(--rpc-text-secondary); margin: 8px 0 0; max-width: 820px; }

.rpc-pd-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.rpc-pd-stat { display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 10px 12px; border-radius: 3px; }
.rpc-pd-stat-label { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-pd-stat-value { font-family: var(--font-mono); font-size: 18px; font-weight: 700; color: var(--rpc-text-primary); }
.rpc-pd-stat-value.rpc-pd-accent { color: var(--rpc-red); }
.rpc-pd-stat-sub { font-family: var(--font-mono); font-size: 10px; color: var(--rpc-text-muted); }

.rpc-pd-verdict { font-family: var(--font-body); font-size: 14.5px; line-height: 1.5; color: var(--rpc-text-primary); padding: 11px 14px; margin: 0 0 16px; border: 1px solid var(--rpc-border-subtle); border-left: 3px solid var(--rpc-text-muted); background: var(--rpc-surface-raised); border-radius: 2px; display: flex; align-items: center; gap: 10px; }
.rpc-pd-verdict-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }

.rpc-pd-table-wrap { overflow-x: auto; }
.rpc-pd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rpc-pd-th { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rpc-border-subtle); white-space: nowrap; }
.rpc-pd-th.rpc-pd-num, .rpc-pd-td.rpc-pd-num { text-align: right; }
.rpc-pd-th.rpc-pd-match, .rpc-pd-td.rpc-pd-match { text-align: center; }
.rpc-pd-tr { border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pd-td { padding: 8px 10px; font-family: var(--font-body); color: var(--rpc-text-secondary); vertical-align: top; }
.rpc-pd-td-name { color: var(--rpc-text-primary); font-weight: 600; }
.rpc-pd-namelink { color: var(--rpc-text-primary); text-decoration: none; }
.rpc-pd-namelink:hover { color: var(--rpc-red); }
.rpc-pd-x { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); margin-left: 6px; }
.rpc-pd-parallel { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 1px; text-transform: uppercase; padding: 1px 5px; margin-left: 7px; border: 1px solid var(--rpc-warning); color: var(--rpc-warning); border-radius: 2px; white-space: nowrap; cursor: help; }
.rpc-pd-td-set, .rpc-pd-td-tier { font-family: var(--font-mono); font-size: 11.5px; color: var(--rpc-text-muted); text-transform: capitalize; }
.rpc-pd-td.rpc-pd-num { font-family: var(--font-mono); }
.rpc-pd-rpc { color: var(--rpc-text-primary); font-weight: 700; }
.rpc-pd-conf { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.5px; text-transform: uppercase; }

.rpc-pd-caveats { font-family: var(--font-body); font-size: 12.5px; line-height: 1.55; color: var(--rpc-text-muted); margin: 14px 0 0; }
.rpc-pd-caveats strong { color: var(--rpc-text-secondary); }
.rpc-pd-star { color: var(--rpc-warning); font-weight: 700; }
.rpc-pd-parallel-inline { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-warning); }

.rpc-pd-odds { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rpc-border-subtle); }
.rpc-pd-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 8px; }
.rpc-pd-odds-table { max-width: 520px; }
.rpc-pd-disclaimer { font-family: var(--font-body); font-size: 11.5px; line-height: 1.5; color: var(--rpc-text-ghost); margin: 8px 0 0; }

.rpc-pd-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-pd-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-pd-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-pd-method strong { color: var(--rpc-text-primary); }
.rpc-pd-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-pd-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-pd-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-pd-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-pd-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-pd-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-pd-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-pd-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-pd-footer { grid-template-columns: 1fr; }
}
`
