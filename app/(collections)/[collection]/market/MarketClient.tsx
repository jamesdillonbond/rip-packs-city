"use client"

// Phase 4 — Market page (client body; the server shell is page.tsx).
//
// Split out of page.tsx so the component coverage gate measures it — a
// `page.tsx` matches neither gate's include, so the filter/sort/pagination
// state machine and the listing renderers were unmeasured by construction.
//
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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useCollectionContext } from "@/lib/hooks/useCollectionContext"
import { getOwnerKey } from "@/lib/owner-key"
import { slugifyName } from "@/lib/entity-labels"
import { momentSubjectHref } from "@/lib/entity-href"
import { COLLECTION_TIERS } from "@/lib/collection-tiers"
import { parseList, fmtDiscount, resolveListingUrl, collectDistinct, fmtUsd, TIER_COLORS, tierColor, ownLockLabel } from "@/lib/market-format"
import { filterListingsByOwned, collectBadgeOptions, countActiveFilters } from "@/lib/market/filters"
import BadgeIcon from "@/components/BadgeIcon"
import { trackOutboundClick } from "@/lib/track-click"
import { collectionHasPage, dapperMarketMomentUrl, getCollectionUuid } from "@/lib/collections"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { fmvBasis } from "@/lib/fmv-basis"
import { PackSubNav, subSectionFromParams } from "@/components/collection/PackSubNav"
import PackMarketView from "@/components/packs/PackMarketView"

