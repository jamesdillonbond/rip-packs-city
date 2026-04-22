"use client"

// Phase 3 — Market page.
// Sortable / filterable browser of every listing in the active collection.
// Distinct from /sniper (deal-focused) and /collection (wallet-focused).

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useCollectionContext } from "@/lib/hooks/useCollectionContext"

type Listing = {
  id: string
  flowId: string | null
  momentId: string | null
  playerName: string | null
  teamName: string | null
  setName: string | null
  seriesName: string | null
  tier: string | null
  serialNumber: number | null
  circulationCount: number | null
  askPrice: number | null
  fmv: number | null
  discount: number | null
  confidence: string | null
  source: string | null
  buyUrl: string | null
  thumbnailUrl: string | null
  badgeSlugs: string[]
  listingResourceId: string | null
  storefrontAddress: string | null
  isLocked: boolean | null
  listedAt: string | null
  cachedAt: string | null
  collectionId: string
}

type MarketResponse = {
  listings: Listing[]
  pagination: { total: number; page: number; limit: number; hasMore: boolean }
  clamp: { applied: boolean; ceilings: Record<string, number> }
  diagnostics: { rawCount: number; postClampCount: number; postFilterCount: number }
}

type HealthPerCollection = {
  slug: string
  name: string
  sales_24h: number
  fmv_coverage_pct: number | null
}

type SortKey =
  | "recent"
  | "price_asc" | "price_desc"
  | "discount_asc" | "discount_desc"
  | "fmv_asc" | "fmv_desc"

const SORT_LABELS: Record<SortKey, string> = {
  recent:         "Recently listed",
  price_asc:      "Price ↑",
  price_desc:     "Price ↓",
  discount_desc:  "Discount ↓",
  discount_asc:   "Discount ↑",
  fmv_asc:        "FMV ↑",
  fmv_desc:       "FMV ↓",
}

const TIER_COLORS: Record<string, string> = {
  COMMON:     "var(--tier-common)",
  UNCOMMON:   "var(--tier-uncommon)",
  FANDOM:     "var(--tier-fandom)",
  RARE:       "var(--tier-rare)",
  LEGENDARY:  "var(--tier-legendary)",
  ULTIMATE:   "var(--tier-ultimate)",
  CHAMPION:   "var(--tier-champion)",
  CHALLENGER: "var(--tier-challenger)",
  CONTENDER:  "var(--tier-contender)",
}

