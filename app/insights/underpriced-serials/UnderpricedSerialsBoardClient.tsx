"use client"

// app/insights/underpriced-serials/UnderpricedSerialsBoardClient.tsx
//
// Client interactivity layer for the public Underpriced #1s & Perfect Mints
// board. The server component (page.tsx) fetches the default view (all headline
// serials, all tiers, discount desc) and passes it in as `initialRows`, so the
// ranked board + per-row drill-down/buy links render in the raw server HTML
// (crawlable — the SEO thesis). This layers headline / tier / quality / sort
// filters on top as progressive enhancement and only refetches on change.
//
// The differentiator: every row is a headline serial (the #1 mint, or the
// perfect mint #N/N) that is LISTED RIGHT NOW below its serial-FMV estimate — a
// live, buyable deal. Each row links to the moment detail AND to the live Dapper
// listing.
//
// Honesty: estimate_quality splits the rows. `tight` deals (perfect mints,
// non-COMMON tiers, HIGH-confidence base editions) have a trustworthy discount —
// they lead the featured strip and read as a precise %. `coarse` deals (a COMMON
// #1 on a big common) use a player-blind population multiplier, so the % is
// directional — shown with a ~ and an "estimate" tag, never oversold.
//
// Image keying: TS per-moment media CDN (assets.nbatopshot.com/media/<nft_id>/
// image) dodges Series-1 edition-thumbnail 404s; falls back to thumbnail_url.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import type {
  UnderpricedRow as Row,
  HeadlineMode,
  QualityFilter,
  UnderpricedSortKey,
} from "@/lib/underpriced-serials-board"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type { Row }

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type TierFilter = "all" | "COMMON" | "RARE" | "FANDOM" | "LEGENDARY" | "ULTIMATE"

const HEADLINES: { val: HeadlineMode; label: string }[] = [
  { val: "all", label: "All" },
  { val: "no1", label: "#1 Mint" },
  { val: "perfect", label: "Perfect" },
]
const TIERS: { val: TierFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "COMMON", label: "Common" },
  { val: "FANDOM", label: "Fandom" },
  { val: "RARE", label: "Rare" },
  { val: "LEGENDARY", label: "Legendary" },
]
const QUALITIES: { val: QualityFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "tight", label: "Tight only" },
]

