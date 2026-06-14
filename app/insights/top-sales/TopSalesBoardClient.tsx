"use client"

// app/insights/top-sales/TopSalesBoardClient.tsx
//
// Client interactivity layer for the public Top Sales / Whale Watch board. The
// server component (page.tsx) fetches the default-view rows (7d, price desc,
// all collections) with buyer/seller @handles already resolved and passes them
// in as `initialRows`, so the ranked board + per-row drill-down links + the
// who-bought/who-sold @handles render in the raw server HTML (crawlable). This
// component layers collection + window + sort filters on top as progressive
// enhancement and only refetches when the user changes them — the default view
// never refetches on mount.
//
// The differentiator: every row names the buyer and the seller (Top Shot
// @handles, resolved server-side; truncated address when unknown) — the one
// thing Top Shot's own activity feed won't surface as a cohort.
//
// Image keying: TS uses the per-moment media CDN (assets.nbatopshot.com/media/
// <nft_id>/image) to dodge the Series-1 edition-thumbnail 404s; AllDay uses the
// edition thumbnail_url. nft_id (not the always-NULL moment_id) is the on-chain
// id, and is also the /moment/<id> drill-down key (lands on the exact serial
// that sold).
//
// See app/insights/top-sales/page.tsx for the data source + server fetch.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  sale_id: string
  edition_id: string | null
  external_id: string | null
  collection: string | null
  collection_id: string | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  nft_id: string | null
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  buyer_address: string | null
  seller_address: string | null
  marketplace: string | null
  buyer_name: string | null
  seller_name: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type CollectionFilter = "all" | "nba_top_shot" | "nfl_all_day"
type WindowFilter = "7d" | "30d"
type SortKey = "price" | "recent"

const COLLECTIONS: { val: CollectionFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "nba_top_shot", label: "Top Shot" },
  { val: "nfl_all_day", label: "NFL All Day" },
]
const WINDOWS: { val: WindowFilter; label: string }[] = [
  { val: "7d", label: "7 days" },
  { val: "30d", label: "30 days" },
]

function collectionSlug(c: string | null): string {
  if (!c) return "nba-top-shot"
  return c.replace(/_/g, "-")
}

function normalizeTier(t: string | null): string | null {
  if (!t) return null
  return t.replace(/^MOMENT_TIER_/, "")
}