const COLLECTION_TIERS: Record<string, string[]> = {
  "nba-top-shot":    ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"],
  "nfl-all-day":     ["COMMON", "RARE", "LEGENDARY", "ULTIMATE"],
  "laliga-golazos":  ["COMMON", "FANDOM", "UNCOMMON", "RARE", "LEGENDARY"],
  "disney-pinnacle": [],
  "ufc":             ["CONTENDER", "FANDOM", "CHALLENGER", "CHAMPION"],
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDiscount(d: number | null): { text: string; color: string } {
  if (d == null) return { text: "—", color: "var(--rpc-text-ghost)" }
  if (d >= 25) return { text: `-${d.toFixed(0)}%`, color: "#22C55E" }
  if (d >= 10) return { text: `-${d.toFixed(0)}%`, color: "#84CC16" }
  if (d > 0)  return { text: `-${d.toFixed(0)}%`, color: "var(--rpc-text-secondary)" }
  if (d < 0)  return { text: `+${Math.abs(d).toFixed(0)}%`, color: "#EF4444" }
  return { text: "0%", color: "var(--rpc-text-muted)" }
}

function relativeAge(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function MarketInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { collection, collectionId, supabaseCollectionId, accent, momentUrl } = useCollectionContext()

  // ── View state (table / grid) ─────────────────────────────────────────
  const [view, setView] = useState<"grid" | "table">(() => {
    return (searchParams.get("view") === "table" ? "table" : "grid")
  })

  // ── Filters — initialized from URL so deep-linking works ─────────────
  const [tiersSel, setTiersSel] = useState<string[]>(() => {
    const v = searchParams.get("tier")
    return v ? v.split(",").filter(Boolean) : []
  })
  const [minPrice, setMinPrice] = useState<string>(searchParams.get("minPrice") ?? "")
  const [maxPrice, setMaxPrice] = useState<string>(searchParams.get("maxPrice") ?? "")
  const [minDiscount, setMinDiscount] = useState<string>(searchParams.get("minDiscount") ?? "")
  const [playerQuery, setPlayerQuery] = useState<string>(searchParams.get("player") ?? "")
  const [hasBadges, setHasBadges] = useState<boolean>(searchParams.get("hasBadges") === "true")
  const [sort, setSort] = useState<SortKey>(() => {
    const v = (searchParams.get("sort") as SortKey) ?? "recent"
    return (Object.keys(SORT_LABELS) as SortKey[]).includes(v) ? v : "recent"
  })
  const [page, setPage] = useState<number>(() => {
    const v = parseInt(searchParams.get("page") ?? "1", 10)
    return Number.isFinite(v) && v > 0 ? v : 1
  })

  // Debounced player query so we don't hammer the API on every keystroke.
  const [debouncedPlayer, setDebouncedPlayer] = useState(playerQuery)
  useEffect(() => {
    const h = setTimeout(() => setDebouncedPlayer(playerQuery.trim()), 350)
    return () => clearTimeout(h)
  }, [playerQuery])

  // Any time an active filter changes, snap back to page 1.
  useEffect(() => { setPage(1) }, [tiersSel.join(","), minPrice, maxPrice, minDiscount, debouncedPlayer, hasBadges, sort])

  // ── Data ─────────────────────────────────────────────────────────────
  const [data, setData] = useState<MarketResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchKey = useMemo(() => {
    const params = new URLSearchParams()
    if (supabaseCollectionId) params.set("collectionId", supabaseCollectionId)
    if (tiersSel.length > 0) params.set("tier", tiersSel.join(","))
    if (minPrice) params.set("minPrice", minPrice)
    if (maxPrice) params.set("maxPrice", maxPrice)
    if (minDiscount) params.set("minDiscount", minDiscount)
    if (debouncedPlayer) params.set("player", debouncedPlayer)
    if (hasBadges) params.set("hasBadges", "true")
    params.set("sort", sort)
    params.set("page", String(page))
    params.set("limit", "50")
    return params.toString()
  }, [supabaseCollectionId, tiersSel, minPrice, maxPrice, minDiscount, debouncedPlayer, hasBadges, sort, page])

  useEffect(() => {
    if (!supabaseCollectionId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/market?${fetchKey}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: MarketResponse) => { if (!cancelled) setData(j) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchKey, supabaseCollectionId])

  // Push filter/sort/page state into the URL so deep-links work + back/forward
  // navigation preserves filter state.
  useEffect(() => {
    const sp = new URLSearchParams()
    if (tiersSel.length > 0) sp.set("tier", tiersSel.join(","))
    if (minPrice) sp.set("minPrice", minPrice)
    if (maxPrice) sp.set("maxPrice", maxPrice)
    if (minDiscount) sp.set("minDiscount", minDiscount)
    if (debouncedPlayer) sp.set("player", debouncedPlayer)
    if (hasBadges) sp.set("hasBadges", "true")
    if (sort !== "recent") sp.set("sort", sort)
    if (page > 1) sp.set("page", String(page))
    if (view === "table") sp.set("view", "table")
    const qs = sp.toString()
    try { router.replace(qs ? `?${qs}` : "?", { scroll: false }) } catch { /* ignore */ }
  }, [tiersSel, minPrice, maxPrice, minDiscount, debouncedPlayer, hasBadges, sort, page, view, router])

  // ── Thin-volume notice — reads /api/ready's per_collection array ─────
  // (/api/health is a minimal liveness probe; readiness telemetry lives at
  // /api/ready.)
  const [healthRow, setHealthRow] = useState<HealthPerCollection | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch("/api/ready", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j?.per_collection) return
        const row = (j.per_collection as HealthPerCollection[]).find(r => r.slug === collectionId)
        setHealthRow(row ?? null)
      })
      .catch(() => { /* swallow — not critical */ })
    return () => { cancelled = true }
  }, [collectionId])

  const thinVolume = healthRow != null && (healthRow.sales_24h ?? 0) < 10

  // ── Filter controls ──────────────────────────────────────────────────
  const availableTiers = COLLECTION_TIERS[collectionId] ?? []

  const toggleTier = useCallback((t: string) => {
    setTiersSel(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }, [])

  const clearFilters = useCallback(() => {
    setTiersSel([])
    setMinPrice("")
    setMaxPrice("")
    setMinDiscount("")
    setPlayerQuery("")
    setHasBadges(false)
    setSort("recent")
    setPage(1)
  }, [])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (tiersSel.length > 0) n++
    if (minPrice) n++
    if (maxPrice) n++
    if (minDiscount) n++
    if (debouncedPlayer) n++
    if (hasBadges) n++
    return n
  }, [tiersSel, minPrice, maxPrice, minDiscount, debouncedPlayer, hasBadges])

  // ── Render ───────────────────────────────────────────────────────────
  if (!collection) {
    return <div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>Unknown collection.</div>
  }

  const listings = data?.listings ?? []
  const total = data?.pagination.total ?? 0
  const hasMore = data?.pagination.hasMore ?? false

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Thin-volume notice ── */}
      {thinVolume && (
        <div
          className="rpc-mono"
          style={{
            padding: "8px 14px",
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.3)",
            borderRadius: "var(--radius-sm)",
            fontSize: 11,
            color: "#F59E0B",
            letterSpacing: "0.06em",
          }}
        >
          THIN-VOLUME ECOSYSTEM — analytics directional only. Treat discounts loosely when confidence is mostly LOW.
        </div>
      )}

      {/* ── Filter bar — HUD-styled (scoped scanline overlay via rpc-thead-scanline
           — `rpc-scanlines` is a viewport-wide fixed overlay, not what we want here) ── */}
      <section
        className="rpc-card rpc-thead-scanline"
        style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, position: "relative", overflow: "hidden" }}
      >
        {/* Row 1: tier chips + sort + view toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="rpc-label">Tier</span>
          {availableTiers.length === 0 ? (
            <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-ghost)" }}>—</span>
          ) : availableTiers.map(t => {
            const on = tiersSel.includes(t)
            const color = TIER_COLORS[t] ?? "var(--rpc-text-muted)"
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTier(t)}
                className="rpc-chip"
                style={{
                  color: on ? "#fff" : color,
                  borderColor: on ? color : "rgba(255,255,255,0.15)",
                  background: on ? color + "22" : "transparent",
                  fontWeight: on ? 700 : 500,
                }}
                aria-pressed={on}
              >
                {t}
              </button>
            )
          })}

          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <span className="rpc-label">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rpc-mono"
              style={{
                padding: "5px 10px",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--rpc-text-primary)",
                fontSize: 11,
              }}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>

            <div style={{ display: "flex", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
              {(["grid", "table"] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  style={{
                    padding: "5px 12px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    background: view === v ? accent : "transparent",
                    color: view === v ? "#fff" : "var(--rpc-text-muted)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Row 2: price / discount / player / badges */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="rpc-label">Price</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="Min"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            style={inputStyle}
          />
          <span style={{ color: "var(--rpc-text-ghost)" }}>–</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="Max"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            style={inputStyle}
          />

          <span className="rpc-label" style={{ marginLeft: 12 }}>Min discount %</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="e.g. 20"
            value={minDiscount}
            onChange={(e) => setMinDiscount(e.target.value)}
            style={inputStyle}
          />

          <span className="rpc-label" style={{ marginLeft: 12 }}>Player</span>
          <input
            type="text"
            placeholder="Search…"
            value={playerQuery}
            onChange={(e) => setPlayerQuery(e.target.value)}
            style={{ ...inputStyle, width: 180 }}
          />

          {collectionId === "nba-top-shot" && (
            <label
              className="rpc-mono"
              style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 12, cursor: "pointer", fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}
            >
              <input
                type="checkbox"
                checked={hasBadges}
                onChange={(e) => setHasBadges(e.target.checked)}
              />
              Badges only
            </label>
          )}

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="rpc-chip rpc-accent-border"
              style={{ marginLeft: "auto", color: accent, borderColor: accent }}
            >
              Clear {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {/* Row 3: result summary */}
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.08em" }}>
          {loading ? "LOADING…" : error ? `ERROR — ${error}` :
            `${total.toLocaleString()} LISTING${total === 1 ? "" : "S"}` +
            (data?.diagnostics && data.diagnostics.rawCount > data.diagnostics.postClampCount
              ? ` · ${(data.diagnostics.rawCount - data.diagnostics.postClampCount).toLocaleString()} OUTLIERS CLAMPED`
              : "")
          }
        </div>
      </section>

      {/* ── Results ── */}
      {loading ? (
        <div className="rpc-card" style={{ padding: 40, textAlign: "center" }}>
          <div className="rpc-skeleton" style={{ width: "40%", height: 20, margin: "0 auto" }} />
        </div>
      ) : error ? (
        <div className="rpc-card" style={{ padding: 20, borderLeft: "3px solid #EF4444" }}>
          <span className="rpc-mono" style={{ color: "#FCA5A5" }}>Couldn&apos;t load market — {error}</span>
        </div>
      ) : listings.length === 0 ? (
        <EmptyState collectionId={collectionId} thinVolume={thinVolume} />
      ) : view === "grid" ? (
        <div className="rpc-binder">
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} accent={accent} momentUrl={momentUrl} />
          ))}
        </div>
      ) : (
        <ListingTable listings={listings} accent={accent} momentUrl={momentUrl} />
      )}

      {/* ── Pagination ── */}
      {!loading && !error && listings.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", padding: "8px 0 20px" }}>
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="rpc-chip"
            style={{ opacity: page <= 1 ? 0.4 : 1 }}
          >
            ← Prev
          </button>
          <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.08em" }}>
            PAGE {page} / {Math.max(1, Math.ceil(total / 50))}
          </span>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => setPage(p => p + 1)}
            className="rpc-chip"
            style={{ opacity: hasMore ? 1 : 0.4 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "5px 10px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  width: 90,
  outline: "none",
}

function tierColor(tier: string | null): string {
  if (!tier) return "var(--rpc-text-muted)"
  return TIER_COLORS[tier.toUpperCase()] ?? "var(--rpc-text-muted)"
}

function sourceLabel(src: string | null): string {
  if (!src) return "—"
  switch (src.toLowerCase()) {
    case "flowty": return "Flowty"
    case "topshot": return "Top Shot"
    case "allday": return "All Day"
    case "pinnacle": return "Pinnacle"
    default: return src
  }
}

function ListingCard({ listing, accent, momentUrl }: {
  listing: Listing; accent: string; momentUrl: (id: string) => string | null
}) {
  const tier = (listing.tier ?? "").toUpperCase()
  const dot = tierColor(tier)
  const discount = fmtDiscount(listing.discount)
  const buy = listing.buyUrl ?? (listing.flowId ? momentUrl(listing.flowId) : null)
  const hasThumb = !!listing.thumbnailUrl

  return (
    <a
      href={buy ?? "#"}
      target={buy ? "_blank" : undefined}
      rel={buy ? "noopener noreferrer" : undefined}
      className="rpc-binder-slot"
      style={{
        textDecoration: "none",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        cursor: buy ? "pointer" : "default",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = `0 0 0 1px ${accent}, 0 0 18px ${accent}33`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "none"
      }}
    >
      <div style={{ aspectRatio: "1 / 1", background: "var(--rpc-surface)", position: "relative", overflow: "hidden" }}>
        {hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={listing.thumbnailUrl!}
            alt={listing.playerName ?? ""}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)" }}>—</div>
        )}
        {listing.serialNumber != null && (
          <div className="rpc-serial-pill">
            #{listing.serialNumber}{listing.circulationCount ? `/${listing.circulationCount}` : ""}
          </div>
        )}
      </div>
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, color: "var(--rpc-text-primary)", letterSpacing: "0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {listing.playerName ?? "Unknown"}
        </div>
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.04em" }}>
          <span style={{ color: dot }}>{tier || "—"}</span>
          {listing.setName ? <> · {listing.setName}</> : null}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: "var(--rpc-text-primary)" }}>
            {fmtUsd(listing.askPrice)}
          </span>
          <span className="rpc-mono" style={{ fontSize: 10, color: discount.color, fontWeight: 700, letterSpacing: "0.04em" }}>
            {discount.text}
          </span>
        </div>
        <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.08em", textTransform: "uppercase", display: "flex", gap: 6 }}>
          <span>FMV {fmtUsd(listing.fmv)}</span>
          <span>·</span>
          <span>{sourceLabel(listing.source)}</span>
          <span>·</span>
          <span>{relativeAge(listing.listedAt)}</span>
        </div>
      </div>
    </a>
  )
}

