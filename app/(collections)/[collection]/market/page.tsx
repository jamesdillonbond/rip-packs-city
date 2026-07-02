"use client"

// Phase 4 — Market page.
// Sortable / filterable browser of every listing in the active collection.
// Distinct from /sniper (deal-focused) and /collection (wallet-focused).
//
// Phase 4 changes:
//   - Default view is now "table" (the grid card view is still toggleable)
//   - Series column added between Tier and Set
//   - Edition Owned/Locked column ("3 / 2") for signed-in users
//   - Badges render as inline images via <BadgeIcon>
//   - New filters: Set / Series / Player typeahead / Owned-or-not / Team /
//     Tier / Specific Badges / Special Serials, all URL-persisted

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useCollectionContext } from "@/lib/hooks/useCollectionContext"
import { getOwnerKey } from "@/lib/owner-key"
import { slugifyName } from "@/lib/entity-labels"
import BadgeIcon from "@/components/BadgeIcon"
import { trackOutboundClick } from "@/lib/track-click"
import { dapperMarketMomentUrl } from "@/lib/collections"
import { proxyIpfsUrl } from "@/lib/ipfs-media"

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
  lowConfidenceFmv?: boolean | null
  confidence: string | null
  source: string | null
  buyUrl: string | null
  thumbnailUrl: string | null
  badgeSlugs: string[]
  editionKey: string | null
  isSpecialSerial: boolean
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

type OwnedFilter = "all" | "owned" | "not_owned"

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

function parseList(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(",").map(s => s.trim()).filter(Boolean)
}

// Resolve the outbound marketplace URL for a listing. Flowty links are dead,
// so prefer a live native link: the listing's own buyUrl when it isn't a
// Flowty URL, otherwise the collection's native moment page.
// Log an outbound "View Listing" click to outbound_clicks. Fire-and-forget.
function trackListingClick(listing: Listing, buyUrl: string | null) {
  const isNativeMarketplace = !!listing.buyUrl?.trim() && !listing.buyUrl.includes("flowty.io")
  trackOutboundClick({
    surface: "market",
    destination: isNativeMarketplace ? "topshot_listing" : "native_moment_page",
    editionKey: listing.editionKey,
    momentId: listing.momentId,
    playerName: listing.playerName,
    setName: listing.setName,
    tier: listing.tier,
    serial: listing.serialNumber,
    askPrice: listing.askPrice,
    fmv: listing.fmv,
    discount: listing.discount,
    buyUrl,
  })
}

function resolveListingUrl(
  listing: Listing,
  momentUrl: (id: string) => string | null,
): string | null {
  const url = listing.buyUrl?.trim()
  if (url && !url.includes("flowty.io")) return url
  return listing.flowId ? momentUrl(listing.flowId) : null
}

// Second-marketplace (dapper.market) link rendered alongside the native one.
// listing.flowId is the on-chain moment id for per-moment listings (AllDay /
// Golazos); it's null on TS edition-level browse rows, so no link renders
// there. The builder also returns null for non-dapper collections (Pinnacle /
// UFC), so callers can render unconditionally and the link self-hides.
function resolveDapperListingUrl(
  listing: Listing,
  collectionUrlSlug: string,
): string | null {
  return dapperMarketMomentUrl(collectionUrlSlug, listing.flowId)
}

function MarketInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { collection, collectionId, supabaseCollectionId, accent, momentUrl } = useCollectionContext()

  // ── View state (table / grid) — table is the Phase 4 default ──────────
  const [view, setView] = useState<"grid" | "table">(() => {
    return (searchParams.get("view") === "grid" ? "grid" : "table")
  })

  // ── Filters — initialized from URL so deep-linking works ─────────────
  const [tiersSel, setTiersSel] = useState<string[]>(() => parseList(searchParams.get("tier")))
  const [setsSel, setSetsSel] = useState<string[]>(() => parseList(searchParams.get("set")))
  const [seriesSel, setSeriesSel] = useState<string[]>(() => parseList(searchParams.get("series")))
  const [teamsSel, setTeamsSel] = useState<string[]>(() => parseList(searchParams.get("team")))
  const [badgesSel, setBadgesSel] = useState<string[]>(() => parseList(searchParams.get("badges")))
  const [minPrice, setMinPrice] = useState<string>(searchParams.get("minPrice") ?? "")
  const [maxPrice, setMaxPrice] = useState<string>(searchParams.get("maxPrice") ?? "")
  const [minDiscount, setMinDiscount] = useState<string>(searchParams.get("minDiscount") ?? "")
  const [playerQuery, setPlayerQuery] = useState<string>(searchParams.get("player") ?? "")
  const [specialSerials, setSpecialSerials] = useState<boolean>(searchParams.get("specialSerials") === "true")
  const [ownedFilter, setOwnedFilter] = useState<OwnedFilter>(() => {
    const v = searchParams.get("owned")
    return v === "owned" || v === "not_owned" ? v : "all"
  })
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
  useEffect(() => { setPage(1) }, [
    tiersSel.join(","), setsSel.join(","), seriesSel.join(","), teamsSel.join(","), badgesSel.join(","),
    minPrice, maxPrice, minDiscount, debouncedPlayer, specialSerials, ownedFilter, sort,
  ])

  // ── Owner key + edition counts (powers Owned filter + Owned/Locked col) ──
  const [ownerKey, setOwnerKey] = useState<string | null>(null)
  const [editionStats, setEditionStats] = useState<Map<string, { owned: number; locked: number }>>(new Map())
  useEffect(() => {
    setOwnerKey(getOwnerKey())
  }, [])
  useEffect(() => {
    if (!ownerKey || !ownerKey.startsWith("0x") || !collectionId) return
    let cancelled = false
    fetch(`/api/wallet/edition-counts?wallet=${encodeURIComponent(ownerKey)}&collection=${encodeURIComponent(collectionId)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    })
      .then(r => r.ok ? r.json() : null)
      .then((j: { editions?: Record<string, { owned: number; locked: number }> } | null) => {
        if (cancelled || !j) return
        const next = new Map<string, { owned: number; locked: number }>()
        for (const [k, v] of Object.entries(j.editions ?? {})) {
          next.set(k, { owned: Number(v.owned) || 0, locked: Number(v.locked) || 0 })
        }
        setEditionStats(next)
      })
      .catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [ownerKey, collectionId])

  // ── Data ─────────────────────────────────────────────────────────────
  const [data, setData] = useState<MarketResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchKey = useMemo(() => {
    const params = new URLSearchParams()
    if (supabaseCollectionId) params.set("collectionId", supabaseCollectionId)
    if (tiersSel.length > 0) params.set("tier", tiersSel.join(","))
    if (setsSel.length > 0) params.set("set", setsSel.join(","))
    if (seriesSel.length > 0) params.set("series", seriesSel.join(","))
    if (teamsSel.length > 0) params.set("team", teamsSel.join(","))
    if (badgesSel.length > 0) params.set("badges", badgesSel.join(","))
    if (minPrice) params.set("minPrice", minPrice)
    if (maxPrice) params.set("maxPrice", maxPrice)
    if (minDiscount) params.set("minDiscount", minDiscount)
    if (debouncedPlayer) params.set("player", debouncedPlayer)
    if (specialSerials) params.set("specialSerials", "true")
    params.set("sort", sort)
    params.set("page", String(page))
    params.set("limit", "50")
    return params.toString()
  }, [supabaseCollectionId, tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, specialSerials, sort, page])

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
    if (setsSel.length > 0) sp.set("set", setsSel.join(","))
    if (seriesSel.length > 0) sp.set("series", seriesSel.join(","))
    if (teamsSel.length > 0) sp.set("team", teamsSel.join(","))
    if (badgesSel.length > 0) sp.set("badges", badgesSel.join(","))
    if (minPrice) sp.set("minPrice", minPrice)
    if (maxPrice) sp.set("maxPrice", maxPrice)
    if (minDiscount) sp.set("minDiscount", minDiscount)
    if (debouncedPlayer) sp.set("player", debouncedPlayer)
    if (specialSerials) sp.set("specialSerials", "true")
    if (ownedFilter !== "all") sp.set("owned", ownedFilter)
    if (sort !== "recent") sp.set("sort", sort)
    if (page > 1) sp.set("page", String(page))
    if (view === "grid") sp.set("view", "grid")
    const qs = sp.toString()
    try { router.replace(qs ? `?${qs}` : "?", { scroll: false }) } catch { /* ignore */ }
  }, [tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, specialSerials, ownedFilter, sort, page, view, router])

  // ── Thin-volume notice — reads /api/ready's per_collection array ─────
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

  // ── Filter dropdown options (derived from current results) ───────────
  const availableTiers = COLLECTION_TIERS[collectionId] ?? []
  const baseListings = data?.listings ?? []
  const setOptions = useMemo(() => collectDistinct(baseListings, l => l.setName), [baseListings])
  const seriesOptions = useMemo(() => collectDistinct(baseListings, l => l.seriesName), [baseListings])
  const teamOptions = useMemo(() => collectDistinct(baseListings, l => l.teamName), [baseListings])
  const badgeOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const l of baseListings) for (const b of l.badgeSlugs) if (b) seen.add(b)
    return Array.from(seen).sort()
  }, [baseListings])

  // Owned filter is applied client-side because the join lives on the
  // browser anyway (we already loaded /api/wallet/edition-counts above).
  const filteredListings = useMemo(() => {
    if (ownedFilter === "all" || !ownerKey || editionStats.size === 0) return baseListings
    return baseListings.filter(l => {
      const stats = l.editionKey ? editionStats.get(l.editionKey) : null
      const owned = stats != null && stats.owned > 0
      return ownedFilter === "owned" ? owned : !owned
    })
  }, [baseListings, ownedFilter, ownerKey, editionStats])

  // ── Filter controls ──────────────────────────────────────────────────
  const toggleTier = useCallback((t: string) => {
    setTiersSel(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }, [])

  const clearFilters = useCallback(() => {
    setTiersSel([])
    setSetsSel([])
    setSeriesSel([])
    setTeamsSel([])
    setBadgesSel([])
    setMinPrice("")
    setMaxPrice("")
    setMinDiscount("")
    setPlayerQuery("")
    setSpecialSerials(false)
    setOwnedFilter("all")
    setSort("recent")
    setPage(1)
  }, [])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (tiersSel.length > 0) n++
    if (setsSel.length > 0) n++
    if (seriesSel.length > 0) n++
    if (teamsSel.length > 0) n++
    if (badgesSel.length > 0) n++
    if (minPrice) n++
    if (maxPrice) n++
    if (minDiscount) n++
    if (debouncedPlayer) n++
    if (specialSerials) n++
    if (ownedFilter !== "all") n++
    return n
  }, [tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, specialSerials, ownedFilter])

  // ── Render ───────────────────────────────────────────────────────────
  if (!collection) {
    return <div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>Unknown collection.</div>
  }

  const total = data?.pagination.total ?? 0
  const hasMore = data?.pagination.hasMore ?? false
  const showOwnedColumn = !!ownerKey && editionStats.size > 0
  const showOwnedFilter = !!ownerKey

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

      {/* ── Alerts front door ── turn a below-FMV listing you're watching into a
          standing alert. Auth-gated (/alerts); anon bounces to login. */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Link
          href="/alerts"
          className="rpc-chip"
          style={{ textDecoration: "none", color: "var(--rpc-red)", borderColor: "var(--rpc-red)" }}
          title="Get notified when listings drop below FMV"
        >
          🔔 ALERT ME ON DEALS →
        </Link>
      </div>

      {/* ── Filter bar ── */}
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
              {(["table", "grid"] as const).map(v => (
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

        {/* Row 2: price / discount / player */}
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

        {/* Row 3: multi-select dropdowns + special serials + owned filter */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <MultiSelectChip label="Set" selected={setsSel} options={setOptions} onChange={setSetsSel} />
          <MultiSelectChip label="Series" selected={seriesSel} options={seriesOptions} onChange={setSeriesSel} />
          <MultiSelectChip label="Team" selected={teamsSel} options={teamOptions} onChange={setTeamsSel} />
          <MultiSelectChip label="Badges" selected={badgesSel} options={badgeOptions} onChange={setBadgesSel} />

          <label
            className="rpc-mono"
            style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}
          >
            <input
              type="checkbox"
              checked={specialSerials}
              onChange={(e) => setSpecialSerials(e.target.checked)}
            />
            Special serials only
          </label>

          {showOwnedFilter && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="rpc-label">Owned</span>
              {(["all", "owned", "not_owned"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOwnedFilter(v)}
                  className="rpc-chip"
                  style={{
                    color: ownedFilter === v ? "#fff" : "var(--rpc-text-muted)",
                    borderColor: ownedFilter === v ? accent : "rgba(255,255,255,0.15)",
                    background: ownedFilter === v ? accent + "22" : "transparent",
                    fontWeight: ownedFilter === v ? 700 : 500,
                  }}
                  aria-pressed={ownedFilter === v}
                >
                  {v === "all" ? "All" : v === "owned" ? "Owned" : "Not owned"}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Row 4: result summary */}
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.08em" }}>
          {loading ? "LOADING…" : error ? `ERROR — ${error}` :
            `${filteredListings.length.toLocaleString()} OF ${total.toLocaleString()} LISTING${total === 1 ? "" : "S"}` +
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
      ) : filteredListings.length === 0 ? (
        <EmptyState collectionId={collectionId} thinVolume={thinVolume} />
      ) : view === "grid" ? (
        <div className="rpc-binder">
          {filteredListings.map((l) => (
            <ListingCard
              key={l.id}
              listing={l}
              accent={accent}
              momentUrl={momentUrl}
              editionStats={editionStats}
              showOwned={showOwnedColumn}
              collectionUrlSlug={collectionId}
              badgeCollectionId={supabaseCollectionId}
            />
          ))}
        </div>
      ) : (
        <ListingTable
          listings={filteredListings}
          accent={accent}
          momentUrl={momentUrl}
          editionStats={editionStats}
          showOwnedColumn={showOwnedColumn}
          collectionUrlSlug={collectionId}
          badgeCollectionId={supabaseCollectionId}
        />
      )}

      {/* ── Pagination ── */}
      {!loading && !error && filteredListings.length > 0 && (
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

function collectDistinct(rows: Listing[], pick: (l: Listing) => string | null | undefined): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    const v = pick(r)
    if (v != null && v !== "") seen.add(String(v))
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

function MultiSelectChip({
  label, selected, options, onChange,
}: {
  label: string
  selected: string[]
  options: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const summary = selected.length === 0 ? "Any" : selected.length === 1 ? selected[0] : `${selected.length} selected`
  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter(x => x !== v))
    else onChange([...selected, v])
  }
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="rpc-label">{label}</span>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="rpc-chip"
        style={{
          minWidth: 110,
          background: selected.length > 0 ? "rgba(255,255,255,0.05)" : "transparent",
          color: selected.length > 0 ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
          fontWeight: selected.length > 0 ? 700 : 500,
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={options.length === 0}
        title={options.length === 0 ? "No options in current results" : undefined}
      >
        {summary} ▾
      </button>
      {open && options.length > 0 && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: "var(--rpc-surface-raised)",
            border: "1px solid var(--rpc-border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
            padding: 6,
            minWidth: 180,
            maxHeight: 240,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{
                display: "block",
                width: "100%",
                padding: "4px 6px",
                marginBottom: 4,
                background: "transparent",
                border: "none",
                textAlign: "left",
                color: "var(--rpc-text-ghost)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Clear
            </button>
          )}
          {options.map(opt => (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                cursor: "pointer",
                color: selected.includes(opt) ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

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

function ownLockLabel(stats: { owned: number; locked: number } | null | undefined): string {
  if (!stats || stats.owned <= 0) return "—"
  return `${stats.owned} / ${stats.locked}`
}

function ListingCard({ listing, accent, momentUrl, editionStats, showOwned, collectionUrlSlug, badgeCollectionId }: {
  listing: Listing; accent: string; momentUrl: (id: string) => string | null
  editionStats: Map<string, { owned: number; locked: number }>; showOwned: boolean
  collectionUrlSlug: string
  badgeCollectionId: string | null
}) {
  const tier = (listing.tier ?? "").toUpperCase()
  const dot = tierColor(tier)
  const discount = fmtDiscount(listing.discount)
  const buy = resolveListingUrl(listing, momentUrl)
  const dapper = resolveDapperListingUrl(listing, collectionUrlSlug)
  // Full-card click target: navigate to the edition entity page; the outbound
  // listing moves to an explicit "View Listing →" button below.
  const editionHref = listing.editionKey
    ? `/${collectionUrlSlug}/edition/${encodeURIComponent(listing.editionKey)}`
    : null
  const hasThumb = !!listing.thumbnailUrl
  const stats = listing.editionKey ? editionStats.get(listing.editionKey) : null

  return (
    <a
      href={editionHref ?? buy ?? "#"}
      target={editionHref ? undefined : buy ? "_blank" : undefined}
      rel={editionHref ? undefined : buy ? "noopener noreferrer" : undefined}
      onClick={editionHref ? undefined : buy ? () => trackListingClick(listing, buy) : undefined}
      className="rpc-binder-slot"
      style={{
        textDecoration: "none",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        cursor: editionHref || buy ? "pointer" : "default",
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
            src={proxyIpfsUrl(listing.thumbnailUrl) ?? undefined}
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
          {listing.seriesName ? <> · {listing.seriesName}</> : null}
          {listing.setName ? <> · {listing.setName}</> : null}
        </div>
        {listing.badgeSlugs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {Array.from(new Set(listing.badgeSlugs)).slice(0, 4).map(slug => (
              <BadgeIcon key={slug} title={slug} size={20} collectionId={badgeCollectionId} />
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: "var(--rpc-text-primary)" }}>
            {fmtUsd(listing.askPrice)}
          </span>
          {listing.lowConfidenceFmv ? (
            <span
              className="rpc-mono"
              title="FMV here is averaged over very few, wide-ranging sales, so it overshoots the typical price — this discount is uncertain. Check recent sales before acting."
              style={{ fontSize: 10, color: "var(--rpc-warning)", fontWeight: 700, letterSpacing: "0.04em" }}
            >
              ⚠ thin data
            </span>
          ) : (
            <span className="rpc-mono" style={{ fontSize: 10, color: discount.color, fontWeight: 700, letterSpacing: "0.04em" }}>
              {discount.text}
            </span>
          )}
        </div>
        <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.08em", textTransform: "uppercase", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span>FMV {fmtUsd(listing.fmv)}</span>
          <span>·</span>
          <span>{sourceLabel(listing.source)}</span>
          <span>·</span>
          <span>{relativeAge(listing.listedAt)}</span>
          {showOwned && (
            <>
              <span>·</span>
              <span>OWN {ownLockLabel(stats)}</span>
            </>
          )}
        </div>
        {editionHref && buy && (
          // The outbound listing CTA, surfaced as a button now that the card
          // body navigates to the edition page. role=link span (not a nested
          // <a>, invalid inside the outer anchor) opening the listing in a new tab.
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); trackListingClick(listing, buy); window.open(buy, "_blank", "noopener,noreferrer") }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); trackListingClick(listing, buy); window.open(buy, "_blank", "noopener,noreferrer") } }}
            className="rpc-mono"
            style={{ marginTop: 6, alignSelf: "flex-start", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-primary)", border: `1px solid ${accent}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}
          >
            View Listing →
          </span>
        )}
        {dapper && (
          // Second-marketplace link. Rendered as a role=link span (not a nested
          // <a>, which is invalid inside the card's outer anchor) that opens
          // dapper.market in a new tab without triggering the card's native link.
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); trackListingClick(listing, dapper); window.open(dapper, "_blank", "noopener,noreferrer") }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); trackListingClick(listing, dapper); window.open(dapper, "_blank", "noopener,noreferrer") } }}
            className="rpc-mono"
            style={{ marginTop: 6, alignSelf: "flex-start", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: accent, border: `1px solid ${accent}40`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}
          >
            Dapper ↗
          </span>
        )}
      </div>
    </a>
  )
}

