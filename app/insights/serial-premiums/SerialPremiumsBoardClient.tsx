"use client"

// app/insights/serial-premiums/SerialPremiumsBoardClient.tsx
//
// Client interactivity layer for the public Serial Premiums (#1 Watch) board.
// The server component (page.tsx) fetches the default-view rows (90d, premium
// desc, all tiers) and passes them in as `initialRows`, so the ranked board +
// per-row drill-down links render in the raw server HTML (crawlable — the SEO
// thesis). This component layers tier + window + sort filters on top as
// progressive enhancement and only refetches when the user changes them — the
// default view never refetches on mount.
//
// The differentiator: every row is what a collector ACTUALLY paid for the #1
// mint vs the edition's typical price — a real sale, not an estimate. The kind
// of intelligence nbatopshot.com has no equivalent of.
//
// Image keying: TS per-moment media CDN (assets.nbatopshot.com/media/<nft_id>/
// image) dodges the Series-1 edition-thumbnail 404s; falls back to the edition
// thumbnail_url. Drill-down: nft_id → the exact #1 serial on /moment/<id>;
// external_id → the edition page.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import type { SerialBoardRow as Row, HeadlineMode } from "@/lib/serial-premiums-board"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type { Row }

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type TierFilter = "all" | "COMMON" | "RARE" | "FANDOM" | "LEGENDARY" | "ULTIMATE"
type WindowFilter = "30d" | "90d"
type SortKey = "premium" | "headline_price" | "recent"

const HEADLINES: { val: HeadlineMode; label: string }[] = [
  { val: "no1", label: "#1 Mint" },
  { val: "perfect", label: "Perfect Mint" },
]
const TIERS: { val: TierFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "COMMON", label: "Common" },
  { val: "FANDOM", label: "Fandom" },
  { val: "RARE", label: "Rare" },
  { val: "LEGENDARY", label: "Legendary" },
]
const WINDOWS: { val: WindowFilter; label: string }[] = [
  { val: "30d", label: "30 days" },
  { val: "90d", label: "90 days" },
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

// The headline number. "1,200×" — round with separators; a decimal under 10×.
function fmtMultiple(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 10) return `${Math.round(v).toLocaleString("en-US")}×`
  return `${v.toFixed(1)}×`
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
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

// TS per-moment media CDN keyed on the #1's nft_id; fall back to the edition
// thumbnail, then a gradient.
function primaryImg(r: Row): string | null {
  if (r.nft_id) {
    return `https://assets.nbatopshot.com/media/${encodeURIComponent(r.nft_id)}/image?width=512`
  }
  return r.thumbnail_url || null
}

// Drill-down: the #1 serial's /moment page (nft_id is the on-chain id), else
// the edition page. TS-only board, so the collection slug is constant.
function momentHref(r: Row): string | null {
  if (r.nft_id) return `/moment/${encodeURIComponent(r.nft_id)}`
  return null
}
function editionHref(r: Row): string | null {
  if (r.external_id) return `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`
  return null
}
function rowHref(r: Row): string {
  return momentHref(r) ?? editionHref(r) ?? "#"
}

// The headline serial: #1 on the #1 board, #N on the perfect board (N == circ).
function serialLabel(r: Row): string {
  const serial = r.headline_serial ?? 1
  if (r.circulation_count != null) return `#${fmtInt(serial)} / ${fmtInt(r.circulation_count)}`
  return `#${fmtInt(serial)}`
}

function PremiumImage({ r, className }: { r: Row; className: string }) {
  const initial = primaryImg(r)
  const [src, setSrc] = useState<string | null>(initial)
  const [triedThumb, setTriedThumb] = useState(false)
  const title = r.player_name || r.set_name || "Moment"
  if (!src) return <div className="rpc-sp-img-fallback" aria-hidden />
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
  return (
    <Link href={rowHref(r)} className="rpc-sp-hero-tile">
      <div className="rpc-sp-hero-art">
        <PremiumImage r={r} className="rpc-sp-img" />
        <span className="rpc-sp-hero-serial">{serialLabel(r)}</span>
      </div>
      <div className="rpc-sp-hero-body">
        <div className="rpc-sp-hero-mult">{fmtMultiple(r.premium_multiple)}</div>
        <div className="rpc-sp-hero-name">{title}</div>
        {r.set_name ? <div className="rpc-sp-hero-set">{r.set_name}</div> : null}
        <div className="rpc-sp-hero-prices">
          <span className="rpc-sp-prices-typical">{fmtMoney(r.edition_median_usd)}</span>
          <span className="rpc-sp-arrow">→</span>
          <span className="rpc-sp-prices-no1">{fmtMoney(r.headline_last_sale_usd)}</span>
        </div>
        <div className="rpc-sp-hero-meta">
          <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier) ?? "—"}</span>
          <span className="rpc-sp-dot">·</span>
          <span>{fmtDate(r.headline_sold_at)}</span>
        </div>
      </div>
    </Link>
  )
}