// Sales prices are exact dollar amounts (>= $100 by view bound) — show the real
// number with separators, not a $5.0k abbreviation. This is the headline.
function fmtPrice(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function relTime(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return "—"
  const diff = Date.now() - then
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
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

// Primary image: TS per-moment media CDN keyed on nft_id; everything else the
// edition thumbnail. On error, fall back TS→thumbnail_url, then to a gradient.
function primaryImg(r: Row): string | null {
  if (r.collection === "nba_top_shot" && r.nft_id) {
    return `https://assets.nbatopshot.com/media/${encodeURIComponent(r.nft_id)}/image?width=512`
  }
  return r.thumbnail_url || null
}

// Per-row drill-down: nft_id resolves to the exact serial that sold on the
// /moment/<id> page; fall back to the edition page when nft_id is absent.
function rowHref(r: Row): string {
  if (r.nft_id) return `/moment/${encodeURIComponent(r.nft_id)}`
  if (r.external_id) return `/${collectionSlug(r.collection)}/edition/${encodeURIComponent(r.external_id)}`
  return `/moment/${r.edition_id}`
}

function serialLabel(r: Row): string | null {
  if (r.serial_number == null) return null
  if (r.circulation_count != null) return `#${r.serial_number} / ${fmtInt(r.circulation_count)}`
  return `#${r.serial_number}`
}

function SaleImage({ r, className }: { r: Row; className: string }) {
  // Two-step fallback: primary → thumbnail_url → gradient.
  const initial = primaryImg(r)
  const [src, setSrc] = useState<string | null>(initial)
  const [triedThumb, setTriedThumb] = useState(false)
  const title = r.player_name || r.set_name || "Moment"

  if (!src) return <div className="rpc-ts-img-fallback" aria-hidden />
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

// Hero tile — the top sales by price, art-forward.
function HeroTile({ r }: { r: Row }) {
  const title = r.player_name || r.set_name || "—"
  const sl = serialLabel(r)
  return (
    <Link href={rowHref(r)} className="rpc-ts-hero-tile">
      <div className="rpc-ts-hero-art">
        <SaleImage r={r} className="rpc-ts-img" />
        {sl ? <span className="rpc-ts-hero-serial">{sl}</span> : null}
      </div>
      <div className="rpc-ts-hero-body">
        <div className="rpc-ts-hero-price">{fmtPrice(r.price_usd)}</div>
        <div className="rpc-ts-hero-name">{title}</div>
        {r.set_name ? <div className="rpc-ts-hero-set">{r.set_name}</div> : null}
        <div className="rpc-ts-hero-meta">
          <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier) ?? "—"}</span>
          <span className="rpc-ts-dot">·</span>
          <span>{relTime(r.sold_at)}</span>
        </div>
        <div className="rpc-ts-hero-parties">
          <span className="rpc-ts-party">
            <span className="rpc-ts-party-k">Buyer</span>
            <span className="rpc-ts-party-v">{r.buyer_name ?? "—"}</span>
          </span>
          <span className="rpc-ts-party">
            <span className="rpc-ts-party-k">Seller</span>
            <span className="rpc-ts-party-v">{r.seller_name ?? "—"}</span>
          </span>
        </div>
      </div>
    </Link>
  )
}

// Compact card for the "Just sold · last 48 hours" horizontal rail. Same art /
// drill-down / price formatting as everywhere else, sized for a scroll strip.
function RecentTile({ r }: { r: Row }) {
  const title = r.player_name || r.set_name || "—"
  return (
    <Link href={rowHref(r)} className="rpc-ts-recent-card">
      <div className="rpc-ts-recent-art">
        <SaleImage r={r} className="rpc-ts-img" />
      </div>
      <div className="rpc-ts-recent-price">{fmtPrice(r.price_usd)}</div>
      <div className="rpc-ts-recent-name">{title}</div>
      <div className="rpc-ts-recent-when">{relTime(r.sold_at)}</div>
    </Link>
  )
}

// Ranked list row.
function SaleRow({ r, rank }: { r: Row; rank: number }) {
  const title = r.player_name || r.set_name || "—"
  const sl = serialLabel(r)
  return (
    <Link href={rowHref(r)} className="rpc-ts-row">
      <div className="rpc-ts-rank">{rank}</div>
      <div className="rpc-ts-row-art">
        <SaleImage r={r} className="rpc-ts-img" />
      </div>
      <div className="rpc-ts-row-main">
        <div className="rpc-ts-row-name">{title}</div>
        <div className="rpc-ts-row-sub">
          {r.set_name ? <span>{r.set_name}</span> : null}
          {sl ? (
            <>
              <span className="rpc-ts-dot">·</span>
              <span>{sl}</span>
            </>
          ) : null}
          {normalizeTier(r.tier) ? (
            <>
              <span className="rpc-ts-dot">·</span>
              <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier)}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="rpc-ts-row-parties">
        <div className="rpc-ts-party-line">
          <span className="rpc-ts-party-k">B</span>
          <span className="rpc-ts-party-v">{r.buyer_name ?? "—"}</span>
        </div>
        <div className="rpc-ts-party-line">
          <span className="rpc-ts-party-k">S</span>
          <span className="rpc-ts-party-v">{r.seller_name ?? "—"}</span>
        </div>
      </div>
      <div className="rpc-ts-row-right">
        <div className="rpc-ts-row-price">{fmtPrice(r.price_usd)}</div>
        <div className="rpc-ts-row-when">{relTime(r.sold_at)}</div>
      </div>
    </Link>
  )
}

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function TopSalesBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [collection, setCollection] = useState<CollectionFilter>("all")
  const [window, setWindow] = useState<WindowFilter>("7d")
  const [sort, setSort] = useState<SortKey>("price")

  // Skip the first fetch when the params match the server-fetched default view
  // (all / 7d / price). Any filter/sort change refetches normally.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (collection === "all" && window === "7d" && sort === "price") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "100")
        params.set("sort", sort)
        params.set("window", window)
        if (collection !== "all") params.set("collection", collection)
        const r = await fetch(`/api/public/insights/top-sales?${params.toString()}`, {
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
  }, [collection, window, sort])

  const heroRows = useMemo(() => {
    // Hero leads with the highest-value sales regardless of the active sort, so
    // the marquee always shows the whales. Always price-desc.
    return [...rows]
      .filter((r) => r.price_usd != null)
      .sort((a, b) => Number(b.price_usd) - Number(a.price_usd))
      .slice(0, 5)
  }, [rows])

  const recentRows = useMemo(() => {
    // "Just sold" rail: the biggest sales of the last 48h, recency-ordered. The
    // hero shows the week's whales by price; this answers "what moved today."
    // Derived from the loaded rows (already price/recency-bounded) so it needs
    // no extra fetch and stays in sync with the active filters. Hidden when the
    // window is quiet (no sales in 48h).
    const cutoff = Date.now() - 48 * 60 * 60 * 1000
    return [...rows]
      .filter((r) => {
        if (r.price_usd == null || !r.sold_at) return false
        const t = new Date(r.sold_at).getTime()
        return Number.isFinite(t) && t >= cutoff
      })
      .sort((a, b) => new Date(b.sold_at!).getTime() - new Date(a.sold_at!).getTime())
      .slice(0, 12)
  }, [rows])

  const kpis = useMemo(() => {
    const priced = rows.filter((r) => r.price_usd != null)
    const top = priced.length ? Math.max(...priced.map((r) => Number(r.price_usd))) : null
    const total = priced.reduce((s, r) => s + Number(r.price_usd), 0)
    const named = rows.filter(
      (r) => (r.buyer_name && !r.buyer_name.includes("…")) || (r.seller_name && !r.seller_name.includes("…"))
    ).length
    return { count: rows.length, top, total, named }
  }, [rows])

  const shareUrl = `${SITE_URL}/insights/top-sales`
  const tweetIntent = useMemo(() => {
    const text = `The biggest Flow sales this week — and who bought and sold them.\n\nTop Sales:`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  }, [shareUrl])

  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard can be blocked — non-fatal.
    }
  }

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-ts-hero-head">
        <div className="rpc-ts-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-ts-h1">Top Sales</h1>
        <p className="rpc-ts-lede">
          The biggest recent sales across NBA Top Shot and NFL All Day — and the
          one thing the marketplace activity feed won&apos;t put in front of you:{" "}
          <strong>who bought it, and who sold it.</strong> The whales of the
          week, refreshed continuously.
        </p>
        <div className="rpc-ts-meta-row">
          <span className="rpc-ts-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-ts-meta-sep">·</span>
          <span className="rpc-ts-meta">No signup</span>
        </div>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-ts-kpi-row" aria-label="Summary">
        <div className="rpc-ts-kpi">
          <div className="rpc-ts-kpi-label">Sales shown</div>
          <div className="rpc-ts-kpi-value">{fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-ts-kpi">
          <div className="rpc-ts-kpi-label">Top sale</div>
          <div className="rpc-ts-kpi-value">{fmtPrice(kpis.top)}</div>
        </div>
        <div className="rpc-ts-kpi">
          <div className="rpc-ts-kpi-label">Combined</div>
          <div className="rpc-ts-kpi-value">{fmtPrice(kpis.total)}</div>
        </div>
        <div className="rpc-ts-kpi">
          <div className="rpc-ts-kpi-label">Named parties</div>
          <div className="rpc-ts-kpi-value">{fmtInt(kpis.named)}</div>
        </div>
      </section>

      {/* ── Hero strip: top sales by price ─────────────────────────────── */}
      {heroRows.length > 0 ? (
        <section className="rpc-ts-hero-strip" aria-label="Featured sales">
          <div className="rpc-ts-section-label">Featured · highest value</div>
          <div className="rpc-ts-hero-grid">
            {heroRows.map((r) => (
              <HeroTile key={r.sale_id} r={r} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Recent rail: biggest sales of the last 48h ─────────────────── */}
      {recentRows.length > 0 ? (
        <section className="rpc-ts-recent-strip" aria-label="Recently sold">
          <div className="rpc-ts-section-label">Just sold · last 48 hours</div>
          <div className="rpc-ts-recent-rail">
            {recentRows.map((r) => (
              <RecentTile key={r.sale_id} r={r} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Filter row ────────────────────────────────────────────────── */}
      <section className="rpc-ts-controls" aria-label="Filters">
        <div className="rpc-ts-pill-group" role="tablist" aria-label="Collection">
          <span className="rpc-ts-pill-label">COLLECTION</span>
          {COLLECTIONS.map((c) => (
            <button
              key={c.val}
              role="tab"
              aria-selected={collection === c.val}
              className={`rpc-ts-pill ${collection === c.val ? "rpc-ts-pill-active" : ""}`}
              onClick={() => setCollection(c.val)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="rpc-ts-pill-group" role="tablist" aria-label="Window">
          <span className="rpc-ts-pill-label">WINDOW</span>
          {WINDOWS.map((w) => (
            <button
              key={w.val}
              role="tab"
              aria-selected={window === w.val}
              className={`rpc-ts-pill ${window === w.val ? "rpc-ts-pill-active" : ""}`}
              onClick={() => setWindow(w.val)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <label className="rpc-ts-sort">
          <span className="rpc-ts-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-ts-select"
          >
            <option value="price">Price (desc)</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </section>

      {/* ── Ranked list ───────────────────────────────────────────────── */}
      <section className="rpc-ts-list-wrap" aria-label="Top sales">
        {error ? (
          <div className="rpc-ts-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ts-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-ts-state">No sales match those filters.</div>
        ) : (
          <div className="rpc-ts-list">
            {rows.map((r, i) => (
              <SaleRow key={r.sale_id} r={r} rank={i + 1} />
            ))}
          </div>
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-ts-footer">
        <div className="rpc-ts-method">
          <h3 className="rpc-ts-h3">What this board is</h3>
          <p>
            Every sale of <strong>$100 or more</strong> across NBA Top Shot and
            NFL All Day in the selected window, ranked by price. Each row names
            the <strong>buyer</strong> and the <strong>seller</strong> — resolved
            to their Top Shot handle where we know it, a truncated wallet address
            where we don&apos;t.
          </p>
          <p>
            Prices are the actual on-chain sale, not an estimate. Click any row
            for the moment&apos;s full detail — FMV, owner, and history.
          </p>
        </div>

        <div className="rpc-ts-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ts-share-btn">
            Share on Twitter
          </a>
          <button type="button" onClick={copyLink} className="rpc-ts-copy-btn">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <Link href="/insights" className="rpc-ts-back">
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
.rpc-ts-hero-head {
  max-width: 1180px;
  margin: 0 auto 24px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-ts-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-ts-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-ts-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 820px;
  margin: 0 0 16px;
}
.rpc-ts-lede strong { color: var(--rpc-text-primary); }
.rpc-ts-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-ts-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ts-kpi-row {
  max-width: 1180px;
  margin: 0 auto 26px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-ts-kpi {
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-ts-kpi-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 6px;
}
.rpc-ts-kpi-value {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}

.rpc-ts-section-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 12px;
}
.rpc-ts-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-ts-hero-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}
.rpc-ts-hero-tile {
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
  border: 1px solid var(--rpc-red-border);
  background: var(--rpc-surface);
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 120ms, transform 120ms, background 120ms;
}
.rpc-ts-hero-tile:hover {
  border-color: var(--rpc-red);
  background: var(--rpc-surface-hover);
  transform: translateY(-2px);
}
.rpc-ts-hero-art {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--rpc-surface-raised);
}
.rpc-ts-hero-serial {
  position: absolute;
  top: 8px;
  left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 4px 8px;
  background: var(--rpc-black);
  border: 1px solid var(--rpc-border);
  border-radius: 2px;
  color: var(--rpc-text-secondary);
}
.rpc-ts-hero-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-ts-hero-price {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 24px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}
.rpc-ts-hero-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.2;
  color: var(--rpc-text-primary);
}
.rpc-ts-hero-set {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--rpc-text-muted);
  line-height: 1.3;
}
.rpc-ts-hero-meta {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.rpc-ts-hero-parties {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--rpc-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rpc-ts-party { display: flex; align-items: baseline; gap: 6px; }
.rpc-ts-party-k {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  min-width: 38px;
}
.rpc-ts-party-v {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--rpc-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpc-ts-recent-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-ts-recent-rail {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: var(--rpc-border) transparent;
}
.rpc-ts-recent-rail::-webkit-scrollbar { height: 6px; }
.rpc-ts-recent-rail::-webkit-scrollbar-thumb {
  background: var(--rpc-border);
  border-radius: 3px;
}
.rpc-ts-recent-card {
  flex: 0 0 150px;
  width: 150px;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 120ms, transform 120ms, background 120ms;
}
.rpc-ts-recent-card:hover {
  border-color: var(--rpc-red);
  background: var(--rpc-surface-hover);
  transform: translateY(-2px);
}
.rpc-ts-recent-art { aspect-ratio: 1 / 1; background: var(--rpc-surface-raised); }
.rpc-ts-recent-price {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 18px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
  padding: 8px 10px 0;
}
.rpc-ts-recent-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 13px;
  line-height: 1.2;
  color: var(--rpc-text-primary);
  padding: 2px 10px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rpc-ts-recent-when {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  padding: 3px 10px 10px;
}

.rpc-ts-controls {
  max-width: 1180px;
  margin: 0 auto 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  align-items: center;
}
.rpc-ts-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ts-pill-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-right: 4px;
}
.rpc-ts-pill {
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
.rpc-ts-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ts-pill-active {
  background: var(--rpc-red-bg);
  border-color: var(--rpc-red);
  color: var(--rpc-red);
}
.rpc-ts-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-ts-select {
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

.rpc-ts-list-wrap { max-width: 1180px; margin: 0 auto; }
.rpc-ts-state {
  padding: 48px 32px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 2px;
}
.rpc-ts-list { display: flex; flex-direction: column; gap: 8px; }
.rpc-ts-row {
  display: grid;
  grid-template-columns: 32px 56px minmax(0, 1fr) minmax(0, 1.1fr) auto;
  align-items: center;
  gap: 14px;
  text-decoration: none;
  color: inherit;
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  border-radius: 4px;
  padding: 10px 16px 10px 10px;
  transition: border-color 120ms, background 120ms, transform 120ms;
}
.rpc-ts-row:hover {
  border-color: var(--rpc-red);
  background: var(--rpc-surface-hover);
  transform: translateY(-1px);
}
.rpc-ts-rank {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--rpc-text-muted);
  text-align: center;
}
.rpc-ts-row-art {
  width: 56px;
  height: 56px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--rpc-surface-raised);
}
.rpc-ts-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-ts-img-fallback {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface));
}
.rpc-ts-row-main { min-width: 0; }
.rpc-ts-row-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.2;
  color: var(--rpc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rpc-ts-row-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--rpc-text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
}
.rpc-ts-dot { color: var(--rpc-text-ghost); }
.rpc-ts-row-parties { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rpc-ts-party-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.rpc-ts-party-line .rpc-ts-party-k {
  min-width: 12px;
  color: var(--rpc-red);
}
.rpc-ts-party-line .rpc-ts-party-v {
  font-size: 12px;
  min-width: 0;
}
.rpc-ts-row-right { text-align: right; white-space: nowrap; }
.rpc-ts-row-price {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 20px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}
.rpc-ts-row-when {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-top: 2px;
}

.rpc-ts-footer {
  max-width: 1180px;
  margin: 40px auto 0;
  padding-top: 24px;
  border-top: 1px solid var(--rpc-border-subtle);
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-ts-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-ts-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-ts-method strong { color: var(--rpc-text-primary); }
.rpc-ts-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ts-share-btn {
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
.rpc-ts-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ts-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--rpc-text-primary);
  border: 1px solid var(--rpc-border);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  padding: 13px 18px;
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 120ms, color 120ms;
}
.rpc-ts-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ts-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-ts-back:hover { color: var(--rpc-red); }

@media (max-width: 1100px) {
  .rpc-ts-hero-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .rpc-ts-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-ts-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-ts-footer { grid-template-columns: 1fr; }
  .rpc-ts-row {
    grid-template-columns: 24px 48px minmax(0, 1fr) auto;
  }
  .rpc-ts-row-parties { display: none; }
}
`