type Listing = {
  id: string
  flowId: string | null
  momentId: string | null
  playerName: string | null
  teamName: string | null
  setName: string | null
  seriesName: string | null
  tier: string | null
  parallel: string | null
  serialNumber: number | null
  circulationCount: number | null
  listedCount: number | null
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

// Mirrors /api/ready's per_collection rows. `sales_24h` is nullable on
// purpose: the route emits null rather than a fabricated 0 when the count is
// missing (deep-audit R44). `fmv_coverage_pct` was dropped from the route —
// it was never measured there and nothing read it.
type HealthPerCollection = {
  slug: string
  name: string
  /** ⚠ Bounded probe: exact when <= 10, NULL above. Not a volume figure. */
  sales_24h: number | null
  /** The thin-volume answer itself. null = unknown, and unknown is not thin. */
  thin_volume: boolean | null
  last_sale_at: string | null
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

// TIER_COLORS extracted to @/lib/market-format (imported above).

// COLLECTION_TIERS moved to @/lib/collection-tiers (imported above) so the Market
// filter and the Sniper tier chips read ONE list. The local copy had drifted from
// the DB: it omitted UNCOMMON for NFL All Day (630 editions unreachable through the
// filter) and carried a dead FANDOM chip for LaLiga Golazos (0 rows).

// fmtUsd extracted to @/lib/market-format (imported above).

// fmtDiscount extracted to @/lib/market-format (imported below).

// parseList extracted to @/lib/market-format (imported below).

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

// resolveListingUrl extracted to @/lib/market-format (imported below).

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

  // Resilient collection UUID. `supabaseCollectionId` has NO fallback in
  // buildContext (it's `collection?.supabaseCollectionId ?? null`) while
  // `collectionId` DOES fall back to the first published collection — so during
  // the logged-in first-commit window (extra auth/profile/wallet fetches race
  // useParams() resolution) there is a moment where collectionId is set but
  // supabaseCollectionId is null. The old fetch effect hard-gated on
  // supabaseCollectionId, so it committed the filter UI but never issued
  // /api/market (no error, just a stranded skeleton). Deriving the UUID from
  // the already-fallback-resolved collectionId (always a valid published slug →
  // always a non-null UUID) means the fetch can never be gated off. Anon loads
  // resolved params synchronously and never hit the window, which is why only
  // logged-in loads stuck. Corrects the handoff's supabaseCollectionId premise.
  const resolvedCollectionUuid = supabaseCollectionId ?? getCollectionUuid(collectionId)

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
  const [ownedFilter, setOwnedFilter] = useState<OwnedFilter>(() => {
    const v = searchParams.get("owned")
    return v === "owned" || v === "not_owned" ? v : "all"
  })
  const [sort, setSort] = useState<SortKey>(() => {
    // Market defaults to cheapest-first (Trevor, 2026-07-18): Market is the browse
    // surface (lowest ask up top), while the Sniper tab owns the recently-listed
    // deal-flow default. (The old "recent" default was also misleading on TopShot —
    // its sniper RPC ignored the recency sort and silently ranked by discount.)
    const v = (searchParams.get("sort") as SortKey) ?? "price_asc"
    return (Object.keys(SORT_LABELS) as SortKey[]).includes(v) ? v : "price_asc"
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

  // Any time an active filter CHANGES, snap back to page 1.
  //
  // ⚠ Skip the first run. A `useEffect` fires on mount as well as on change, so
  // without this guard the reset discarded the `?page=` deep link on every
  // load: `useState` read page 3 out of the URL, the effect immediately set it
  // back to 1, and the URL-sync effect below then REWROTE the address without
  // the param — so a shared link silently lost its page and nothing on screen
  // said so. This page advertises deep-linking as a feature ("Push filter/sort/
  // page state into the URL so deep-links work"), which is precisely why the
  // param has to survive the mount.
  const filtersMountedRef = useRef(false)
  useEffect(() => {
    if (!filtersMountedRef.current) { filtersMountedRef.current = true; return }
    setPage(1)
  }, [
    tiersSel.join(","), setsSel.join(","), seriesSel.join(","), teamsSel.join(","), badgesSel.join(","),
    minPrice, maxPrice, minDiscount, debouncedPlayer, ownedFilter, sort,
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
    if (resolvedCollectionUuid) params.set("collectionId", resolvedCollectionUuid)
    if (tiersSel.length > 0) params.set("tier", tiersSel.join(","))
    if (setsSel.length > 0) params.set("set", setsSel.join(","))
    if (seriesSel.length > 0) params.set("series", seriesSel.join(","))
    if (teamsSel.length > 0) params.set("team", teamsSel.join(","))
    if (badgesSel.length > 0) params.set("badges", badgesSel.join(","))
    if (minPrice) params.set("minPrice", minPrice)
    if (maxPrice) params.set("maxPrice", maxPrice)
    if (minDiscount) params.set("minDiscount", minDiscount)
    if (debouncedPlayer) params.set("player", debouncedPlayer)
    params.set("sort", sort)
    params.set("page", String(page))
    params.set("limit", "50")
    return params.toString()
  }, [resolvedCollectionUuid, tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, sort, page])

  useEffect(() => {
    if (!resolvedCollectionUuid) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    // The /api/market response is public + non-user-specific (owned filtering
    // is applied client-side below) and already carries s-maxage=30,SWR=60, so
    // let the CDN serve repeat/cross-user loads instead of forcing every load to
    // the cold origin. `no-store` here defeated that edge cache — the dominant
    // cause of the "5-8s to first data" on the common (default-filter) view.
    fetch(`/api/market?${fetchKey}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: MarketResponse) => { if (!cancelled) setData(j) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchKey, resolvedCollectionUuid])

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
    if (ownedFilter !== "all") sp.set("owned", ownedFilter)
    if (sort !== "recent") sp.set("sort", sort)
    if (page > 1) sp.set("page", String(page))
    if (view === "grid") sp.set("view", "grid")
    const qs = sp.toString()
    try { router.replace(qs ? `?${qs}` : "?", { scroll: false }) } catch { /* ignore */ }
  }, [tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, ownedFilter, sort, page, view, router])

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

  // ⚠ READS `thin_volume`, NOT `sales_24h`. Since 2026-08-23 `sales_24h` is a
  // BOUNDED PROBE — exact when <= 10, NULL above — so the old
  // `(sales_24h ?? 0) < 10` would coerce "busy" to 0 and render
  // "THIN-VOLUME ECOSYSTEM" on Top Shot. The server does the comparison now
  // because only the server knows the probe's bound.
  // `=== true` is deliberate: null means UNKNOWN and must not claim thin.
  const thinVolume = healthRow?.thin_volume === true

  // ── Filter dropdown options (derived from current results) ───────────
  const availableTiers = COLLECTION_TIERS[collectionId] ?? []
  const baseListings = data?.listings ?? []
  const setOptions = useMemo(() => collectDistinct(baseListings, l => l.setName), [baseListings])
  const seriesOptions = useMemo(() => collectDistinct(baseListings, l => l.seriesName), [baseListings])
  const teamOptions = useMemo(() => collectDistinct(baseListings, l => l.teamName), [baseListings])
  const badgeOptions = useMemo(() => collectBadgeOptions(baseListings), [baseListings])

  // Owned filter is applied client-side because the join lives on the
  // browser anyway (we already loaded /api/wallet/edition-counts above).
  const filteredListings = useMemo(
    () => filterListingsByOwned(baseListings, ownedFilter, ownerKey, editionStats),
    [baseListings, ownedFilter, ownerKey, editionStats],
  )

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
    setOwnedFilter("all")
    setSort("recent")
    setPage(1)
  }, [])

  const activeFilterCount = useMemo(
    () => countActiveFilters({ tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, ownedFilter }),
    [tiersSel, setsSel, seriesSel, teamsSel, badgesSel, minPrice, maxPrice, minDiscount, debouncedPlayer, ownedFilter],
  )

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
            `${filteredListings.length.toLocaleString()} OF ${total.toLocaleString()} EDITION${total === 1 ? "" : "S"}` +
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
              badgeCollectionId={resolvedCollectionUuid}
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
          badgeCollectionId={resolvedCollectionUuid}
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

// collectDistinct extracted to @/lib/market-format (imported below).

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

// tierColor / ownLockLabel extracted to @/lib/market-format (imported above).

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
          {listing.parallel && listing.parallel !== "Base" ? (
            <> · <span style={{ color: "#c084fc", fontWeight: 600 }}>{listing.parallel}</span></>
          ) : null}
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
          {(() => { const b = fmvBasis(listing.confidence); return b ? <span title={b.title}>· {b.label}</span> : null })()}
          {listing.listedCount != null && (
            <>
              <span>·</span>
              <span>{listing.listedCount.toLocaleString()} listed</span>
            </>
          )}
          {listing.circulationCount != null && (
            <>
              <span>·</span>
              <span>{listing.circulationCount.toLocaleString()} mint</span>
            </>
          )}
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
            <th style={{ ...th, textAlign: "right" }}># Listed</th>
            <th style={{ ...th, textAlign: "right" }}>Mint</th>
            {showOwnedColumn && <th style={{ ...th, textAlign: "right" }}>Own / Lock</th>}
            <th style={{ ...th, textAlign: "right" }}>Floor Ask</th>
            <th style={{ ...th, textAlign: "right" }}>FMV</th>
            <th style={{ ...th, textAlign: "right" }}>Discount</th>
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
                    <img src={proxyIpfsUrl(l.thumbnailUrl) ?? undefined} alt="" loading="lazy" width={80} height={80} style={{ borderRadius: 8, objectFit: "cover" }} />
                  ) : null}
                </td>
                <td style={{ ...td, color: "var(--rpc-text-primary)", fontFamily: "var(--font-display)", fontWeight: 700 }}>
                  {l.playerName ? (
                    <Link
                      href={momentSubjectHref(collectionUrlSlug, l.playerName, l.teamName) ?? "#"}
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
                  {l.parallel && l.parallel !== "Base" && (
                    <span
                      style={{ marginLeft: 6, color: "#c084fc", fontWeight: 600, border: "1px solid rgba(192,132,252,0.4)", background: "rgba(192,132,252,0.10)", borderRadius: 3, padding: "0 4px" }}
                    >
                      {l.parallel}
                    </span>
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
                  {l.listedCount != null ? l.listedCount.toLocaleString() : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>
                  {l.circulationCount != null ? l.circulationCount.toLocaleString() : "—"}
                </td>
                {showOwnedColumn && (
                  <td style={{ ...td, textAlign: "right", color: stats && stats.owned > 0 ? "var(--rpc-success)" : "var(--rpc-text-ghost)" }}
                      title={stats && stats.owned > 0 ? `${stats.owned} owned · ${stats.locked} locked` : undefined}>
                    {ownLockLabel(stats)}
                  </td>
                )}
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(l.askPrice)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>
                  {fmtUsd(l.fmv)}
                  {(() => { const b = fmvBasis(l.confidence); return b ? <div title={b.title} style={{ fontSize: 9, color: "var(--rpc-text-ghost)" }}>{b.label}</div> : null })()}
                </td>
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
  // `height` on a table cell acts as a MIN row height, so an 80px moment thumb
  // (source art is 512px natural → lossless upscale) sits comfortably and
  // thumbnail-less rows keep the same vertical rhythm instead of crowding.
  height: 96,
}

function EmptyState({ collectionId, thinVolume }: { collectionId: string; thinVolume: boolean }) {
  // Pinnacle's Pins feed is edition-level (/api/market → pinnacle_catalog, one row
  // per render with a fresh direct-chain floor_ask), so it normally shows every
  // priced edition. This empty state is the fallback for when no renders carry a
  // maintained floor / the upstream is briefly unavailable — point to Sniper
  // (serial-level deals below FMV) + the Packs sub-view rather than a bare "no listings".
  if (collectionId === "disney-pinnacle") {
    return (
      <div className="rpc-card" style={{ padding: 40, textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <div style={{ fontSize: 32, color: "var(--rpc-text-ghost)" }}>✨</div>
        <div className="rpc-heading" style={{ fontSize: 16 }}>No pin listings right now</div>
        <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", maxWidth: 500, lineHeight: 1.7 }}>
          No Disney Pinnacle pins are listed at the moment. Check the <strong>Sniper</strong> tab for render-keyed
          deals below FMV and the <strong>Packs</strong> sub-view above for pack EV — or come back shortly as new
          listings land.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Link href={`/${collectionId}/sniper`} className="rpc-chip" style={{ color: "var(--rpc-accent, var(--rpc-red))" }}>
            Open Pinnacle Sniper →
          </Link>
          <Link href={`/${collectionId}/overview`} className="rpc-chip">
            Overview
          </Link>
        </div>
      </div>
    )
  }

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

// ── Market section (Moments | Packs sub-toggle) ─────────────────────────
// After the 2026-07-18 IA reorg the Market tab carries a Moments|Packs
// sub-toggle (?section=packs) for collections that have a pack board. Moments
// is the existing market browser (<MarketInner/>); Packs is the shared
// <PackMarketView/> (pack-EV board). Collections without packs (UFC — which
// also has no market tab) render Moments-only with no sub-nav.
function MarketSection() {
  const { collectionId, accent } = useCollectionContext()
  const searchParams = useSearchParams()
  const section = subSectionFromParams(searchParams)
  const showPacks = collectionHasPage(collectionId, "packs")
  const packsActive = showPacks && section === "packs"

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {showPacks && (
        <div style={{ display: "flex" }}>
          <PackSubNav
            accent={accent}
            active={packsActive ? "packs" : "moments"}
            momentsLabel={collectionId === "disney-pinnacle" ? "Pins" : "Moments"}
          />
        </div>
      )}
      {packsActive ? <PackMarketView collection={collectionId} /> : <MarketInner />}
    </div>
  )
}

// ── Page wrapper ────────────────────────────────────────────────────────
export default function MarketClient() {
  return (
    <Suspense fallback={<div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>Loading market…</div>}>
      <MarketSection />
    </Suspense>
  )
}
