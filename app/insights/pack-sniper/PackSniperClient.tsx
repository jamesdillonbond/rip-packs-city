"use client"

// app/insights/pack-sniper/PackSniperClient.tsx
//
// Client interactivity for the public Pack Sniper deal board. The server
// component fetches the default view (honest deals only, recency-ordered) and
// passes it as initialDeals so the ranked table + links render in the raw
// server HTML (crawlable). This layer adds the Sniper-style controls (sort,
// tier tabs, price/discount filters, 30s auto-refresh + pause) and the
// "as they get listed" recency badges (NEW / ▼ price drop).
//
// RANK, DON'T PRICE: ordering + "ask $X vs EV $Y", never a headline "92x".
// High-variance (chance-hit / single-chase / depleted) packs are hidden by
// default and revealed flagged. Every row links to the simulator.
//
// Recency note: "Recently Listed" + NEW/▼ come from RPC's own snapshots of the
// live pack book (every few min), NOT an exact on-chain listing timestamp —
// Top Shot's pack API doesn't expose one. Honest framing in the methodology.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const REFRESH_INTERVAL = 30

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
  askChangedAt: string | null
  askFirstSeenAt: string | null
  prevAsk: number | null
  isNew: boolean
  isPriceDrop: boolean
  askDropPct: number | null
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

type SortKey = "recent" | "drop" | "value" | "cheap" | "ev"

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently Listed" },
  { value: "drop", label: "Biggest Price Drop" },
  { value: "value", label: "Best EV / Ask" },
  { value: "cheap", label: "Cheapest Ask" },
  { value: "ev", label: "Highest EV" },
]

const TIER_RANK: Record<string, number> = {
  common: 0,
  fandom: 1,
  rare: 2,
  legendary: 3,
  ultimate: 4,
}

function recencyMs(d: Deal): number {
  const t = d.askChangedAt ? Date.parse(d.askChangedAt) : NaN
  return Number.isFinite(t) ? t : 0
}

