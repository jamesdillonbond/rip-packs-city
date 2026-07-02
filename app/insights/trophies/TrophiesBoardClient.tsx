"use client"

// app/insights/trophies/TrophiesBoardClient.tsx
//
// Client interactivity layer for the public Trophy Room. The server component
// (page.tsx) fetches the default-view rows server-side and passes them in as
// `initialRows`, so the ranked trophy grid + per-tile entity drill-down links
// render in the raw server HTML (crawlable) instead of only after JS. This
// component layers collection / type filters + sort on top as progressive
// enhancement and only refetches when the user changes them — the default
// view never refetches on mount.
//
// Honesty (do NOT fake FMV): grails rarely trade, so most rows are ASK_ONLY /
// STALE / NULL. Unpriced rows render "—" / "Awaiting a comp", never $0. The
// hero strip leads with the priced trophies; everything else is still a real,
// rare edition and stays in the grid.
//
// See app/insights/trophies/page.tsx for the data source + server fetch.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import { proxyIpfsUrl } from "@/lib/ipfs-media"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type Row = {
  edition_id: string
  external_id: string | null
  collection: string | null
  collection_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  video_url: string | null
  is_one_of_one: boolean | null
  is_ultimate: boolean | null
  fmv_usd: number | null
  confidence: string | null
  fmv_computed_at: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number; elapsed_ms: number }
  rows: Row[]
}

type CollectionFilter = "all" | "nba_top_shot" | "nfl_all_day"
type TypeFilter = "all" | "one_of_one" | "ultimate"
type SortKey = "fmv" | "circulation"

const COLLECTIONS: { val: CollectionFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "nba_top_shot", label: "Top Shot" },
  { val: "nfl_all_day", label: "NFL All Day" },
]
const TYPES: { val: TypeFilter; label: string }[] = [
  { val: "all", label: "All grails" },
  { val: "one_of_one", label: "1 of 1" },
  { val: "ultimate", label: "Ultimate" },
]

// Long-form collection string → in-app route slug. The edition pages live at
// /<slug>/edition/<external_id>; the two collections present in the view map
// cleanly with _ → -.
function collectionSlug(c: string | null): string {
  if (!c) return "nba-top-shot"
  return c.replace(/_/g, "-")
}