function PremiumRow({ r, rank }: { r: Row; rank: number }) {
  const title = r.player_name || r.set_name || "—"
  return (
    <Link href={rowHref(r)} className="rpc-sp-row">
      <div className="rpc-sp-rank">{rank}</div>
      <div className="rpc-sp-row-art">
        <PremiumImage r={r} className="rpc-sp-img" />
      </div>
      <div className="rpc-sp-row-main">
        <div className="rpc-sp-row-name">{title}</div>
        <div className="rpc-sp-row-sub">
          {r.set_name ? <span>{r.set_name}</span> : null}
          <span className="rpc-sp-dot">·</span>
          <span>{serialLabel(r)}</span>
          {normalizeTier(r.tier) ? (
            <>
              <span className="rpc-sp-dot">·</span>
              <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier)}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="rpc-sp-row-prices">
        <span className="rpc-sp-prices-typical">{fmtMoney(r.edition_median_usd)}</span>
        <span className="rpc-sp-arrow">→</span>
        <span className="rpc-sp-prices-no1">{fmtMoney(r.headline_last_sale_usd)}</span>
      </div>
      <div className="rpc-sp-row-right">
        <div className="rpc-sp-row-mult">{fmtMultiple(r.premium_multiple)}</div>
        <div className="rpc-sp-row-when">{fmtDate(r.headline_sold_at)}</div>
      </div>
    </Link>
  )
}

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function SerialPremiumsBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [headline, setHeadline] = useState<HeadlineMode>("no1")
  const [tier, setTier] = useState<TierFilter>("all")
  const [window, setWindow] = useState<WindowFilter>("90d")
  const [sort, setSort] = useState<SortKey>("premium")

  // Referral attribution on copy-link for signed-in sharers (same loop as the
  // other public boards). /api/profile/me returns { user: null } for anon.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/profile/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMyUserId(data?.user?.id ?? null))
      .catch(() => {})
  }, [])

  // Skip the first fetch when the params match the server-fetched default view
  // (#1 / all / 90d / premium). Any toggle/filter/sort change refetches normally.
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (headline === "no1" && tier === "all" && window === "90d" && sort === "premium") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "100")
        params.set("headline", headline)
        params.set("sort", sort)
        params.set("window", window)
        if (tier !== "all") params.set("tier", tier)
        const r = await fetch(`/api/public/insights/serial-premiums?${params.toString()}`, {
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
  }, [headline, tier, window, sort])

  const heroRows = useMemo(() => {
    // Marquee always leads with the most extreme premiums regardless of sort.
    return [...rows]
      .filter((r) => r.premium_multiple != null)
      .sort((a, b) => Number(b.premium_multiple) - Number(a.premium_multiple))
      .slice(0, 5)
  }, [rows])

  const isPerfect = headline === "perfect"
  const mintLabel = isPerfect ? "perfect" : "#1"

  const kpis = useMemo(() => {
    const withMult = rows.filter((r) => r.premium_multiple != null)
    const top = withMult.length ? Math.max(...withMult.map((r) => Number(r.premium_multiple))) : null
    const topSale = rows.reduce<number | null>((m, r) => {
      const v = r.headline_last_sale_usd == null ? null : Number(r.headline_last_sale_usd)
      if (v == null) return m
      return m == null || v > m ? v : m
    }, null)
    return { count: rows.length, top, topSale }
  }, [rows])

  const shareUrl = `${SITE_URL}/insights/serial-premiums`
  const tweetIntent = useMemo(() => {
    const text = `What collectors ACTUALLY paid for the #1 mint vs the edition's typical price on Top Shot.\n\nSerial Premiums:`
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

      <section className="rpc-sp-hero-head">
        <div className="rpc-sp-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-sp-h1">Serial Premiums</h1>
        <p className="rpc-sp-lede">
          {isPerfect ? (
            <>
              What collectors <strong>actually paid</strong> for the{" "}
              <strong>perfect mint</strong> (the last serial, #N&nbsp;of&nbsp;N)
              versus the edition&apos;s typical price — every row a real sale, not
              an estimate.
            </>
          ) : (
            <>
              What collectors <strong>actually paid</strong> for the #1 mint
              versus the edition&apos;s typical price. A $7.50 common whose #1
              sold for $9,000 is a <strong>1,200× premium</strong> — every row
              here is a real sale, not an estimate.
            </>
          )}
        </p>
        <div className="rpc-sp-meta-row">
          <span className="rpc-sp-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-sp-meta-sep">·</span>
          <span className="rpc-sp-meta">NBA Top Shot</span>
          <span className="rpc-sp-meta-sep">·</span>
          <span className="rpc-sp-meta">No signup</span>
        </div>
      </section>

      <section className="rpc-sp-kpi-row" aria-label="Summary">
        <div className="rpc-sp-kpi">
          <div className="rpc-sp-kpi-label">Editions shown</div>
          <div className="rpc-sp-kpi-value">{fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-sp-kpi">
          <div className="rpc-sp-kpi-label">Top premium</div>
          <div className="rpc-sp-kpi-value">{fmtMultiple(kpis.top)}</div>
        </div>
        <div className="rpc-sp-kpi">
          <div className="rpc-sp-kpi-label">Biggest {mintLabel} sale</div>
          <div className="rpc-sp-kpi-value">{fmtMoney(kpis.topSale)}</div>
        </div>
      </section>

      {heroRows.length > 0 ? (
        <section className="rpc-sp-hero-strip" aria-label="Most extreme premiums">
          <div className="rpc-sp-section-label">Featured · biggest {mintLabel} premiums</div>
          <div className="rpc-sp-hero-grid">
            {heroRows.map((r) => (
              <HeroTile key={r.edition_id ?? r.external_id} r={r} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rpc-sp-controls" aria-label="Filters">
        <div className="rpc-sp-pill-group" role="tablist" aria-label="Mint">
          <span className="rpc-sp-pill-label">MINT</span>
          {HEADLINES.map((h) => (
            <button
              key={h.val}
              role="tab"
              aria-selected={headline === h.val}
              className={`rpc-sp-pill ${headline === h.val ? "rpc-sp-pill-active" : ""}`}
              onClick={() => setHeadline(h.val)}
            >
              {h.label}
            </button>
          ))}
        </div>

        <div className="rpc-sp-pill-group" role="tablist" aria-label="Tier">
          <span className="rpc-sp-pill-label">TIER</span>
          {TIERS.map((t) => (
            <button
              key={t.val}
              role="tab"
              aria-selected={tier === t.val}
              className={`rpc-sp-pill ${tier === t.val ? "rpc-sp-pill-active" : ""}`}
              onClick={() => setTier(t.val)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="rpc-sp-pill-group" role="tablist" aria-label="Window">
          <span className="rpc-sp-pill-label">{isPerfect ? "PERFECT SOLD WITHIN" : "#1 SOLD WITHIN"}</span>
          {WINDOWS.map((w) => (
            <button
              key={w.val}
              role="tab"
              aria-selected={window === w.val}
              className={`rpc-sp-pill ${window === w.val ? "rpc-sp-pill-active" : ""}`}
              onClick={() => setWindow(w.val)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <label className="rpc-sp-sort">
          <span className="rpc-sp-pill-label">SORT</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rpc-sp-select">
            <option value="premium">Premium (desc)</option>
            <option value="headline_price">{isPerfect ? "Perfect sale price" : "#1 sale price"}</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </section>

      <section className="rpc-sp-list-wrap" aria-label="Serial premiums">
        {error ? (
          <div className="rpc-sp-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-sp-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-sp-state">No qualifying {mintLabel} sales in this window.</div>
        ) : (
          <div className="rpc-sp-list">
            {rows.map((r, i) => (
              <PremiumRow key={r.edition_id ?? r.external_id ?? i} r={r} rank={i + 1} />
            ))}
          </div>
        )}
      </section>

      <section className="rpc-sp-footer">
        <div className="rpc-sp-method">
          <h3 className="rpc-sp-h3">What this board is</h3>
          <p>
            For every NBA Top Shot edition with a recent{" "}
            <strong>{isPerfect ? "perfect-mint sale" : "#1-serial sale"}</strong>,
            the multiple that {mintLabel} mint commanded over the edition&apos;s{" "}
            <strong>typical price</strong> (the cleaned 180-day median). Ranked by
            that multiple. Toggle <strong>Mint</strong> to switch between the{" "}
            <strong>#1</strong> serial and the <strong>perfect</strong> mint (the
            last serial, #N&nbsp;of&nbsp;N).
          </p>
          <p>
            Both numbers are <strong>actual on-chain sales</strong>, not
            estimates. Click any row for the moment&apos;s full detail, or open
            the edition to see where it sits. The serial-FMV estimate on the
            moment page is the forward-looking companion to these realized sales.
          </p>
        </div>

        <div className="rpc-sp-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-sp-share-btn">
            Share on Twitter
          </a>
          <button type="button" onClick={copyLink} className="rpc-sp-copy-btn">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <Link href="/insights" className="rpc-sp-back">
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
.rpc-sp-hero-head { max-width: 1180px; margin: 0 auto 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-sp-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-sp-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-sp-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-sp-lede strong { color: var(--rpc-text-primary); }
.rpc-sp-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-sp-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-sp-kpi-row { max-width: 1180px; margin: 0 auto 26px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rpc-sp-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-sp-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-sp-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-sp-section-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 12px; }
.rpc-sp-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-sp-hero-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.rpc-sp-hero-tile { display: flex; flex-direction: column; text-decoration: none; color: inherit; border: 1px solid var(--rpc-red-border); background: var(--rpc-surface); border-radius: 4px; overflow: hidden; transition: border-color 120ms, transform 120ms, background 120ms; }
.rpc-sp-hero-tile:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-2px); }
.rpc-sp-hero-art { position: relative; aspect-ratio: 1 / 1; background: var(--rpc-surface-raised); }
.rpc-sp-hero-serial { position: absolute; top: 8px; left: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 4px 8px; background: var(--rpc-black); border: 1px solid var(--rpc-border); border-radius: 2px; color: var(--rpc-text-secondary); }
.rpc-sp-hero-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-sp-hero-mult { font-family: var(--font-display); font-weight: 800; font-size: 26px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-sp-hero-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); }
.rpc-sp-hero-set { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); line-height: 1.3; }
.rpc-sp-hero-prices { font-family: var(--font-mono); font-size: 12px; display: flex; align-items: center; gap: 7px; margin-top: 2px; }
.rpc-sp-prices-typical { color: var(--rpc-text-muted); }
.rpc-sp-arrow { color: var(--rpc-text-ghost); }
.rpc-sp-prices-no1 { color: var(--rpc-text-primary); font-weight: 700; }
.rpc-sp-hero-meta { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; gap: 6px; margin-top: 2px; }
.rpc-sp-dot { color: var(--rpc-text-ghost); }

.rpc-sp-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-sp-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-sp-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-sp-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-sp-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-sp-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-sp-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-sp-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-sp-list-wrap { max-width: 1180px; margin: 0 auto; }
.rpc-sp-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-sp-list { display: flex; flex-direction: column; gap: 8px; }
.rpc-sp-row { display: grid; grid-template-columns: 32px 56px minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 14px; text-decoration: none; color: inherit; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 4px; padding: 10px 16px 10px 10px; transition: border-color 120ms, background 120ms, transform 120ms; }
.rpc-sp-row:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-1px); }
.rpc-sp-rank { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-muted); text-align: center; }
.rpc-sp-row-art { width: 56px; height: 56px; border-radius: 3px; overflow: hidden; background: var(--rpc-surface-raised); }
.rpc-sp-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-sp-img-fallback { width: 100%; height: 100%; background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface)); }
.rpc-sp-row-main { min-width: 0; }
.rpc-sp-row-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpc-sp-row-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
.rpc-sp-row-prices { font-family: var(--font-mono); font-size: 13px; display: flex; align-items: center; gap: 7px; min-width: 0; }
.rpc-sp-row-right { text-align: right; white-space: nowrap; }
.rpc-sp-row-mult { font-family: var(--font-display); font-weight: 800; font-size: 22px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-sp-row-when { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); margin-top: 2px; }

.rpc-sp-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-sp-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-sp-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-sp-method strong { color: var(--rpc-text-primary); }
.rpc-sp-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-sp-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-sp-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-sp-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-sp-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-sp-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-sp-back:hover { color: var(--rpc-red); }

@media (max-width: 1100px) { .rpc-sp-hero-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .rpc-sp-kpi-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .rpc-sp-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-sp-footer { grid-template-columns: 1fr; }
  .rpc-sp-row { grid-template-columns: 24px 48px minmax(0, 1fr) auto; }
  .rpc-sp-row-prices { display: none; }
}
`