function ListingTable({ listings, accent, momentUrl }: {
  listings: Listing[]; accent: string; momentUrl: (id: string) => string | null
}) {
  return (
    <div className="rpc-card" style={{ padding: 0, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <thead className="rpc-thead-scanline">
          <tr style={{ borderBottom: "1px solid var(--rpc-border)", color: "var(--rpc-text-muted)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em" }}>
            <th style={th}></th>
            <th style={th}>Player</th>
            <th style={th}>Tier</th>
            <th style={th}>Set</th>
            <th style={{ ...th, textAlign: "right" }}>Serial</th>
            <th style={{ ...th, textAlign: "right" }}>Ask</th>
            <th style={{ ...th, textAlign: "right" }}>FMV</th>
            <th style={{ ...th, textAlign: "right" }}>Discount</th>
            <th style={th}>Source</th>
            <th style={th}>Listed</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => {
            const tier = (l.tier ?? "").toUpperCase()
            const dot = tierColor(tier)
            const discount = fmtDiscount(l.discount)
            const buy = l.buyUrl ?? (l.flowId ? momentUrl(l.flowId) : null)
            return (
              <tr
                key={l.id}
                style={{ borderBottom: "1px solid var(--rpc-border)", transition: "background 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${accent}11` }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
              >
                <td style={td}>
                  {l.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.thumbnailUrl} alt="" loading="lazy" width={32} height={32} style={{ borderRadius: 4, objectFit: "cover" }} />
                  ) : null}
                </td>
                <td style={{ ...td, color: "var(--rpc-text-primary)", fontFamily: "var(--font-display)", fontWeight: 700 }}>
                  {l.playerName ?? "—"}
                </td>
                <td style={{ ...td, color: dot }}>{tier || "—"}</td>
                <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{l.setName ?? "—"}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>
                  {l.serialNumber != null ? `#${l.serialNumber}${l.circulationCount ? `/${l.circulationCount}` : ""}` : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(l.askPrice)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtUsd(l.fmv)}</td>
                <td style={{ ...td, textAlign: "right", color: discount.color, fontWeight: 700 }}>{discount.text}</td>
                <td style={{ ...td, color: "var(--rpc-text-secondary)" }}>{sourceLabel(l.source)}</td>
                <td style={{ ...td, color: "var(--rpc-text-ghost)" }}>{relativeAge(l.listedAt)}</td>
                <td style={td}>
                  {buy ? (
                    <a
                      href={buy}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rpc-chip"
                      style={{ color: accent, borderColor: accent, background: `${accent}14` }}
                    >
                      Buy
                    </a>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "9px 12px",
  fontWeight: 700,
}
const td: React.CSSProperties = {
  padding: "9px 12px",
  verticalAlign: "middle",
}

function EmptyState({ collectionId, thinVolume }: { collectionId: string; thinVolume: boolean }) {
  const copy = thinVolume
    ? "Thin-volume ecosystem — treat discounts directionally when the confidence column is mostly LOW."
    : "No listings match these filters."
  return (
    <div className="rpc-card" style={{ padding: 40, textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
      <div style={{ fontSize: 32, color: "var(--rpc-text-ghost)" }}>◌</div>
      <div className="rpc-heading" style={{ fontSize: 16 }}>No listings</div>
      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", maxWidth: 480, lineHeight: 1.7 }}>
        {copy}
      </div>
      <Link href={`/${collectionId}/overview`} className="rpc-chip" style={{ marginTop: 8 }}>
        Back to overview
      </Link>
    </div>
  )
}

// ── Page wrapper ────────────────────────────────────────────────────────
export default function MarketPage() {
  return (
    <Suspense fallback={<div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>Loading market…</div>}>
      <MarketInner />
    </Suspense>
  )
}