function normalizeTier(t: string | null): string | null {
  if (!t) return null
  return t.replace(/^MOMENT_TIER_/, "")
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

// Trophy badge label: a 1-of-1 is the headline; otherwise an Ultimate shows
// its (tiny) circulation. Distinguishes "/10 Ultimate" from "1 of 1".
function trophyBadge(r: Row): string {
  if (r.is_one_of_one) return "1 OF 1"
  if (r.is_ultimate) {
    return r.circulation_count != null ? `/${r.circulation_count} ULTIMATE` : "ULTIMATE"
  }
  const t = normalizeTier(r.tier)
  return t ?? "GRAIL"
}

// Confidence is honest: a $10k STALE Supernova is a last-known number, not a
// live quote. Color it so the chip reads as a caveat, not a guarantee.
function confidenceMeta(c: string | null): { label: string; color: string } {
  switch (c) {
    case "HIGH":
      return { label: "HIGH", color: "var(--tier-fandom, #34D399)" }
    case "MEDIUM":
      return { label: "MED", color: "var(--tier-rare, #818CF8)" }
    case "LOW":
      return { label: "LOW", color: "var(--rpc-text-secondary)" }
    case "SALES_ONLY":
      return { label: "SALES", color: "var(--rpc-text-secondary)" }
    case "ASK_ONLY":
      return { label: "ASK", color: "var(--rpc-text-muted)" }
    case "STALE":
      return { label: "STALE", color: "var(--rpc-text-muted)" }
    default:
      return { label: "NO COMP", color: "var(--rpc-text-ghost, var(--rpc-text-muted))" }
  }
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

function TrophyTile({ r, hero = false }: { r: Row; hero?: boolean }) {
  const [imgOk, setImgOk] = useState(true)
  const href = r.external_id
    ? `/${collectionSlug(r.collection)}/edition/${encodeURIComponent(r.external_id)}`
    : `/moment/${r.edition_id}`
  const conf = confidenceMeta(r.confidence)
  const title = r.player_name || r.name || r.set_name || "—"
  const priced = r.fmv_usd != null

  return (
    <Link href={href} className={`rpc-tr-tile ${hero ? "rpc-tr-tile-hero" : ""}`}>
      <div className="rpc-tr-art">
        {r.thumbnail_url && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxyIpfsUrl(r.thumbnail_url) ?? undefined}
            alt={title}
            className="rpc-tr-img"
            loading="lazy"
            onError={() => setImgOk(false)}
          />
        ) : (
          <div className="rpc-tr-img-fallback" aria-hidden />
        )}
        <span
          className="rpc-tr-badge"
          style={{ color: r.is_one_of_one ? "var(--rpc-red)" : tierColor(r.tier) }}
        >
          {trophyBadge(r)}
        </span>
      </div>
      <div className="rpc-tr-body">
        <div className="rpc-tr-name">{title}</div>
        {r.set_name ? <div className="rpc-tr-set">{r.set_name}</div> : null}
        <div className="rpc-tr-stats">
          <span className="rpc-tr-circ">{r.is_one_of_one ? "1 minted" : `${fmtInt(r.circulation_count)} minted`}</span>
          <span className="rpc-tr-fmv-wrap">
            {priced ? (
              <>
                <span className="rpc-tr-fmv">{fmtUsd(r.fmv_usd)}</span>
                <span className="rpc-tr-conf" style={{ color: conf.color }}>
                  {conf.label}
                </span>
              </>
            ) : (
              <span className="rpc-tr-nocomp">Awaiting a comp</span>
            )}
          </span>
        </div>
      </div>
    </Link>
  )
}

type Props = {
  initialRows: Row[]
  initialFetchedAt: string | null
}