function ListingTable({ listings, accent, momentUrl, editionStats, showOwnedColumn, collectionUrlSlug, badgeCollectionId }: {
  listings: Listing[]; accent: string; momentUrl: (id: string) => string | null
  editionStats: Map<string, { owned: number; locked: number }>; showOwnedColumn: boolean
  collectionUrlSlug: string
  badgeCollectionId: string | null
}) {
  const router = useRouter()
  return (
    <div className="rpc-card" style={{ padding: 0, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <thead className="rpc-thead-scanline">
          <tr style={{ borderBottom: "1px solid var(--rpc-border)", color: "var(--rpc-text-muted)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em" }}>
            <th style={th}></th>
            <th style={th}>Player</th>
            <th style={th}>Tier</th>
            <th style={th}>Series</th>
            <th style={th}>Set</th>
            <th style={th}>Badges</th>
            <th style={{ ...th, textAlign: "right" }}>Serial</th>
            {showOwnedColumn && <th style={{ ...th, textAlign: "right" }}>Own / Lock</th>}
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
            const buy = resolveListingUrl(l, momentUrl)
            const dapper = resolveDapperListingUrl(l, collectionUrlSlug)
            const stats = l.editionKey ? editionStats.get(l.editionKey) : null
            const uniqueBadges = Array.from(new Set(l.badgeSlugs))
            const editionHref = l.editionKey ? `/${collectionUrlSlug}/edition/${encodeURIComponent(l.editionKey)}` : null
            return (
              <tr
                key={l.id}
                onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("a,button")) return; if (editionHref) router.push(editionHref) }}
                style={{ borderBottom: "1px solid var(--rpc-border)", transition: "background 0.15s", cursor: editionHref ? "pointer" : "default" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${accent}11` }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
              >
                <td style={td}>
                  {l.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={proxyIpfsUrl(l.thumbnailUrl) ?? undefined} alt="" loading="lazy" width={32} height={32} style={{ borderRadius: 4, objectFit: "cover" }} />
                  ) : null}
                </td>
                <td style={{ ...td, color: "var(--rpc-text-primary)", fontFamily: "var(--font-display)", fontWeight: 700 }}>
                  {l.playerName ? (
                    <Link
                      href={`/${collectionUrlSlug}/player/${slugifyName(l.playerName)}`}
                      prefetch={false}
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {l.playerName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ ...td, color: dot }}>{tier || "—"}</td>
                <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{l.seriesName ?? "—"}</td>
                <td style={{ ...td, color: "var(--rpc-text-muted)" }}>
                  {l.setName ? (
                    <Link
                      href={`/${collectionUrlSlug}/set/${slugifyName(l.setName)}`}
                      prefetch={false}
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {l.setName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={td}>
                  {uniqueBadges.length === 0 ? (
                    <span style={{ color: "var(--rpc-text-ghost)" }}>—</span>
                  ) : (
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {uniqueBadges.slice(0, 3).map(slug => (
                        <BadgeIcon key={slug} title={slug} size={20} collectionId={badgeCollectionId} />
                      ))}
                      {uniqueBadges.length > 3 && (
                        <span style={{ fontSize: 10, color: "var(--rpc-text-ghost)" }}>+{uniqueBadges.length - 3}</span>
                      )}
                    </div>
                  )}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>
                  {l.serialNumber != null ? `#${l.serialNumber}${l.circulationCount ? `/${l.circulationCount}` : ""}` : "—"}
                </td>
                {showOwnedColumn && (
                  <td style={{ ...td, textAlign: "right", color: stats && stats.owned > 0 ? "var(--rpc-success)" : "var(--rpc-text-ghost)" }}
                      title={stats && stats.owned > 0 ? `${stats.owned} owned · ${stats.locked} locked` : undefined}>
                    {ownLockLabel(stats)}
                  </td>
                )}
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(l.askPrice)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtUsd(l.fmv)}</td>
                {l.lowConfidenceFmv ? (
                  <td
                    style={{ ...td, textAlign: "right", color: "var(--rpc-warning)", fontWeight: 700, fontSize: 10, whiteSpace: "nowrap" }}
                    title="FMV here is averaged over very few, wide-ranging sales, so it overshoots the typical price — this discount is uncertain. Check recent sales before acting."
                  >
                    ⚠ thin data
                  </td>
                ) : (
                  <td style={{ ...td, textAlign: "right", color: discount.color, fontWeight: 700 }}>{discount.text}</td>
                )}
                <td style={{ ...td, color: "var(--rpc-text-secondary)" }}>{sourceLabel(l.source)}</td>
                <td style={{ ...td, color: "var(--rpc-text-ghost)" }}>{relativeAge(l.listedAt)}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {buy ? (
                      <a
                        href={buy}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => trackListingClick(l, buy)}
                        className="rpc-chip"
                        style={{ color: accent, borderColor: accent, background: `${accent}14` }}
                      >
                        View Listing →
                      </a>
                    ) : null}
                    {dapper ? (
                      <a
                        href={dapper}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => trackListingClick(l, dapper)}
                        className="rpc-chip"
                        style={{ color: accent, borderColor: `${accent}40`, background: "transparent" }}
                      >
                        Dapper ↗
                      </a>
                    ) : null}
                  </div>
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