function normalizeTier(t: string | null): string | null {
  if (!t) return null
  return t.replace(/^MOMENT_TIER_/, "")
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function fmtDiscount(r: Row): string {
  if (r.discount_pct == null) return "—"
  const v = Math.round(Number(r.discount_pct))
  return r.estimate_quality === "coarse" ? `~${v}%` : `${v}%`
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

function primaryImg(r: Row): string | null {
  if (r.nft_id) {
    return `https://assets.nbatopshot.com/media/${encodeURIComponent(r.nft_id)}/image?width=512`
  }
  return r.thumbnail_url || null
}

function momentHref(r: Row): string | null {
  if (r.nft_id) return `/moment/${encodeURIComponent(r.nft_id)}`
  if (r.external_id) return `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`
  return null
}

function serialLabel(r: Row): string {
  const serial = r.serial_number ?? (r.kind === "first" ? 1 : null)
  if (r.circulation_count != null) return `#${fmtInt(serial)} / ${fmtInt(r.circulation_count)}`
  return `#${fmtInt(serial)}`
}

function kindLabel(r: Row): string {
  return r.kind === "perfect" ? "PERFECT" : "#1 MINT"
}

function BoardImage({ r, className }: { r: Row; className: string }) {
  const initial = primaryImg(r)
  const [src, setSrc] = useState<string | null>(initial)
  const [triedThumb, setTriedThumb] = useState(false)
  const title = r.player_name || r.set_name || "Moment"
  if (!src) return <div className="rpc-us-img-fallback" aria-hidden />
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={title}
      className={className}
      loading="lazy"
      onError={() => {
        if (!triedThumb && r.thumbnail_url && r.thumbnail_url !== src) {
          setTriedThumb(true)
          setSrc(r.thumbnail_url)
        } else {
          setSrc(null)
        }
      }}
    />
  )
}

function HeroTile({ r }: { r: Row }) {
  const title = r.player_name || r.set_name || "—"
  const href = momentHref(r) ?? "#"
  return (
    <Link href={href} className="rpc-us-hero-tile">
      <div className="rpc-us-hero-art">
        <BoardImage r={r} className="rpc-us-img" />
        <span className="rpc-us-hero-serial">{serialLabel(r)}</span>
        <span className="rpc-us-hero-kind">{kindLabel(r)}</span>
      </div>
      <div className="rpc-us-hero-body">
        <div className="rpc-us-hero-disc">{fmtDiscount(r)} off</div>
        <div className="rpc-us-hero-name">{title}</div>
        {r.set_name ? <div className="rpc-us-hero-set">{r.set_name}</div> : null}
        <div className="rpc-us-hero-prices">
          <span className="rpc-us-prices-ask">{fmtMoney(r.ask_usd)}</span>
          <span className="rpc-us-arrow">vs</span>
          <span className="rpc-us-prices-est">{fmtMoney(r.serial_fmv_usd)} est</span>
        </div>
        <div className="rpc-us-hero-meta">
          <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier) ?? "—"}</span>
          {r.estimate_quality === "coarse" ? (
            <>
              <span className="rpc-us-dot">·</span>
              <span className="rpc-us-est-tag">est</span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  )
}

function BoardRow({ r, rank }: { r: Row; rank: number }) {
  const title = r.player_name || r.set_name || "—"
  const href = momentHref(r) ?? "#"
  return (
    <div className="rpc-us-row">
      <div className="rpc-us-rank">{rank}</div>
      <Link href={href} className="rpc-us-row-art" aria-label={title}>
        <BoardImage r={r} className="rpc-us-img" />
      </Link>
      <Link href={href} className="rpc-us-row-main">
        <div className="rpc-us-row-name">{title}</div>
        <div className="rpc-us-row-sub">
          {r.set_name ? <span>{r.set_name}</span> : null}
          <span className="rpc-us-dot">·</span>
          <span>{serialLabel(r)}</span>
          <span className="rpc-us-dot">·</span>
          <span className="rpc-us-kind-tag">{kindLabel(r)}</span>
          {normalizeTier(r.tier) ? (
            <>
              <span className="rpc-us-dot">·</span>
              <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier)}</span>
            </>
          ) : null}
          {r.estimate_quality === "coarse" ? (
            <>
              <span className="rpc-us-dot">·</span>
              <span className="rpc-us-est-tag" title="Population estimate — varies by player">
                est
              </span>
            </>
          ) : null}
        </div>
      </Link>
      <div className="rpc-us-row-prices">
        <span className="rpc-us-prices-ask">{fmtMoney(r.ask_usd)}</span>
        <span className="rpc-us-arrow">vs</span>
        <span className="rpc-us-prices-est">{fmtMoney(r.serial_fmv_usd)}</span>
      </div>
      <div className="rpc-us-row-right">
        <div className="rpc-us-row-disc">{fmtDiscount(r)}</div>
        {r.listing_url ? (
          <a
            href={r.listing_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rpc-us-buy"
            onClick={(e) => e.stopPropagation()}
          >
            Buy {fmtMoney(r.ask_usd)} →
          </a>
        ) : null}
      </div>
    </div>
  )
}

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function UnderpricedSerialsBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [headline, setHeadline] = useState<HeadlineMode>("all")
  const [tier, setTier] = useState<TierFilter>("all")
  const [quality, setQuality] = useState<QualityFilter>("all")
  const [sort, setSort] = useState<UnderpricedSortKey>("discount")

  // Referral attribution on copy-link for signed-in sharers (same loop as the
  // other public boards). /api/profile/me returns { user: null } for anon.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/profile/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMyUserId(data?.user?.id ?? null))
      .catch(() => {})
  }, [])

  // Skip the first fetch when params match the server-fetched default view
  // (all / all / all / discount). Any change refetches normally.
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (headline === "all" && tier === "all" && quality === "all" && sort === "discount") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "100")
        params.set("headline", headline)
        params.set("quality", quality)
        params.set("sort", sort)
        if (tier !== "all") params.set("tier", tier)
        const r = await fetch(`/api/public/insights/underpriced-serials?${params.toString()}`, {
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
  }, [headline, tier, quality, sort])

  // Featured strip leads with the most trustworthy deals: tight rows by discount,
  // regardless of the chosen sort. Falls back to all rows if none are tight.
  const heroRows = useMemo(() => {
    const tight = rows.filter((r) => r.estimate_quality === "tight" && r.discount_pct != null)
    const pool = tight.length ? tight : rows.filter((r) => r.discount_pct != null)
    return [...pool].sort((a, b) => Number(b.discount_pct) - Number(a.discount_pct)).slice(0, 5)
  }, [rows])

  const kpis = useMemo(() => {
    const withDisc = rows.filter((r) => r.discount_pct != null)
    const top = withDisc.length ? Math.max(...withDisc.map((r) => Number(r.discount_pct))) : null
    const topSaved = rows.reduce<number | null>((m, r) => {
      const v = r.discount_usd == null ? null : Number(r.discount_usd)
      if (v == null) return m
      return m == null || v > m ? v : m
    }, null)
    return { count: rows.length, top, topSaved }
  }, [rows])

  // Real listings freshness — the max last_seen_at across the board rows, i.e.
  // when the Atlas curl-ingest spine was last refreshed. (The "Updated" line
  // above tracks page-render time, which always reads near-now.) The ingest runs
  // ~every 3h from a residential runner and can skip overnight, so when the spine
  // is >4h old we surface an honest caption instead of implying the board is live.
  const listingsAgeHours = useMemo(() => {
    let maxTs = 0
    for (const r of rows) {
      const t = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN
      if (Number.isFinite(t) && t > maxTs) maxTs = t
    }
    if (!maxTs) return null
    return (Date.now() - maxTs) / 3_600_000
  }, [rows])

  const shareUrl = `${SITE_URL}/insights/underpriced-serials`
  const tweetIntent = useMemo(() => {
    const text = `Top Shot #1 mints & perfect mints listed BELOW what the serial is worth — live deals, ranked by discount.\n\nUnderpriced #1s:`
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

      <section className="rpc-us-hero-head">
        <div className="rpc-us-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-us-h1">Underpriced #1s</h1>
        <p className="rpc-us-lede">
          The serials collectors chase — the <strong>#1 mint</strong> and the{" "}
          <strong>perfect mint</strong> (#N&nbsp;of&nbsp;N) — that are{" "}
          <strong>listed right now</strong> for less than the serial is worth.
          Ranked by discount versus the serial-FMV estimate. Every row is a live,
          buyable deal — not a historical sale.
        </p>
        <div className="rpc-us-meta-row">
          <span className="rpc-us-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-us-meta-sep">·</span>
          <span className="rpc-us-meta">NBA Top Shot</span>
          <span className="rpc-us-meta-sep">·</span>
          <span className="rpc-us-meta">No signup</span>
          {listingsAgeHours != null && listingsAgeHours >= 4 ? (
            <>
              <span className="rpc-us-meta-sep">·</span>
              <span className="rpc-us-meta rpc-us-stale">
                Listings last refreshed {Math.round(listingsAgeHours)}h ago
              </span>
            </>
          ) : null}
        </div>
      </section>

      <section className="rpc-us-kpi-row" aria-label="Summary">
        <div className="rpc-us-kpi">
          <div className="rpc-us-kpi-label">Live deals</div>
          <div className="rpc-us-kpi-value">{fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-us-kpi">
          <div className="rpc-us-kpi-label">Biggest discount</div>
          <div className="rpc-us-kpi-value">{kpis.top == null ? "—" : `${Math.round(kpis.top)}%`}</div>
        </div>
        <div className="rpc-us-kpi">
          <div className="rpc-us-kpi-label">Biggest $ under value</div>
          <div className="rpc-us-kpi-value">{fmtMoney(kpis.topSaved)}</div>
        </div>
      </section>

      {heroRows.length > 0 ? (
        <section className="rpc-us-hero-strip" aria-label="Featured deals">
          <div className="rpc-us-section-label">Featured · biggest trustworthy discounts</div>
          <div className="rpc-us-hero-grid">
            {heroRows.map((r) => (
              <HeroTile key={`${r.edition_id ?? r.external_id}-${r.serial_number}`} r={r} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rpc-us-controls" aria-label="Filters">
        <div className="rpc-us-pill-group" role="tablist" aria-label="Mint">
          <span className="rpc-us-pill-label">MINT</span>
          {HEADLINES.map((h) => (
            <button
              key={h.val}
              role="tab"
              aria-selected={headline === h.val}
              className={`rpc-us-pill ${headline === h.val ? "rpc-us-pill-active" : ""}`}
              onClick={() => setHeadline(h.val)}
            >
              {h.label}
            </button>
          ))}
        </div>

        <div className="rpc-us-pill-group" role="tablist" aria-label="Tier">
          <span className="rpc-us-pill-label">TIER</span>
          {TIERS.map((t) => (
            <button
              key={t.val}
              role="tab"
              aria-selected={tier === t.val}
              className={`rpc-us-pill ${tier === t.val ? "rpc-us-pill-active" : ""}`}
              onClick={() => setTier(t.val)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="rpc-us-pill-group" role="tablist" aria-label="Estimate quality">
          <span className="rpc-us-pill-label">ESTIMATE</span>
          {QUALITIES.map((qf) => (
            <button
              key={qf.val}
              role="tab"
              aria-selected={quality === qf.val}
              className={`rpc-us-pill ${quality === qf.val ? "rpc-us-pill-active" : ""}`}
              onClick={() => setQuality(qf.val)}
            >
              {qf.label}
            </button>
          ))}
        </div>

        <label className="rpc-us-sort">
          <span className="rpc-us-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as UnderpricedSortKey)}
            className="rpc-us-select"
          >
            <option value="discount">Discount (desc)</option>
            <option value="ask">Lowest ask</option>
            <option value="recent">Most recently listed</option>
          </select>
        </label>
      </section>

      <section className="rpc-us-list-wrap" aria-label="Underpriced serials">
        {error ? (
          <div className="rpc-us-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-us-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-us-state">
            No underpriced headline serials right now — the board is empty when nothing&apos;s listed
            below value.
          </div>
        ) : (
          <div className="rpc-us-list">
            {rows.map((r, i) => (
              <BoardRow key={`${r.edition_id ?? r.external_id ?? i}-${r.serial_number}`} r={r} rank={i + 1} />
            ))}
          </div>
        )}
      </section>

      <section className="rpc-us-footer">
        <div className="rpc-us-method">
          <h3 className="rpc-us-h3">What this board is</h3>
          <p>
            For every Top Shot <strong>headline serial</strong> currently listed — the{" "}
            <strong>#1 mint</strong> or the <strong>perfect mint</strong> (the last serial,
            #N&nbsp;of&nbsp;N) — we compare the live ask against the{" "}
            <strong>serial-FMV estimate</strong> (the same engine the moment page uses). A row
            appears only when the ask is below that estimate, ranked by the discount.
          </p>
          <p>
            <strong>Tight</strong> deals (perfect mints, non-Common tiers, or High-confidence base
            editions) have a trustworthy discount. <strong>Coarse</strong> deals — a Common #1 on a
            big common — use a player-blind population multiplier, so the % (shown with a{" "}
            <span className="rpc-us-est-tag">~</span>) is directional: right for stars, generous for
            role players. Use <em>Tight only</em> to hide the coarse rows. Buy links go to the live
            Dapper listing.
          </p>
        </div>

        <div className="rpc-us-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-us-share-btn">
            Share on Twitter
          </a>
          <button type="button" onClick={copyLink} className="rpc-us-copy-btn">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <Link href="/insights" className="rpc-us-back">
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
.rpc-us-hero-head { max-width: 1180px; margin: 0 auto 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-us-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-us-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-us-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-us-lede strong { color: var(--rpc-text-primary); }
.rpc-us-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-us-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }
.rpc-us-stale { color: var(--rpc-warning); }

.rpc-us-kpi-row { max-width: 1180px; margin: 0 auto 26px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rpc-us-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-us-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-us-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-us-section-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 12px; }
.rpc-us-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-us-hero-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.rpc-us-hero-tile { display: flex; flex-direction: column; text-decoration: none; color: inherit; border: 1px solid var(--rpc-red-border); background: var(--rpc-surface); border-radius: 4px; overflow: hidden; transition: border-color 120ms, transform 120ms, background 120ms; }
.rpc-us-hero-tile:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-2px); }
.rpc-us-hero-art { position: relative; aspect-ratio: 1 / 1; background: var(--rpc-surface-raised); }
.rpc-us-hero-serial { position: absolute; top: 8px; left: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 4px 8px; background: var(--rpc-black); border: 1px solid var(--rpc-border); border-radius: 2px; color: var(--rpc-text-secondary); }
.rpc-us-hero-kind { position: absolute; top: 8px; right: 8px; font-family: var(--font-mono); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; padding: 4px 7px; background: var(--rpc-red-bg); border: 1px solid var(--rpc-red); border-radius: 2px; color: var(--rpc-red); }
.rpc-us-hero-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-us-hero-disc { font-family: var(--font-display); font-weight: 800; font-size: 26px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-us-hero-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); }
.rpc-us-hero-set { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); line-height: 1.3; }
.rpc-us-hero-prices { font-family: var(--font-mono); font-size: 12px; display: flex; align-items: center; gap: 7px; margin-top: 2px; }
.rpc-us-prices-ask { color: var(--rpc-text-primary); font-weight: 700; }
.rpc-us-arrow { color: var(--rpc-text-ghost); }
.rpc-us-prices-est { color: var(--rpc-text-muted); }
.rpc-us-hero-meta { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; gap: 6px; margin-top: 2px; }
.rpc-us-dot { color: var(--rpc-text-ghost); }
.rpc-us-est-tag { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border); border-radius: 2px; padding: 0 4px; }
.rpc-us-kind-tag { color: var(--rpc-text-secondary); }

.rpc-us-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-us-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-us-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-us-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-us-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-us-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-us-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-us-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-us-list-wrap { max-width: 1180px; margin: 0 auto; }
.rpc-us-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-us-list { display: flex; flex-direction: column; gap: 8px; }
.rpc-us-row { display: grid; grid-template-columns: 32px 56px minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 14px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 4px; padding: 10px 16px 10px 10px; transition: border-color 120ms, background 120ms; }
.rpc-us-row:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); }
.rpc-us-rank { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-muted); text-align: center; }
.rpc-us-row-art { width: 56px; height: 56px; border-radius: 3px; overflow: hidden; background: var(--rpc-surface-raised); display: block; }
.rpc-us-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-us-img-fallback { width: 100%; height: 100%; background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface)); }
.rpc-us-row-main { min-width: 0; text-decoration: none; color: inherit; }
.rpc-us-row-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpc-us-row-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
.rpc-us-row-prices { font-family: var(--font-mono); font-size: 13px; display: flex; align-items: center; gap: 7px; min-width: 0; }
.rpc-us-row-right { text-align: right; white-space: nowrap; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.rpc-us-row-disc { font-family: var(--font-display); font-weight: 800; font-size: 22px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-us-buy { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #fff; background: var(--rpc-red); border-radius: 2px; padding: 6px 10px; text-decoration: none; transition: background 120ms; }
.rpc-us-buy:hover { background: var(--rpc-red-hover); }

.rpc-us-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-us-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-us-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-us-method strong { color: var(--rpc-text-primary); }
.rpc-us-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-us-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-us-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-us-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-us-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-us-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-us-back:hover { color: var(--rpc-red); }

@media (max-width: 1100px) { .rpc-us-hero-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .rpc-us-kpi-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .rpc-us-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-us-footer { grid-template-columns: 1fr; }
  .rpc-us-row { grid-template-columns: 24px 48px minmax(0, 1fr) auto; }
  .rpc-us-row-prices { display: none; }
}
`