const SORTERS: Record<SortKey, (a: Deal, b: Deal) => number> = {
  recent: (a, b) => recencyMs(b) - recencyMs(a) || b.liveValueRatio - a.liveValueRatio,
  drop: (a, b) => (b.askDropPct ?? -1) - (a.askDropPct ?? -1) || recencyMs(b) - recencyMs(a),
  value: (a, b) => b.liveValueRatio - a.liveValueRatio,
  cheap: (a, b) => a.lowestAsk - b.lowestAsk,
  ev: (a, b) => b.grossEV - a.grossEV,
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

function relTime(iso: string | null): string {
  if (!iso) return ""
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ""
  const m = Math.floor(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
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
  lockedCollection?: Collection
}

export default function PackSniperClient({ initialDeals, initialFetchedAt, lockedCollection }: Props) {
  const [collection, setCollection] = useState<Collection>(lockedCollection ?? "nba-top-shot")
  const [showHighVariance, setShowHighVariance] = useState(false)
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  // Sniper-style controls.
  const [sortBy, setSortBy] = useState<SortKey>("recent")
  const [tierTab, setTierTab] = useState<string>("all")
  const [maxAsk, setMaxAsk] = useState(0)
  const [minRatio, setMinRatio] = useState(0)
  const [search, setSearch] = useState("")
  const [recentOnly, setRecentOnly] = useState(false)
  const [paused, setPaused] = useState(false)
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL)

  // Time-sensitive relative labels (relTime) are client-only so SSR and the
  // first hydration render don't disagree at minute boundaries.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Out-of-order guard (newer fetch supersedes older) without AbortController.
  const reqIdRef = useRef(0)
  const fetchDeals = useCallback(async () => {
    const myId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set("collection", collection)
      params.set("limit", "200")
      params.set("include_high_variance", showHighVariance ? "true" : "false")
      const r = await fetch(`/api/public/insights/pack-sniper?${params.toString()}`, {
        cache: "no-store",
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as ApiResponse
      if (myId !== reqIdRef.current) return
      setDeals(j.deals ?? [])
      setFetchedAt(j.meta?.fetched_at ?? null)
    } catch (e: unknown) {
      if (myId !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      if (myId === reqIdRef.current) setLoading(false)
    }
  }, [collection, showHighVariance])

  // Refetch on collection / high-variance change, skipping the server-rendered
  // default (locked collection if set, else Top Shot; high-variance hidden).
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (collection === (lockedCollection ?? "nba-top-shot") && !showHighVariance) return
    }
    fetchDeals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, showHighVariance])

  // Auto-refresh: reset the countdown whenever a fetch was just triggered, and
  // tick it down once a second; on 0 refetch (unless paused).
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL)
  }, [collection, showHighVariance])

  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          fetchDeals()
          return REFRESH_INTERVAL
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [paused, fetchDeals])

  // Tier tabs reflect only the tiers actually present in the loaded set.
  const availableTiers = useMemo(() => {
    const set = new Set<string>()
    for (const d of deals) {
      const t = (d.tier || "").toLowerCase()
      if (t) set.add(t)
    }
    return Array.from(set).sort((a, b) => (TIER_RANK[a] ?? 99) - (TIER_RANK[b] ?? 99))
  }, [deals])

  // Filter + sort happen client-side over the loaded set (instant, no refetch).
  const processed = useMemo(() => {
    let rows = showHighVariance ? deals : deals.filter((d) => !d.highVariance)
    if (tierTab !== "all") rows = rows.filter((d) => (d.tier || "").toLowerCase() === tierTab)
    if (maxAsk > 0) rows = rows.filter((d) => d.lowestAsk <= maxAsk)
    if (minRatio > 1) rows = rows.filter((d) => d.liveValueRatio >= minRatio)
    if (recentOnly) rows = rows.filter((d) => d.isNew || d.isPriceDrop)
    if (search.trim()) {
      const s = search.trim().toLowerCase()
      rows = rows.filter((d) => (d.title || "").toLowerCase().includes(s))
    }
    return [...rows].sort(SORTERS[sortBy])
  }, [deals, showHighVariance, tierTab, maxAsk, minRatio, recentOnly, search, sortBy])

  const kpis = useMemo(() => {
    const hiddenHiVar = showHighVariance ? 0 : deals.filter((d) => d.highVariance).length
    if (processed.length === 0) return { count: 0, medianRatio: 0, bestRatio: 0, newCount: 0, hiddenHiVar }
    const ratios = processed.map((d) => d.liveValueRatio).sort((a, b) => a - b)
    const mid = Math.floor(ratios.length / 2)
    const medianRatio = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2
    const newCount = processed.filter((d) => d.isNew).length
    return { count: processed.length, medianRatio, bestRatio: ratios[ratios.length - 1], newCount, hiddenHiVar }
  }, [processed, deals, showHighVariance])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot shows a sealed pack's low ask. We show the ask vs the pack's expected pull value — and flag packs as they get listed.\n\nThe Pack Sniper:`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
      `${SITE_URL}/insights/pack-sniper`,
    )}`
  }, [])

  // toLocaleString renders in the runtime timezone (UTC on the server, local on
  // the client) → gate on `mounted` so SSR and the first hydration render agree
  // on "—", then the real timestamp paints after mount (avoids React #418).
  const updatedLabel =
    mounted && fetchedAt
      ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : "—"

  return (
    <main style={lockedCollection ? styles.pageEmbedded : styles.page}>
      <style>{CSS}</style>

      {lockedCollection ? (
        <section className="rpc-ps-hero rpc-ps-hero-compact">
          <h1 className="rpc-ps-h1 rpc-ps-h1-compact">
            The Pack Sniper <span className="rpc-ps-h1-coll">— {COLLECTION_LABEL[collection]}</span>
          </h1>
          <p className="rpc-ps-lede">
            Sealed {COLLECTION_LABEL[collection]} packs listed below their{" "}
            <strong>expected pull value</strong>, surfaced <em>as they get listed</em>. We rank{" "}
            <em>ask vs EV</em> — the ordering is the signal, not the number.
          </p>
          <div className="rpc-ps-meta-row">
            <span className="rpc-ps-meta">Updated {updatedLabel}</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">Live asks · auto-refresh</span>
          </div>
        </section>
      ) : (
        <section className="rpc-ps-hero">
          <div className="rpc-ps-eyebrow">RPC Insights · Public</div>
          <h1 className="rpc-ps-h1">The Pack Sniper</h1>
          <p className="rpc-ps-lede">
            Top Shot&apos;s marketplace shows you a sealed pack&apos;s <em>low ask</em>. We show that
            ask against the pack&apos;s <strong>expected pull value</strong> — and flag packs{" "}
            <em>as they get listed</em> or drop in price, so you can catch a deal before the market
            does.
          </p>
          <div className="rpc-ps-meta-row">
            <span className="rpc-ps-meta">Updated {updatedLabel}</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">Live asks · auto-refresh</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">No signup</span>
          </div>
        </section>
      )}

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <section className="rpc-ps-controls" aria-label="Controls">
        {!lockedCollection && (
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
        )}

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Search</span>
          <input
            className="rpc-ps-input rpc-ps-input-search"
            type="search"
            inputMode="search"
            placeholder="pack name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Sort</span>
          <select
            className="rpc-ps-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {availableTiers.length > 0 && (
          <div className="rpc-ps-pill-group" role="tablist" aria-label="Tier">
            <button
              role="tab"
              aria-selected={tierTab === "all"}
              className={`rpc-ps-pill ${tierTab === "all" ? "rpc-ps-pill-active" : ""}`}
              onClick={() => setTierTab("all")}
            >
              All tiers
            </button>
            {availableTiers.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tierTab === t}
                className={`rpc-ps-pill ${tierTab === t ? "rpc-ps-pill-active" : ""}`}
                onClick={() => setTierTab(t)}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Max ask $</span>
          <input
            className="rpc-ps-input"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="any"
            value={maxAsk || ""}
            onChange={(e) => setMaxAsk(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Min EV / ask</span>
          <input
            className="rpc-ps-input"
            type="number"
            min={1}
            step={0.1}
            inputMode="decimal"
            placeholder="1.0×"
            value={minRatio || ""}
            onChange={(e) => setMinRatio(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>

        <label className="rpc-ps-toggle">
          <input
            type="checkbox"
            checked={recentOnly}
            onChange={(e) => setRecentOnly(e.target.checked)}
          />
          <span>Just listed / price drops only</span>
        </label>

        <label className="rpc-ps-toggle">
          <input
            type="checkbox"
            checked={showHighVariance}
            onChange={(e) => setShowHighVariance(e.target.checked)}
          />
          <span>
            High-variance packs{kpis.hiddenHiVar > 0 ? ` (${kpis.hiddenHiVar} hidden)` : ""}
          </span>
        </label>

        <div className="rpc-ps-refresh">
          <span className="rpc-ps-countdown">{paused ? "paused" : `↻ ${countdown}s`}</span>
          <button
            className="rpc-ps-refresh-btn"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            className="rpc-ps-refresh-btn"
            onClick={() => {
              setCountdown(REFRESH_INTERVAL)
              fetchDeals()
            }}
          >
            Refresh now
          </button>
        </div>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-ps-kpi-row" aria-label="Summary">
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Deals shown</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : kpis.count}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Just listed (2h)</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : kpis.newCount}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Median EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.medianRatio)}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Best EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.bestRatio)}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-ps-table-wrap" aria-label="Pack deals">
        {error ? (
          <div className="rpc-ps-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ps-state">Loading…</div>
        ) : processed.length === 0 ? (
          <div className="rpc-ps-state">
            No sealed packs match your filters
            {tierTab !== "all" || maxAsk > 0 || minRatio > 1 ? " (try loosening them)" : ""}
            {!showHighVariance ? " — or show high-variance packs" : ""}. The market is efficient
            right now — check back as new packs get listed.
          </div>
        ) : (
          <table className="rpc-ps-table">
            <thead>
              <tr>
                <th className="rpc-ps-th-pack">Pack</th>
                <th className="rpc-ps-th-num">Tier</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">Live ask</th>
                <th className="rpc-ps-th-num rpc-ps-col-optional">Gross EV</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">EV / ask</th>
                <th className="rpc-ps-th-num rpc-ps-col-optional">FMV cov.</th>
                <th className="rpc-ps-th-act">Actions</th>
              </tr>
            </thead>
            <tbody>
              {processed.map((d) => (
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
                          <span>
                            {d.slots} {d.slots === 1 ? "slot" : "slots"}
                          </span>
                          {d.isNew ? (
                            <span className="rpc-ps-new-chip">NEW</span>
                          ) : d.isPriceDrop ? (
                            <span
                              className="rpc-ps-drop-chip"
                              title={d.prevAsk ? `Dropped from ${fmtUsd(d.prevAsk)}` : "Price dropped"}
                            >
                              ▼ {d.askDropPct != null ? `${Math.round(d.askDropPct * 100)}%` : "drop"}
                            </span>
                          ) : null}
                          {mounted && d.askChangedAt ? (
                            <span className="rpc-ps-listed-rel">{relTime(d.askChangedAt)}</span>
                          ) : null}
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
                  <td className="rpc-ps-td-num rpc-ps-col-optional">{fmtUsd(d.grossEV)}</td>
                  <td className={`rpc-ps-td-num rpc-ps-td-emph ${d.highVariance ? "rpc-ps-td-hivar" : ""}`}>
                    {fmtRatio(d.liveValueRatio)}
                  </td>
                  <td className="rpc-ps-td-num rpc-ps-col-optional">{d.fmvCoveragePct}%</td>
                  <td className="rpc-ps-td-act">
                    <TrackedOutboundLink
                      href={d.buyUrl}
                      payload={{
                        surface: "pack-sniper",
                        destination: "topshot",
                        setName: d.title.trim() || null,
                        tier: d.tier ?? null,
                        askPrice: Number.isFinite(d.lowestAsk) ? d.lowestAsk : null,
                        fmv: Number.isFinite(d.grossEV) ? d.grossEV : null,
                        discount: Number.isFinite(d.discountPct) ? d.discountPct : null,
                        buyUrl: d.buyUrl,
                      }}
                      className="rpc-ps-act rpc-ps-act-buy"
                    >
                      View Listing ↗
                    </TrackedOutboundLink>
                    {d.dapperUrl && d.dapperUrl !== d.buyUrl ? (
                      <TrackedOutboundLink
                        href={d.dapperUrl}
                        payload={{
                          surface: "pack-sniper",
                          destination: "dapper_market_packs",
                          setName: d.title.trim() || null,
                          tier: d.tier ?? null,
                          askPrice: Number.isFinite(d.lowestAsk) ? d.lowestAsk : null,
                          fmv: Number.isFinite(d.grossEV) ? d.grossEV : null,
                          discount: Number.isFinite(d.discountPct) ? d.discountPct : null,
                          buyUrl: d.dapperUrl,
                        }}
                        className="rpc-ps-act"
                      >
                        dapper.market ↗
                      </TrackedOutboundLink>
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
            <strong>Gross EV</strong> is the <em>drop-weighted expectation</em> of a single
            pack&apos;s pull value, summed across the live drop pool using RPC&apos;s FMV.{" "}
            <strong>EV / ask</strong> = gross EV ÷ the live lowest secondary ask. We rank by EV / ask
            — the <em>ordering</em> is the signal, not the number.
          </p>
          <p>
            <strong>&ldquo;Recently listed&rdquo;, NEW and ▼ are snapshot-derived.</strong> Top
            Shot&apos;s pack feed doesn&apos;t expose a per-listing timestamp, so we snapshot the
            live pack book every few minutes and diff it. A pack is flagged <strong>NEW</strong> when
            its lowest ask first appears in our snapshot (within the last 2h) and <strong>▼</strong>{" "}
            when that ask drops. Treat them as &ldquo;changed recently,&rdquo; not a precise on-chain
            clock.
          </p>
          <p>
            <strong>Variance is huge.</strong> EV is an average, not what you should expect to pull.
            A pack with one rare chase can show a high EV while the <em>typical</em> rip returns far
            less. We hide chance-hit / single-chase / heavily-depleted packs by default (toggle
            above) and flag them when shown. The <strong>Simulate</strong> link on every row shows
            the real outcome distribution — use it before buying.
          </p>
          <p>
            Only packs with ≥80% FMV coverage, an EV snapshot from the last 72h, and a live secondary
            listing appear here. EV / ask updates as the EV recomputes and the market moves; a deal
            can close before you click.
          </p>
          <p>
            Want the honest history instead?{" "}
            <Link href="/insights/pack-reality" className="rpc-ps-xlink">
              Pack Reality audits every rip of the last 60 days →
            </Link>
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
  pageEmbedded: {
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "4px 0 40px",
  },
}

const CSS = `
.rpc-ps-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ps-hero-compact { margin-bottom: 18px; padding-bottom: 16px; }
.rpc-ps-h1-compact { font-size: clamp(28px, 4vw, 40px); margin-bottom: 10px; }
.rpc-ps-h1-coll { color: var(--rpc-text-muted); font-weight: 700; }
.rpc-ps-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ps-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ps-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ps-lede strong { color: var(--rpc-text-primary); }
.rpc-ps-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-ps-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ps-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 14px 20px; align-items: flex-end; }
.rpc-ps-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ps-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-ps-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ps-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ps-field { display: inline-flex; flex-direction: column; gap: 5px; }
.rpc-ps-field-label { font-family: var(--font-mono); font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-select, .rpc-ps-input { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-primary); background: var(--rpc-surface-raised); border: 1px solid var(--rpc-border); border-radius: 2px; padding: 7px 10px; }
.rpc-ps-select:hover, .rpc-ps-input:hover { border-color: var(--rpc-border-hover); }
.rpc-ps-select:focus, .rpc-ps-input:focus { outline: none; border-color: var(--rpc-red); box-shadow: 0 0 0 2px var(--rpc-red-bg); }
.rpc-ps-input { width: 92px; }
.rpc-ps-input-search { width: 150px; }
.rpc-ps-toggle { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-secondary); cursor: pointer; }
.rpc-ps-toggle input { accent-color: var(--rpc-red); width: 15px; height: 15px; cursor: pointer; }
.rpc-ps-refresh { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.rpc-ps-countdown { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); min-width: 56px; text-align: right; }
.rpc-ps-refresh-btn { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; padding: 6px 12px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms; }
.rpc-ps-refresh-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-ps-kpi-row { max-width: 1180px; margin: 0 auto 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.rpc-ps-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-ps-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-ps-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

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
.rpc-ps-pack-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-text-muted); display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.rpc-ps-new-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; color: var(--rpc-success); border: 1px solid var(--rpc-success); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-drop-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1px; color: var(--rpc-warning); border: 1px solid var(--rpc-warning); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-listed-rel { color: var(--rpc-text-ghost); }
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
.rpc-ps-xlink { color: var(--rpc-red); text-decoration: none; font-weight: 600; }
.rpc-ps-xlink:hover { text-decoration: underline; }
.rpc-ps-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ps-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-ps-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ps-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ps-back:hover { color: var(--rpc-red); }

/* Below ~900px the 7-col table overflows and the View Listing CTA scrolls off.
   Hide the two least-critical columns (Gross EV, FMV cov.) so Pack / Tier /
   Live ask / EV÷ask / Actions fit without horizontal scroll. */
@media (max-width: 900px) {
  .rpc-ps-col-optional { display: none; }
}

@media (max-width: 760px) {
  .rpc-ps-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-ps-footer { grid-template-columns: 1fr; }
  .rpc-ps-table { font-size: 13px; }
  .rpc-ps-td-pack { min-width: 200px; }
  .rpc-ps-refresh { margin-left: 0; }
}
`