export default function TrophiesBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  const [collection, setCollection] = useState<CollectionFilter>("all")
  const [type, setType] = useState<TypeFilter>("all")
  const [sort, setSort] = useState<SortKey>("fmv")

  // Skip the first fetch when the params match the server-fetched default view
  // (all/all/fmv) — the server already gave us those rows. Any filter/sort
  // change refetches normally.
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (collection === "all" && type === "all" && sort === "fmv") return
    }
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set("limit", "200")
        params.set("sort", sort)
        params.set("type", type)
        if (collection !== "all") params.set("collection", collection)
        const r = await fetch(`/api/public/insights/trophies?${params.toString()}`, {
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
  }, [collection, type, sort])

  // Hero = the top priced trophies (FMV-desc already). Lead with real numbers;
  // the never-traded grails fill the grid below.
  const heroRows = useMemo(() => rows.filter((r) => r.fmv_usd != null).slice(0, 4), [rows])

  const kpis = useMemo(() => {
    const priced = rows.filter((r) => r.fmv_usd != null)
    const oneOfOne = rows.filter((r) => r.is_one_of_one).length
    const topFmv = priced.length ? Math.max(...priced.map((r) => Number(r.fmv_usd))) : null
    return { count: rows.length, oneOfOne, priced: priced.length, topFmv }
  }, [rows])

  const tweetIntent = useMemo(() => {
    const text = `The rarest things on Flow, in one place.\n\nEvery 1-of-1 + Ultimate-tier moment across NBA Top Shot and NFL All Day — the Trophy Room:`
    const url = `${SITE_URL}/insights/trophies`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-tr-hero-head">
        <div className="rpc-tr-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-tr-h1">The Trophy Room</h1>
        <p className="rpc-tr-lede">
          The rarest editions on Flow, in one place — every{" "}
          <strong>1-of-1</strong> and every <strong>Ultimate-tier</strong>{" "}
          moment across NBA Top Shot and NFL All Day, ranked by value. Most have
          never traded. That&apos;s what makes them trophies.
        </p>
        <div className="rpc-tr-meta-row">
          <span className="rpc-tr-meta">
            Updated <FreshnessStamp iso={fetchedAt} />
          </span>
          <span className="rpc-tr-meta-sep">·</span>
          <span className="rpc-tr-meta">No signup</span>
        </div>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-tr-kpi-row" aria-label="Summary">
        <div className="rpc-tr-kpi">
          <div className="rpc-tr-kpi-label">Trophies</div>
          <div className="rpc-tr-kpi-value">{fmtInt(kpis.count)}</div>
        </div>
        <div className="rpc-tr-kpi">
          <div className="rpc-tr-kpi-label">1-of-1s</div>
          <div className="rpc-tr-kpi-value">{fmtInt(kpis.oneOfOne)}</div>
        </div>
        <div className="rpc-tr-kpi">
          <div className="rpc-tr-kpi-label">With a comp</div>
          <div className="rpc-tr-kpi-value">{fmtInt(kpis.priced)}</div>
        </div>
        <div className="rpc-tr-kpi">
          <div className="rpc-tr-kpi-label">Top value</div>
          <div className="rpc-tr-kpi-value">{fmtUsd(kpis.topFmv)}</div>
        </div>
      </section>

      {/* ── Hero strip: top priced trophies ───────────────────────────── */}
      {heroRows.length > 0 ? (
        <section className="rpc-tr-hero-strip" aria-label="Featured trophies">
          <div className="rpc-tr-section-label">Featured · highest value</div>
          <div className="rpc-tr-hero-grid">
            {heroRows.map((r) => (
              <TrophyTile key={r.edition_id} r={r} hero />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Filter row ────────────────────────────────────────────────── */}
      <section className="rpc-tr-controls" aria-label="Filters">
        <div className="rpc-tr-pill-group" role="tablist" aria-label="Collection">
          <span className="rpc-tr-pill-label">COLLECTION</span>
          {COLLECTIONS.map((c) => (
            <button
              key={c.val}
              role="tab"
              aria-selected={collection === c.val}
              className={`rpc-tr-pill ${collection === c.val ? "rpc-tr-pill-active" : ""}`}
              onClick={() => setCollection(c.val)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="rpc-tr-pill-group" role="tablist" aria-label="Trophy class">
          <span className="rpc-tr-pill-label">CLASS</span>
          {TYPES.map((t) => (
            <button
              key={t.val}
              role="tab"
              aria-selected={type === t.val}
              className={`rpc-tr-pill ${type === t.val ? "rpc-tr-pill-active" : ""}`}
              onClick={() => setType(t.val)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="rpc-tr-sort">
          <span className="rpc-tr-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-tr-select"
          >
            <option value="fmv">Value (desc)</option>
            <option value="circulation">Circulation (asc)</option>
          </select>
        </label>
      </section>

      {/* ── Grid ──────────────────────────────────────────────────────── */}
      <section className="rpc-tr-grid-wrap" aria-label="Trophy Room">
        {error ? (
          <div className="rpc-tr-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-tr-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-tr-state">No trophies match those filters.</div>
        ) : (
          <div className="rpc-tr-grid">
            {rows.map((r) => (
              <TrophyTile key={r.edition_id} r={r} />
            ))}
          </div>
        )}
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <section className="rpc-tr-footer">
        <div className="rpc-tr-method">
          <h3 className="rpc-tr-h3">What counts as a trophy</h3>
          <p>
            Every <strong>1-of-1</strong> edition (circulation of one) and every{" "}
            <strong>Ultimate-tier</strong> moment in NBA Top Shot and NFL All
            Day. These are the scarcest editions the two collections produce.
          </p>
          <p>
            Most trophies have <em>never traded</em>, so the value column is
            mostly a standing ask or a last-known sale, flagged with a confidence
            chip — <strong>ASK</strong> (a live listing), <strong>STALE</strong>{" "}
            (an old sale), <strong>NO COMP</strong> (never sold, never listed).
            An unpriced trophy isn&apos;t worthless; it&apos;s a grail nobody has
            put a number on yet. FMV from the RPC 1.7.0 model.
          </p>
        </div>

        <div className="rpc-tr-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-tr-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-tr-back">
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
.rpc-tr-hero-head {
  max-width: 1180px;
  margin: 0 auto 24px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-tr-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 12px;
}
.rpc-tr-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(38px, 6vw, 64px);
  letter-spacing: 0.5px;
  line-height: 1.02;
  margin: 0 0 14px;
  text-transform: uppercase;
}
.rpc-tr-lede {
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 780px;
  margin: 0 0 16px;
}
.rpc-tr-lede strong { color: var(--rpc-text-primary); }
.rpc-tr-meta-row {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-tr-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-tr-kpi-row {
  max-width: 1180px;
  margin: 0 auto 26px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-tr-kpi {
  border: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface-raised);
  padding: 14px 16px;
  border-radius: 2px;
}
.rpc-tr-kpi-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 6px;
}
.rpc-tr-kpi-value {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  color: var(--rpc-red);
  letter-spacing: 0.5px;
}

.rpc-tr-section-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 12px;
}
.rpc-tr-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-tr-hero-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.rpc-tr-controls {
  max-width: 1180px;
  margin: 0 auto 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  align-items: center;
}
.rpc-tr-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-tr-pill-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-right: 4px;
}
.rpc-tr-pill {
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
.rpc-tr-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-tr-pill-active {
  background: var(--rpc-red-bg);
  border-color: var(--rpc-red);
  color: var(--rpc-red);
}
.rpc-tr-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-tr-select {
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

.rpc-tr-grid-wrap { max-width: 1180px; margin: 0 auto; }
.rpc-tr-state {
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
.rpc-tr-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.rpc-tr-tile {
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
.rpc-tr-tile:hover {
  border-color: var(--rpc-red);
  background: var(--rpc-surface-hover);
  transform: translateY(-2px);
}
.rpc-tr-tile-hero { border-color: var(--rpc-red-border); }
.rpc-tr-art {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--rpc-surface-raised);
}
.rpc-tr-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-tr-img-fallback {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface));
}
.rpc-tr-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  padding: 4px 8px;
  background: var(--rpc-black);
  border: 1px solid var(--rpc-border);
  border-radius: 2px;
}
.rpc-tr-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-tr-name {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.2;
  color: var(--rpc-text-primary);
}
.rpc-tr-set {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--rpc-text-muted);
  line-height: 1.3;
}
.rpc-tr-stats {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.rpc-tr-circ {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  white-space: nowrap;
}
.rpc-tr-fmv-wrap { display: inline-flex; align-items: baseline; gap: 6px; }
.rpc-tr-fmv {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 18px;
  color: var(--rpc-red);
}
.rpc-tr-conf {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
.rpc-tr-nocomp {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  font-style: italic;
}

.rpc-tr-footer {
  max-width: 1180px;
  margin: 40px auto 0;
  padding-top: 24px;
  border-top: 1px solid var(--rpc-border-subtle);
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 32px;
}
.rpc-tr-method h3 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.rpc-tr-method p {
  font-size: 14px;
  line-height: 1.65;
  color: var(--rpc-text-secondary);
  margin: 0 0 12px;
}
.rpc-tr-method strong { color: var(--rpc-text-primary); }
.rpc-tr-method em { color: var(--rpc-text-primary); font-style: italic; }
.rpc-tr-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-tr-share-btn {
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
.rpc-tr-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-tr-back {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-secondary);
  text-decoration: none;
  padding: 10px;
  text-align: center;
}
.rpc-tr-back:hover { color: var(--rpc-red); }

@media (max-width: 1100px) {
  .rpc-tr-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-tr-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .rpc-tr-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-tr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-tr-footer { grid-template-columns: 1fr; }
}
`
