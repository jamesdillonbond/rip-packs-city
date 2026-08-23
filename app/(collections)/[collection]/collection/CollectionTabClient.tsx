"use client"

import { useMemo, useState, useReducer, useEffect, useCallback, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, useParams, useSearchParams } from "next/navigation"
import { PackSubNav, subSectionFromParams } from "@/components/collection/PackSubNav"
import WalletSoldMomentsView from "@/components/collection/WalletSoldMomentsView"
import WalletPacksView from "@/components/packs/WalletPacksView"
import { buildEditionScopeKey } from "@/lib/wallet-normalize"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"
import { getCollection, COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { useWarmCache, usePrefetch, useWarmup } from "@/lib/warmup/WarmupContext"
import { BADGE_TYPE_TO_TITLE } from "@/lib/topshot-badges"
import MomentDetailModal from "@/components/MomentDetailModal"
import CollectionFilterBar from "@/components/collection/CollectionFilterBar"
import CollectionSortBar from "@/components/collection/CollectionSortBar"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"
import WalletStatRow from "@/components/wallet-stat-row"
import { formatCurrency, formatCount } from "@/lib/format"
import { acquisitionMethodLabel } from "@/lib/analytics/shape"
import { track } from "@/lib/telemetry/track"
import { pickLoading } from "@/lib/schonely"
import { MarketplaceStatusBanner } from "@/components/marketplace-status"
import AutoSearchReader from "@/components/collection/AutoSearchReader"
import PortfolioSummary from "@/components/collection/PortfolioSummary"
import CollectionRecentSales from "@/components/collection/CollectionRecentSales"
import { useMobile } from "@/components/collection/use-mobile"
import {
  type BadgeInfo,
  type MomentRow,
  type WalletSearchResponse,
  type CollectionSeriesEntry,
  type SortKey,
} from "@/lib/collection/types"
import {
  collectionViewReducer,
  initialCollectionView,
} from "@/lib/collection/view-reducer"
import { buildCollectionCsv } from "@/lib/collection/export-csv"
import { serverMomentToRow, type ServerMoment } from "@/lib/collection/server-moment"
import { computeCollectionTotals } from "@/lib/collection/totals"
import { computeFilteredSortedRows } from "@/lib/collection/filter-sort"
import { resolveSeriesParam } from "@/lib/collection/series-param"
import {
  buildPlayerOptions,
  buildSetOptions,
  buildRarityOptions,
  buildSeriesOptions,
  buildBatchEditionStats,
  buildPackLookup,
  getPackCount as computePackCount,
  nearCompleteSets as computeNearCompleteSets,
} from "@/lib/collection/filter-options"
import {
  ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR,
  BADGE_PILL_TITLES,
  seriesIntToSeason,
  getParallel,
  getSerial,
  getMint,
  getBestAsk,
  debugReasonLabel,
  sortKeyToServerSort,
  computeDuplicateEditionKeys,
} from "@/lib/collection/helpers"

// ── Main component ────────────────────────────────────────────────────────────

function WalletMomentsBody() {
  const router = useRouter()
  const routeParams = useParams()
  const collectionSlug = (routeParams?.collection as string) ?? "nba-top-shot"
  const collectionObj = getCollection(collectionSlug)
  const accent = collectionObj?.accent ?? "var(--rpc-red)"
  // Collection UUID for collection-aware badge art — NFL All Day badges resolve
  // their own SVGs instead of inheriting the Top Shot title-collision. (2026-06-29)
  const badgeCollectionId = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? null
  const lastSearchedRef = useRef("")
  const ownedFlowIdsRef: React.MutableRefObject<Set<string>> = useRef(new Set<string>())
  const [rows, setRows] = useState<MomentRow[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [summary, setSummary] = useState<WalletSearchResponse["summary"]>()
  // VIEW state (filter/sort/expand/modal controls) lives in one reducer so the
  // filter bar + moment table can extract with a single {view, dispatchView}
  // prop pair. DATA/fetch state stays as useState below.
  const [view, dispatchView] = useReducer(collectionViewReducer, initialCollectionView)
  const [showDebug, setShowDebug] = useState(false)
  const [debugMode, setDebugMode] = useState(false)
  useEffect(function() {
    if (typeof window !== "undefined") {
      setDebugMode(new URLSearchParams(window.location.search).get("debug") === "1")
    }
  }, [])
  const [hasSearched, setHasSearched] = useState(false)
  const [ownerKey, setOwnerKey] = useState("")
  const [packsByTitle, setPacksByTitle] = useState<Record<string, number>>({})
  // Bumped once per runSearch; CollectionRecentSales owns the fetch + its own state.
  const [salesSearchNonce, setSalesSearchNonce] = useState(0)
  const [copied, setCopied] = useState(false);
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [isSeededPreloaded, setIsSeededPreloaded] = useState(false);

  // Server-paginated moments API state
  const [paginatedPage, setPaginatedPage] = useState(1)
  const [paginatedTotal, setPaginatedTotal] = useState(0)
  const [paginatedTotalPages, setPaginatedTotalPages] = useState(0)
  const [walletTotalFmv, setWalletTotalFmv] = useState<number | null>(null)
  const [walletSummary, setWalletSummary] = useState<{
    wallet_fmv: number
    unlocked_fmv: number
    unlocked_count: number
    locked_fmv: number
    locked_count: number
    cost_basis: number
    current_fmv: number
    pnl: number
  } | null>(null)
  const [walletSummaryLoading, setWalletSummaryLoading] = useState(false)
  const [acquisitionStats, setAcquisitionStats] = useState<{
    pack_pull_count: number
    marketplace_count: number
    challenge_reward_count: number
    gift_count: number
    trade_count?: number
    total_count: number
    locked_count: number
    total_spent: number
  } | null>(null)
  const [activeWallet, setActiveWallet] = useState("")
  const [costBasis, setCostBasis] = useState<Map<string, { buyPrice: number; acquiredDate: string; fmvAtAcquisition: number | null; acquisitionMethod: string | null; costBasisLabel: string | null }>>(new Map())
  const [serverSortBy, setServerSortBy] = useState("fmv_desc")


  const [setsData, setSetsData] = useState<{ sets: any[] } | null>(null)
  const isMobile = useMobile()

  // ── Collection series (fetched from collection_series table) ──────────────
  const [collectionSeriesMap, setCollectionSeriesMap] = useState<Map<number, CollectionSeriesEntry>>(new Map())
  const [collectionSeriesOptions, setCollectionSeriesOptions] = useState<{ label: string; seriesNumber: number }[]>([])

  // Hydrate filter state from localStorage on mount
  useEffect(function() {
    try {
      var stored = function(key: string) { return localStorage.getItem("rpc_collection_" + key) }
      var sk = stored("sortKey")
      if (sk) dispatchView({ type: "SET", field: "sortKey", value: JSON.parse(sk) as SortKey })
      var sd = stored("sortDirection")
      if (sd) dispatchView({ type: "SET", field: "sortDirection", value: JSON.parse(sd) as "asc" | "desc" })
      var pf = stored("playerFilter")
      if (pf) dispatchView({ type: "SET", field: "playerFilter", value: JSON.parse(pf) })
      var sf = stored("setFilter")
      if (sf) dispatchView({ type: "SET", field: "setFilter", value: JSON.parse(sf) })
      var serf = stored("seriesFilter")
      if (serf) dispatchView({ type: "SET", field: "seriesFilter", value: JSON.parse(serf) })
      var rf = stored("rarityFilter")
      if (rf) dispatchView({ type: "SET", field: "rarityFilter", value: JSON.parse(rf) })
      var lf = stored("lockedFilter")
      if (lf) dispatchView({ type: "SET", field: "lockedFilter", value: JSON.parse(lf) })
      var bf = stored("badgeFilter")
      if (bf) dispatchView({ type: "SET", field: "badgeFilter", value: JSON.parse(bf) === true })
    } catch {}
  }, [])

  // Persist filter state to localStorage on every change
  useEffect(function() {
    try {
      localStorage.setItem("rpc_collection_sortKey", JSON.stringify(view.sortKey))
      localStorage.setItem("rpc_collection_sortDirection", JSON.stringify(view.sortDirection))
      localStorage.setItem("rpc_collection_playerFilter", JSON.stringify(view.playerFilter))
      localStorage.setItem("rpc_collection_setFilter", JSON.stringify(view.setFilter))
      localStorage.setItem("rpc_collection_seriesFilter", JSON.stringify(view.seriesFilter))
      localStorage.setItem("rpc_collection_rarityFilter", JSON.stringify(view.rarityFilter))
      localStorage.setItem("rpc_collection_lockedFilter", JSON.stringify(view.lockedFilter))
      localStorage.setItem("rpc_collection_badgeFilter", JSON.stringify(view.badgeFilter))
    } catch {}
  }, [view.sortKey, view.sortDirection, view.playerFilter, view.setFilter, view.seriesFilter, view.rarityFilter, view.lockedFilter, view.badgeFilter])

  // Fetch collection_series for the current collection
  useEffect(function() {
    fetch("/api/collection-series?collection=" + encodeURIComponent(collectionSlug))
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(data) {
        if (!data || !Array.isArray(data.series)) return
        const map = new Map<number, CollectionSeriesEntry>()
        const opts: { label: string; seriesNumber: number }[] = []
        for (const s of data.series) {
          map.set(s.series_number, { series_number: s.series_number, display_label: s.display_label, season: s.season ?? null })
          opts.push({ label: s.display_label, seriesNumber: s.series_number })
        }
        setCollectionSeriesMap(map)
        setCollectionSeriesOptions(opts)
      })
      .catch(function() {})
  }, [collectionSlug])

  useEffect(function() {
    setOwnerKey(getOwnerKey())
    return onOwnerKeyChange(function(key) { setOwnerKey(key) })
  }, [])

  // ── Warm cache: saved wallets + per-wallet wallet-search prefetch ─────────
  // Reads the user's saved wallets (5-min TTL) and fires background fetches
  // for every saved wallet that isn't the currently-viewed address, so that
  // clicking "Load" in the saved-wallets sidebar feels instant.
  const savedWalletsKey = ownerKey ? "saved-wallets:" + ownerKey : "saved-wallets:none"
  const savedWalletsFetcher = useCallback(async function() {
    if (!ownerKey) return { wallets: [] as any[] }
    const res = await fetch("/api/profile/saved-wallets?ownerKey=" + encodeURIComponent(ownerKey))
    if (!res.ok) return { wallets: [] as any[] }
    return await res.json()
  }, [ownerKey])
  const { data: savedWalletsData } = useWarmCache<{ wallets?: any[] }>(
    savedWalletsKey,
    savedWalletsFetcher,
    { ttlMs: 5 * 60_000, enabled: !!ownerKey },
  )
  const prefetch = usePrefetch()
  const warm = useWarmup()
  const prefetchFiredRef = useRef(false)
  useEffect(function() {
    if (prefetchFiredRef.current) return
    if (!ownerKey) return
    if (!savedWalletsData) return
    const wallets = (savedWalletsData.wallets ?? []) as any[]
    if (!wallets.length) return
    prefetchFiredRef.current = true
    const current = (activeWallet || "").trim().toLowerCase()
    for (const w of wallets) {
      const addr = (w.wallet_addr ?? "").trim()
      const username = (w.username ?? "").trim()
      const input = username || addr
      if (!input) continue
      if (current && (addr.toLowerCase() === current || username.toLowerCase() === current)) continue
      const body = JSON.stringify({ input, offset: 0, limit: 50 })
      prefetch(
        "wallet-search:" + input,
        async function() {
          const res = await fetch("/api/wallet-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
          if (!res.ok) throw new Error("wallet-search " + res.status)
          return await res.json()
        },
        90_000,
      )
    }
  }, [ownerKey, savedWalletsData, activeWallet, prefetch])

  // ── Fetch real total FMV when wallet changes ──────────────────────────────
  useEffect(function() {
    if (!activeWallet) return
    let cancelled = false
    fetch("/api/collection-moments?wallet=" + encodeURIComponent(activeWallet) + "&limit=1&page=1&collection=" + encodeURIComponent(collectionSlug))
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(json) {
        if (cancelled || !json) return
        if (typeof json.total_fmv === "number" && json.total_fmv > 0) {
          setWalletTotalFmv(json.total_fmv)
        }
      })
      .catch(function() {})
    return function() { cancelled = true }
  }, [activeWallet, collectionSlug])

  // ── Fetch cost basis when wallet changes ──────────────────────────────────
  useEffect(function() {
    if (!activeWallet) { setCostBasis(new Map()); return }
    let cancelled = false
    fetch("/api/cost-basis?wallet=" + encodeURIComponent(activeWallet) + "&collection=" + encodeURIComponent(collectionSlug))
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(data) {
        if (cancelled || !data) return
        const map = new Map<string, { buyPrice: number; acquiredDate: string; fmvAtAcquisition: number | null; acquisitionMethod: string | null; costBasisLabel: string | null }>()
        for (const item of (data.acquisitions ?? [])) {
          const method = item.acquisition_method ?? null
          map.set(item.nft_id, {
            buyPrice: Number(item.buy_price),
            acquiredDate: item.acquired_date,
            fmvAtAcquisition: item.fmv_at_acquisition != null ? Number(item.fmv_at_acquisition) : null,
            acquisitionMethod: method,
            costBasisLabel: acquisitionMethodLabel(method),
          })
        }
        setCostBasis(map)
      })
      .catch(function() {})
    return function() { cancelled = true }
  }, [activeWallet, collectionSlug])

  // ── Background cache refresh: detect new on-chain moments ─────────────────
  useEffect(function() {
    if (!activeWallet) return
    let cancelled = false
    fetch("/api/cache-refresh?wallet=" + encodeURIComponent(activeWallet) + "&collection=" + encodeURIComponent(collectionSlug))
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(data) {
        if (cancelled || !data) return
        if (data.new_stubs_inserted > 0) {
          console.log("[collection] cache-refresh found " + data.new_stubs_inserted + " new moments, reloading page 1")
          fetchPaginatedMoments(activeWallet, 1, serverSortBy, false)
        }
      })
      .catch(function() {})
    return function() { cancelled = true }
  }, [activeWallet, collectionSlug])

  // ── FCL wallet connection (for own-collection detection) ───────────────────
  useEffect(function() {
    let cancelled = false
    import("@onflow/fcl")
      .then(function(fcl) {
        fcl.currentUser.subscribe(function(user: { addr?: string | null }) {
          if (!cancelled) setConnectedWallet(user?.addr ?? null)
        })
      })
      .catch(function() {})
    return function() { cancelled = true }
  }, [])

  // ── Badge enrichment ────────────────────────────────────────────────────────

  async function enrichWithBadges(rowsIn: MomentRow[]): Promise<MomentRow[]> {
    if (!rowsIn.length) return rowsIn
    try {
      const playerNames = Array.from(new Set(
        rowsIn.map((r: MomentRow) => r.playerName?.trim()).filter(Boolean)
      )) as string[]
      if (!playerNames.length) return rowsIn
      const CHUNK = 50
      const allEditions: any[] = []
      const collectionIdParam = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? COLLECTION_UUID_BY_SLUG["nba-top-shot"]
      for (let i = 0; i < playerNames.length; i += CHUNK) {
        const chunk = playerNames.slice(i, i + CHUNK)
        const params = new URLSearchParams({
          mode: "all", sort: "badge_score", dir: "desc",
          limit: "500", offset: "0", players: chunk.join(","),
          collection_id: collectionIdParam,
        })
        const res = await fetch("/api/badges?" + params.toString())
        if (!res.ok) continue
        const json = await res.json()
        allEditions.push(...(json.editions ?? []))
      }
      const badgeMap = new Map<string, BadgeInfo>()
      for (const edition of allEditions) {
        if (!edition.player_name || edition.series_number == null) continue
        const key = edition.player_name.toLowerCase().trim() + "::" + edition.series_number
        const existing = badgeMap.get(key)
        if (!existing || edition.badge_score > existing.badge_score) {
          badgeMap.set(key, {
            badge_score: edition.badge_score,
            badge_titles: (edition.badge_titles ?? []).filter((t: string) => BADGE_PILL_TITLES.has(t)),
            is_three_star_rookie: edition.is_three_star_rookie,
            has_rookie_mint: edition.has_rookie_mint,
            burn_rate_pct: edition.burn_rate_pct,
            lock_rate_pct: edition.lock_rate_pct,
            low_ask: edition.low_ask,
            circulation_count: edition.circulation_count,
            effective_supply: edition.effective_supply ?? null,
            burned: edition.burned ?? 0,
            owned: edition.owned ?? 0,
            hidden_in_packs: edition.hidden_in_packs ?? 0,
            for_sale_by_collectors: edition.for_sale_by_collectors ?? null,
          })
        }
      }
      return rowsIn.map((row: MomentRow) => {
        const seriesNum = typeof row.series === "string"
          ? parseInt(row.series, 10)
          : (row.series as number | undefined)
        if (seriesNum == null || isNaN(seriesNum)) return { ...row, badgeInfo: null }
        const playerKey = (row.playerName?.toLowerCase().trim() ?? "")
        const key = playerKey + "::" + seriesNum
        // On-chain series 0 = display Series 1 in badge_editions; try both
        const badge = badgeMap.get(key) ?? (seriesNum === 0 ? badgeMap.get(playerKey + "::1") : null)
        return { ...row, badgeInfo: badge ?? null }
      })
    } catch {
      return rowsIn
    }
  }

  // ── FMV enrichment via batch /api/fmv endpoint ─────────────────────────────
  async function enrichFmv(rowsIn: MomentRow[]): Promise<MomentRow[]> {
    if (!rowsIn.length) return rowsIn
    try {
      const uniqueKeys = Array.from(new Set(
        rowsIn.map(function(r) { return r.editionKey }).filter(function(k): k is string { return !!k })
      ))
      if (!uniqueKeys.length) return rowsIn

      const fmvMap = new Map<string, { fmv: number; confidence: string; updatedAt: string | null }>()
      const BATCH = 100
      for (let i = 0; i < uniqueKeys.length; i += BATCH) {
        const batch = uniqueKeys.slice(i, i + BATCH)
        try {
          const res = await fetch("/api/fmv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ editions: batch }),
          })
          if (!res.ok) continue
          const json = await res.json()
          if (Array.isArray(json.results)) {
            for (const r of json.results) {
              if (r.fmv && r.fmv > 0) {
                fmvMap.set(r.edition, { fmv: r.fmv, confidence: r.confidence, updatedAt: r.updatedAt })
              }
            }
          }
        } catch { /* batch failed, continue with next */ }
      }

      console.log("[FMV-ENRICH] " + fmvMap.size + " / " + uniqueKeys.length + " editions enriched with FMV")

      if (!fmvMap.size) return rowsIn
      return rowsIn.map(function(row) {
        if (!row.editionKey) return row
        const fmvData = fmvMap.get(row.editionKey)
        if (!fmvData) return row
        // Only overwrite if row has no FMV or zero FMV
        if (row.fmv && row.fmv > 0) return row
        return { ...row, fmv: fmvData.fmv, fmvComputedAt: fmvData.updatedAt, marketConfidence: fmvData.confidence as MomentRow["marketConfidence"] }
      })
    } catch {
      return rowsIn
    }
  }

  // Debounced offer enrichment — accumulates rows across page loads,
  // fires once after 2s idle, chunks into batches of 200 momentIds
  const pendingOfferRowsRef = useRef<MomentRow[]>([])
  const offerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function flushOfferEnrichment() {
    const allRows = pendingOfferRowsRef.current
    pendingOfferRowsRef.current = []
    if (!allRows.length) return

    const CHUNK_SIZE = 200
    for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
      const chunk = allRows.slice(i, i + CHUNK_SIZE)
      const momentIds = chunk.map(function(r) { return r.momentId })
      const editionKeys = chunk.map(function(r) { return r.editionKey ?? "" })
      // Item 1: per-moment serial, aligned by index, so the route can fold in a
      // serial-grain offer that targets exactly this serial (can exceed the
      // edition offer).
      const serials = chunk.map(function(r) { return r.serial ?? null })
      const collectionId = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? ""
      fetch("/api/best-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds, editionKeys, serials, collectionId }),
      })
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) {
          if (!d || !Array.isArray(d.results)) return
          const offerMap = new Map<string, { bestOffer: number; bestOfferType: "edition" | "serial" | null; editionOffer: number | null }>()
          for (const result of d.results) {
            if (typeof result.bestOffer === "number" && result.bestOffer > 0) {
              // Determine edition-level offer from bestOfferType
              const editionOffer = result.bestOfferType === "edition" ? result.bestOffer : null
              offerMap.set(String(result.momentId), {
                bestOffer: result.bestOffer,
                bestOfferType: result.bestOfferType ?? null,
                editionOffer,
              })
            }
          }
          if (!offerMap.size) return
          setRows(function(prev) {
            return prev.map(function(row) {
              const fresh = offerMap.get(row.momentId)
              if (!fresh) return row
              if (row.bestOffer && row.bestOffer >= fresh.bestOffer) return row
              return {
                ...row,
                bestOffer: fresh.bestOffer,
                bestOfferType: fresh.bestOfferType,
                editionOffer: fresh.editionOffer,
              }
            })
          })
        })
        .catch(function() {})
    }
  }

  function enrichOffers(momentRows: MomentRow[]) {
    if (!momentRows.length) return
    // Accumulate rows for batch processing
    pendingOfferRowsRef.current = pendingOfferRowsRef.current.concat(momentRows)
    // Reset the 2-second idle timer
    if (offerTimerRef.current) clearTimeout(offerTimerRef.current)
    offerTimerRef.current = setTimeout(flushOfferEnrichment, 2000)
  }

  // ── Server-paginated moments fetch ──────────────────────────────────────
  // ServerMoment type and the row mapping live in
  // @/lib/collection/server-moment (extracted for unit testing). The mapper
  // takes collectionObj?.sport as a param since it was the only closed-over value.

  async function fetchPaginatedMoments(wallet: string, page: number, sort: string, append: boolean) {
    const params = new URLSearchParams({
      wallet,
      page: String(page),
      limit: "50",
      sortBy: sort,
      collection: collectionSlug,
    })
    // Apply active filters to server query
    if (view.playerFilter !== "all") params.set("player", view.playerFilter)
    if (view.seriesFilter !== "all") {
      // Convert display label back to series number (dynamic collection_series
      // data first, Top Shot hardcoded-label fallback second).
      const sn = resolveSeriesParam(view.seriesFilter, collectionSeriesOptions)
      if (sn) params.set("series", sn)
    }
    if (view.rarityFilter !== "all") params.set("tier", view.rarityFilter)

    const url = "/api/collection-moments?" + params.toString()
    // Zero-wait when a WarmupContext prewarm is fresh; otherwise fetchOrJoin so an
    // in-flight prewarm is SHARED (one query — no whale-wallet double-load).
    const cachedEntry = warm.read(url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = (cachedEntry && Date.now() - cachedEntry.fetchedAt < cachedEntry.ttlMs)
      ? cachedEntry.data
      : await warm.fetchOrJoin(url, async function() {
          const res = await fetch(url)
          if (!res.ok) {
            const j = await res.json().catch(function() { return {} })
            throw new Error(j.error || "Failed to load moments")
          }
          return res.json()
        }, 30_000)
    const moments: ServerMoment[] = json.moments ?? []
    const momentRows = moments.map((m) => serverMomentToRow(m, collectionObj?.sport))

    // Sync rpc_owner_key to the resolved 0x address so the sniper page can
    // find this wallet's owned IDs automatically (especially for username searches).
    const resolvedWallet: string | undefined = json.wallet
    try {
      if (resolvedWallet && resolvedWallet.startsWith("0x")) {
        const current = localStorage.getItem("rpc_owner_key")
        if (current !== resolvedWallet) localStorage.setItem("rpc_owner_key", resolvedWallet)
      }
    } catch {}

    // Accumulate owned flow IDs from this page into the ref, then persist
    // the full set to localStorage so the sniper page can read it.
    // moment_id from collection-moments is the same on-chain NFT ID as
    // sniper-feed's flowId, so they match for ownership lookups.
    try {
      for (const m of moments) {
        const id = m && m.moment_id ? String(m.moment_id) : ""
        if (id) ownedFlowIdsRef.current.add(id)
      }
      if (resolvedWallet) {
        localStorage.setItem(
          "rpc_owned_" + resolvedWallet,
          JSON.stringify(Array.from(ownedFlowIdsRef.current))
        )
      }
    } catch {}

    // Enrich with badges, then FMV via batch API
    const withBadges = await enrichWithBadges(momentRows)
    const withFmv = await enrichFmv(withBadges)

    // Append new pages at end — API returns pre-sorted results, so concat
    // preserves sort order without client-side re-sort (see filteredRows memo).
    if (append) {
      setRows(function(prev) { return prev.concat(withFmv) })
    } else {
      setRows(withFmv)
    }
    setPaginatedPage(json.page ?? page)
    setPaginatedTotal(json.total_count ?? 0)
    setPaginatedTotalPages(json.total_pages ?? 0)
    if (typeof json.total_fmv === "number") setWalletTotalFmv(json.total_fmv)
    if (json.acquisitionStats) setAcquisitionStats(json.acquisitionStats)

    // Fire-and-forget: enrich best offers
    enrichOffers(withFmv)

    return { momentRows: withFmv, totalCount: json.total_count ?? 0 }
  }

  const runSearch = useCallback(async function(query: string) {
    if (!query.trim()) return
    const trimmed = query.trim()
    track("search-executed", {
      collection: collectionSlug,
      input_kind: trimmed.startsWith("0x") ? "address" : "username",
    })
    setInput(trimmed)
    setActiveWallet(trimmed)
    lastSearchedRef.current = trimmed
    // Reset accumulated owned flow IDs at the start of each new wallet search
    ownedFlowIdsRef.current = new Set<string>()
    // Task 15: Persist wallet address in URL for bookmarking and sharing
    try { router.replace("?wallet=" + encodeURIComponent(trimmed), { scroll: false }) } catch {}
    setLoading(true)
    setError("")
    setRows([])
    setSummary(undefined)
    dispatchView({ type: "COLLAPSE_ALL" })
    setHasSearched(false)
    setWalletTotalFmv(null)
    setWalletSummary(null)
    setAcquisitionStats(null)
    setPacksByTitle({})
    setPaginatedPage(1)
    setPaginatedTotal(0)
    setPaginatedTotalPages(0)
    // Clear any pending offer enrichment from previous search
    pendingOfferRowsRef.current = []
    if (offerTimerRef.current) { clearTimeout(offerTimerRef.current); offerTimerRef.current = null }
    setSalesSearchNonce(function(n) { return n + 1 });
    try {
      const sort = sortKeyToServerSort(view.sortKey, view.sortDirection)
      setServerSortBy(sort)

      // UFC: scan + first enrich chunk on the Flow blockchain before reading
      // from the wallet_moments_cache. Background chunks continue server-side.
      let ufcEnrichPending = false
      if (collectionSlug === "ufc" && trimmed.startsWith("0x")) {
        try {
          setError("Scanning Flow blockchain for UFC moments...")
          const scanRes = await fetch("/api/ufc-wallet-scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet: trimmed }),
          })
          if (scanRes.ok) {
            const scanJson = await scanRes.json()
            ufcEnrichPending = scanJson?.done === false
          }
          setError("")
        } catch {
          setError("")
        }
      }

      // Primary: fetch paginated moments from Supabase cache (fast ~200ms)
      const { totalCount } = await fetchPaginatedMoments(trimmed, 1, sort, false)

      // UFC background enrichment is still running — re-fetch in 30s to pick up newly enriched moments.
      if (ufcEnrichPending) {
        setTimeout(function() {
          fetchPaginatedMoments(trimmed, 1, sort, false).catch(function() {})
        }, 30000)
      }
      setHasSearched(true)
      console.log("[collection] paginated API returned page 1, total_count=" + totalCount)

      // Fetch accurate wallet-wide totals (FMV, locked/unlocked, cost basis, pnl)
      // via get_wallet_summary RPC — covers ALL moments, not just the loaded page.
      setWalletSummaryLoading(true)
      const summaryCollectionId = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? ""
      fetch("/api/wallet-summary?wallet=" + encodeURIComponent(trimmed) + "&collection=" + encodeURIComponent(collectionSlug) + (summaryCollectionId ? "&collection_id=" + encodeURIComponent(summaryCollectionId) : ""))
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(json) {
          if (!json || json.error) return
          setWalletSummary({
            wallet_fmv: Number(json.wallet_fmv) || 0,
            unlocked_fmv: Number(json.unlocked_fmv) || 0,
            unlocked_count: Number(json.unlocked_count) || 0,
            locked_fmv: Number(json.locked_fmv) || 0,
            locked_count: Number(json.locked_count) || 0,
            cost_basis: Number(json.cost_basis) || 0,
            current_fmv: Number(json.current_fmv) || 0,
            pnl: Number(json.pnl) || 0,
          })
          if (typeof json.wallet_fmv === "number" && json.wallet_fmv > 0) {
            setWalletTotalFmv(json.wallet_fmv)
          }
          // Fire-and-forget on-demand lock refresh (Top Shot only — it's the display
          // whose staleness overstates locks). The old `lockedCount < 500` guard was
          // exactly backwards: it SKIPPED the wallets already showing many (stale) locks,
          // so an overstated whale never self-corrected. The server now refreshes the
          // STALEST held moments first + stamps lock_checked_at, and early-outs at ~one
          // indexed query when the wallet is already fresh, so firing on every TS view is
          // both safe and what makes the viewed wallet's lock count trustworthy.
          if (collectionSlug === "nba-top-shot") {
            fetch("/api/cache-refresh?wallet=" + encodeURIComponent(trimmed) + "&refreshLocked=1").catch(function() {})
          }
        })
        .catch(function() {})
        .finally(function() { setWalletSummaryLoading(false) })

      // Secondary: call wallet-search for summary stats only (total FMV, locked/unlocked counts)
      // This runs in parallel as a background fetch — does NOT block the moment display.
      // Skipped for UFC: wallet-search is driven by Top Shot GQL and has no UFC path.
      if (trimmed && collectionSlug !== "ufc") {
        const walletSearchBody: Record<string, unknown> = { input: trimmed, offset: 0, limit: 50, collection: collectionSlug }
        if (collectionSlug === "nba-top-shot" && view.leagueFilter !== "all") walletSearchBody.league = view.leagueFilter
        fetch("/api/wallet-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(walletSearchBody),
        })
          .then(function(r) { return r.ok ? r.json() : null })
          .then(function(json: WalletSearchResponse | null) {
            if (!json) return
            setSummary(json.summary)
            // Also update the wallet cache from live data for future loads
            const liveRows = Array.isArray(json.rows) ? json.rows : []
            if (liveRows.length > 0) {
              fetch("/api/wallet-cache", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  wallet: trimmed,
                  collection: collectionSlug,
                  moments: liveRows.map(function(r) {
                    return { momentId: r.momentId, editionKey: r.editionKey, serial: r.serialNumber ?? r.serial }
                  }),
                }),
              }).catch(function() {})
            }
            // Note: cached_fmv_usd / cached_moment_count on saved_wallets are
            // deprecated — /profile reads live per-collection numbers from
            // get_wallet_collection_stats instead, so no patch is needed here.
          })
          .catch(function() {})
      }

      // Fire-and-forget: fetch sets data for "close to completing" callout
      fetch("/api/sets?wallet=" + encodeURIComponent(trimmed) + "&skipAsks=1")
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) { if (d) setSetsData(d) })
        .catch(function() {})
      // Fire-and-forget: load sealed pack titles for this wallet. (The response's
      // totalSealedPacks was previously stored in a `sealedPackCount` state that
      // nothing ever read — dropped 2026-07-28; re-add a reader before the state.)
      fetch("/api/wallet-packs?wallet=" + encodeURIComponent(trimmed))
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) {
          if (d && d.packsByTitle) setPacksByTitle(d.packsByTitle)
        })
        .catch(function() {})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [router, collectionSlug, view.sortKey, view.sortDirection, view.playerFilter, view.seriesFilter, view.rarityFilter, view.leagueFilter])

  // Auto-search on mount: prefer the raw input the user last typed
  // (rpc_last_wallet — username or address) over the resolved 0x ownerKey.
  useEffect(function() {
    if (rows.length === 0 && !loading && !lastSearchedRef.current) {
      let saved = ""
      try { saved = localStorage.getItem("rpc_last_wallet") || "" } catch {}
      const seed = saved || ownerKey
      if (seed) {
        setInput(seed)
        runSearch(seed)
        // Check if this query matches a seeded (pre-cached) wallet.
        if (!seed.startsWith("0x")) {
          fetch("/api/seeded-wallets?username=" + encodeURIComponent(seed))
            .then(function(r) { return r.ok ? r.json() : null })
            .then(function(json) {
              const hit = json && Array.isArray(json.wallets) && json.wallets[0]
              if (!hit || !hit.last_refreshed_at) return
              const ageMs = Date.now() - new Date(hit.last_refreshed_at).getTime()
              if (ageMs < 2 * 60 * 60 * 1000) setIsSeededPreloaded(true)
            })
            .catch(function() {})
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])

  // Auto-paginate: after initial search, fetch remaining pages automatically
  useEffect(function() {
    if (!hasSearched || !activeWallet || paginatedPage >= paginatedTotalPages || loading) return
    let cancelled = false
    const isMobileNow = typeof window !== "undefined" && window.innerWidth < 768
    const pageLimit = isMobileNow ? 25 : 50
    const maxRows = isMobileNow ? 150 : Infinity

    async function autoPaginate() {
      setLoadingMore(true)
      let currentPage = paginatedPage
      while (currentPage < paginatedTotalPages && !cancelled) {
        if (rows.length >= maxRows) break
        try {
          await new Promise(function(resolve) { setTimeout(resolve, 300) })
          if (cancelled) break
          const params = new URLSearchParams({
            wallet: activeWallet,
            page: String(currentPage + 1),
            limit: String(pageLimit),
            sortBy: serverSortBy,
            collection: collectionSlug,
          })
          if (view.playerFilter !== "all") params.set("player", view.playerFilter)
          if (view.seriesFilter !== "all") {
            const sn = resolveSeriesParam(view.seriesFilter, collectionSeriesOptions)
            if (sn) params.set("series", sn)
          }
          if (view.rarityFilter !== "all") params.set("tier", view.rarityFilter)
          const res = await fetch("/api/collection-moments?" + params.toString())
          if (!res.ok) break
          const json = await res.json()
          const moments: ServerMoment[] = json.moments ?? []
          if (moments.length === 0) break
          const momentRows = moments.map((m) => serverMomentToRow(m, collectionObj?.sport))
          const withBadges = await enrichWithBadges(momentRows)
          const withFmv = await enrichFmv(withBadges)
          if (cancelled) break
          setRows(function(prev) { return prev.concat(withFmv) })
          currentPage += 1
          setPaginatedPage(currentPage)
          enrichOffers(withFmv)
        } catch {
          break
        }
      }
      // ⚠ GUARDED, and this is the ONE state update in the loop that was not.
      // Every other write checks `cancelled`; this trailing one ran unconditionally,
      // and the loop can only reach it up to ~300 ms AFTER the effect was torn down
      // (the first thing each iteration does is await a 300 ms timer, and the
      // cancellation is only observed when that timer resolves).
      //
      // Two consequences, one per environment. In a browser: the effect re-runs on
      // wallet/total-pages change, so the OLD run's `setLoadingMore(false)` lands
      // after the NEW run's `setLoadingMore(true)` and clears the spinner while the
      // new wallet is still paginating. Under vitest+jsdom: the file's environment
      // is gone by then, so React's dispatchSetState throws
      // `ReferenceError: window is not defined` as an UNHANDLED REJECTION — which
      // fails the component job with every test passing (CI run 32536511776) and
      // reads like an unrelated flake, because the throw is attributed to whichever
      // file happened to be running.
      if (!cancelled) setLoadingMore(false)
    }

    autoPaginate()
    return function() { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearched, activeWallet, paginatedTotalPages])

  async function handleSearch() {
    const raw = input.trim()
    if (raw) { try { localStorage.setItem("rpc_last_wallet", raw) } catch {} }
    await runSearch(input)
  }

  async function handleLoadMore() {
    if (!activeWallet) return
    setLoadingMore(true)
    setError("")
    try {
      await fetchPaginatedMoments(activeWallet, paginatedPage + 1, serverSortBy, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoadingMore(false)
    }
  }

  // Pro-allowlist CSV export of the CURRENT filtered view (moved out of the
  // sort-bar JSX in the Step 3b extraction; body verbatim).
  function handleExportCsv() {
    const wallet = connectedWallet || ownerKey || input.trim()
    const csvString = buildCollectionCsv(filteredRows, collectionSeriesMap)
    const dateStr = new Date().toISOString().slice(0, 10)
    const filename = "rpc-collection-" + (wallet || "unknown") + "-" + dateStr + ".csv"
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function toggleSort(next: SortKey) {
    let newDir: "asc" | "desc"
    if (view.sortKey === next) {
      newDir = view.sortDirection === "asc" ? "desc" : "asc"
    } else {
      newDir = "desc"
    }
    dispatchView({ type: "SET_SORT", key: next, direction: newDir })
    // For server-sortable columns, re-fetch from page 1 with new sort
    const serverSortable = ["fmv", "serial", "acquired"]
    if (serverSortable.includes(next) && activeWallet) {
      const newServerSort = sortKeyToServerSort(next, newDir)
      setServerSortBy(newServerSort)
      setRows([])
      setLoading(true)
      fetchPaginatedMoments(activeWallet, 1, newServerSort, false)
        .catch(function(err) { setError(err instanceof Error ? err.message : "Sort failed") })
        .finally(function() { setLoading(false) })
    }
  }

  function toggleExpanded(momentId: string) {
    dispatchView({ type: "TOGGLE_EXPANDED", id: momentId })
  }

  async function copySeedCandidates() {
    const unique = new Map<string, ReturnType<typeof buildEditionSeedCandidate>>()
    for (const row of filteredRows) {
      const candidate = buildEditionSeedCandidate({
        editionKey: row.editionKey ?? null,
        setName: row.setName ?? null,
        playerName: row.playerName ?? null,
        parallel: row.parallel ?? row.subedition ?? null,
        subedition: row.subedition ?? row.parallel ?? null,
      })
      const key = (candidate.editionKey ?? "none") + "::" + (candidate.parallel ?? "Base")
      if (!unique.has(key)) unique.set(key, candidate)
    }
    await navigator.clipboard.writeText(JSON.stringify(Array.from(unique.values()), null, 2))
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  // Build a lookup: normalized set name → pack count
  // Distribution titles look like "Base Set (Series 4)" or "Holo Icon"
  // We match by checking if a distribution title contains the set name
  const packLookup = useMemo(() => buildPackLookup(packsByTitle), [packsByTitle])

  function getPackCount(setName: string): number {
    return computePackCount(packLookup, setName)
  }

  const batchEditionStats = useMemo(() => buildBatchEditionStats(rows), [rows])

  const availablePlayers = useMemo(() => buildPlayerOptions(rows), [rows])

  const availableSets = useMemo(() => buildSetOptions(rows), [rows])

  const availableRarities = useMemo(() => buildRarityOptions(rows), [rows])

  const availableSeries = useMemo(
    () => buildSeriesOptions(rows, collectionSeriesMap),
    [rows, collectionSeriesMap],
  )

  // True when the loaded collection belongs to the signed-in / connected user
  const isOwnCollection = useMemo(function() {
    if (!input.trim()) return false
    const q = input.trim().toLowerCase()
    if (ownerKey && ownerKey.toLowerCase() === q) return true
    if (connectedWallet && connectedWallet.toLowerCase() === q) return true
    return false
  }, [input, ownerKey, connectedWallet])

  // ── Task 14: Detect duplicate editions ──────────────────────────────────
  const duplicateEditions = useMemo(function() {
    return computeDuplicateEditionKeys(rows)
  }, [rows])

  const filteredRows = useMemo(
    () => computeFilteredSortedRows(rows, view, { collectionSeriesMap, duplicateEditions, batchEditionStats }),
    [rows, view.searchWithin, view.playerFilter, view.setFilter, view.seriesFilter, view.rarityFilter, view.lockedFilter, view.badgeFilter, view.filterBadges, view.filterHasOffer, view.filterListed, view.filterLoanDefaultsOnly, view.filterDupsOnly, duplicateEditions, view.sortKey, view.sortDirection, batchEditionStats, collectionSeriesMap]
  )

  const totals = useMemo(() => computeCollectionTotals(filteredRows), [filteredRows])



  const nearCompleteSets = useMemo(
    () => computeNearCompleteSets(setsData?.sets),
    [setsData],
  )

  // Restore dismissed state from sessionStorage
  useEffect(function() {
    try {
      if (sessionStorage.getItem("rpc_dup_dismissed") === "true") dispatchView({ type: "SET", field: "dupDismissed", value: true })
    } catch {}
  }, [])


  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[var(--rpc-black)] text-[color:var(--rpc-text-primary)] overflow-x-hidden">
      <Suspense fallback={null}>
        <AutoSearchReader onSearch={runSearch} collectionSlug={collectionSlug} />
      </Suspense>

      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

        {/* Marketplace status banner — shown only when not healthy. Surfaces
            UFC/Golazos sunset language so collectors viewing their wallet
            understand why buy-flow CTAs elsewhere on RPC are disabled. */}
        <div style={{ marginBottom: 16 }}>
          <MarketplaceStatusBanner collectionSlug={collectionSlug} />
        </div>

        {/* Profile key indicator */}
        {ownerKey && (
          <div
            className="mb-4 flex items-center gap-2 px-3 py-2"
            style={{
              border: "1px solid var(--rpc-border)",
              background: "var(--rpc-surface)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              color: "var(--rpc-text-muted)",
            }}
          >
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            Signed in as <span style={{ fontWeight: 600, color: "var(--rpc-text-primary)" }}>{/^0x[a-fA-F0-9]{16}$/.test(ownerKey) ? ownerKey.slice(0, 6) + "\u2026" + ownerKey.slice(-4) : ownerKey}</span>
            <span style={{ marginLeft: 4, color: "var(--rpc-text-ghost)" }}>· Loading wallet will update your profile stats</span>
          </div>
        )}

        {/* Search bar */}
        <div className="mb-5 flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={function(e) { setInput(e.target.value) }}
            onKeyDown={function(e) { if (e.key === "Enter" && !loading && input.trim()) handleSearch() }}
            placeholder={ownerKey ? "Enter Top Shot username or wallet address (or press Enter to load your wallet)" : "Enter Top Shot username or wallet address"}
            className="w-full sm:max-w-lg"
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              padding: "8px 12px",
              color: "var(--rpc-text-primary)",
              outline: "none",
            }}
            onFocus={function(e) { e.currentTarget.style.borderColor = "var(--rpc-red)" }}
            onBlur={function(e) { e.currentTarget.style.borderColor = "var(--rpc-border)" }}
          />
          {isSeededPreloaded && (
            <span
              title="This wallet is refreshed every 2 hours so it loads instantly"
              className="inline-flex items-center gap-1 self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
            >
              <span aria-hidden>⚡</span> Pre-loaded
            </span>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSearch}
              disabled={loading || !input.trim()}
              className="rpc-btn-primary"
              style={{
                opacity: loading || !input.trim() ? 0.5 : 1,
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? pickLoading() : "Search"}
            </button>
            {rows.length > 0 && input.trim() && (
              <button
                onClick={function() {
                  const shareUrl = "https://www.rippackscity.com/share/" + encodeURIComponent(input.trim())
                  navigator.clipboard.writeText(shareUrl)
                  setCopied(true)
                  setTimeout(function() { setCopied(false) }, 2000)
                }}
                title="Copy shareable collection card link"
                style={{
                  background: "transparent",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 12px",
                  fontSize: "var(--text-sm)",
                  color: "var(--rpc-text-secondary)",
                  cursor: "pointer",
                  transition: "background var(--transition-fast)",
                }}
                onMouseEnter={function(e) { e.currentTarget.style.background = "var(--rpc-surface-hover)" }}
                onMouseLeave={function(e) { e.currentTarget.style.background = "transparent" }}
              >
                {copied ? "Link copied!" : "Share"}
              </button>
            )}
          </div>
        </div>

        <PortfolioSummary
          hasSearched={hasSearched}
          walletSummary={walletSummary}
          walletTotalFmv={walletTotalFmv}
          totals={totals}
          paginatedTotal={paginatedTotal}
          walletSummaryLoading={walletSummaryLoading}
          acquisitionStats={acquisitionStats}
          rows={rows}
          costBasis={costBasis}
          nearCompleteSets={nearCompleteSets}
          collectionSlug={collectionSlug}
          connectedWallet={connectedWallet}
          ownerKey={ownerKey}
          input={input}
        />

        {/* Filters */}
        <CollectionFilterBar
          view={view}
          dispatchView={dispatchView}
          availablePlayers={availablePlayers}
          availableSets={availableSets}
          availableSeries={availableSeries}
          availableRarities={availableRarities}
          collectionSlug={collectionSlug}
        />

        {/* Sort buttons + quick toggles (Step 3b extraction — layout lives in
            CollectionSortBar; the CSV builder + Pro gate + debug handlers stay
            here so the component is purely presentational). */}
        <CollectionSortBar
          view={view}
          dispatchView={dispatchView}
          toggleSort={toggleSort}
          showLoanDefaultsToggle={view.filterLoanDefaultsOnly || rows.some(function(r) { return r.acquisitionMethod === "loan_default" })}
          showCsvButtons={filteredRows.length > 0 && ["0xbd94cade097e50ac"].includes((connectedWallet || ownerKey || input.trim()).toLowerCase())}
          onExportCsv={handleExportCsv}
          fullCsvHref={"/api/portfolio-export?wallet=" + encodeURIComponent(connectedWallet || ownerKey || input.trim()) + "&collection=" + encodeURIComponent(collectionSlug)}
          debugMode={debugMode}
          showDebug={showDebug}
          onToggleShowDebug={function() { setShowDebug(function(prev) { return !prev }) }}
          onCopySeeds={copySeedCandidates}
        />

        {error ? <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300 text-sm">{error}</div> : null}

        {/* Debug table */}
        {showDebug ? (
          <div className="mb-4 overflow-x-auto rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)]">
            <table className="w-full min-w-[2000px] border-collapse text-xs">
              <thead className="bg-[var(--rpc-surface)]">
                <tr className="border-b border-[color:var(--rpc-border)] text-left">
                  {["Player","Series (raw)","Season","Acquired","Edition Key","Parallel","Scope Key","Held","Locked","Badge Score","Badges","TS Ask","Best Market","Row Low Ask","Row Offer","Edition Low Ask","Edition Offer","Last Sale","FMV","FMV Method","Confidence","Reason"].map(function(h) { return <th key={h} className="p-2 whitespace-nowrap">{h}</th> })}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 50).map(function(row) {
                  const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
                  const counts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
                  return (
                    <tr key={"debug-" + row.momentId} className="border-b border-[color:var(--rpc-border)]">
                      <td className="p-2">{row.playerName}</td>
                      <td className="p-2">{row.series ?? "-"}</td>
                      <td className="p-2">{seriesIntToSeason(row.series, collectionSeriesMap)}</td>
                      <td className="p-2">{row.acquiredAt ? new Date(row.acquiredAt).toLocaleDateString() : "-"}</td>
                      <td className="p-2">{row.editionKey ?? "-"}</td>
                      <td className="p-2">{getParallel(row)}</td>
                      <td className="p-2">{scopeKey}</td>
                      <td className="p-2">{counts.owned}</td>
                      <td className="p-2">{counts.locked}</td>
                      <td className="p-2">{row.badgeInfo?.badge_score ?? "-"}</td>
                      <td className="p-2">{(row.badgeInfo?.badge_titles ?? []).filter(function(t) { return !row.badgeInfo?.is_three_star_rookie || !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) }).join(", ") || "-"}</td>
                      <td className="p-2">{formatCurrency(row.topshotAsk)}</td>
                      <td className="p-2">{row.bestMarket ?? "-"}</td>
                      <td className="p-2">{formatCurrency(row.rowLowAsk ?? getBestAsk(row))}</td>
                      <td className="p-2">{formatCurrency(row.rowBestOffer ?? row.bestOffer)}</td>
                      <td className="p-2">{formatCurrency(row.editionLowAsk)}</td>
                      <td className="p-2">{formatCurrency(row.editionBestOffer)}</td>
                      <td className="p-2">{formatCurrency(row.editionLastSale)}</td>
                      <td className="p-2">{formatCurrency(row.fmv)}</td>
                      <td className="p-2">{row.fmvMethod ?? "-"}</td>
                      <td className="p-2">{row.marketConfidence ?? "-"}</td>
                      <td className="p-2">{debugReasonLabel(row.marketDebugReason)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Main table / mobile cards (Step 3c extraction — mobile cards +
            desktop table + expanded panels live in CollectionMomentTable;
            the FMV-alert form state moved into it too). */}
        <CollectionMomentTable
          isMobile={isMobile}
          filteredRows={filteredRows}
          rowsCount={rows.length}
          summary={summary}
          view={view}
          toggleExpanded={toggleExpanded}
          batchEditionStats={batchEditionStats}
          costBasis={costBasis}
          collectionSeriesMap={collectionSeriesMap}
          collectionSlug={collectionSlug}
          badgeCollectionId={badgeCollectionId}
          connectedWallet={connectedWallet}
          ownerKey={ownerKey}
          input={input}
          hasSearched={hasSearched}
          loading={loading}
          showDebug={showDebug}
          getPackCount={getPackCount}
          accent={accent}
        />

        {paginatedPage < paginatedTotalPages ? (
          <div className="mt-6 flex flex-col items-center gap-2">
            <button onClick={handleLoadMore} disabled={loadingMore} className="rpc-table-load-more">
              {loadingMore ? pickLoading() : "Load More (" + (paginatedTotal - rows.length) + " remaining)"}
            </button>
            <span className="text-xs text-[color:var(--rpc-text-muted)]">
              Showing {rows.length} of {paginatedTotal} moments
            </span>
          </div>
        ) : hasSearched && paginatedTotal > 0 ? (
          <div className="mt-4 text-center text-xs text-[color:var(--rpc-text-muted)]">
            All {paginatedTotal} moments loaded
          </div>
        ) : null}

        {/* Recent Sales */}
        <CollectionRecentSales searchNonce={salesSearchNonce} visible={hasSearched} />
      </div>
      <MomentDetailModal
        moment={view.selectedMoment ? {
          flowId: view.selectedMoment.flowId ?? view.selectedMoment.momentId,
          playerName: view.selectedMoment.playerName,
          setName: view.selectedMoment.setName,
          tier: view.selectedMoment.tier ?? null,
          serialNumber: getSerial(view.selectedMoment) ?? null,
          mintSize: getMint(view.selectedMoment) ?? null,
          fmv: view.selectedMoment.fmv ?? null,
          listingPrice: view.selectedMoment.lowAsk ?? null,
          bestOffer: view.selectedMoment.bestOffer ?? view.selectedMoment.editionBestOffer ?? null,
          marketConfidence: view.selectedMoment.marketConfidence ?? null,
          badgeTitles: view.selectedMoment.badgeInfo?.badge_titles ?? [],
          officialBadges: (view.selectedMoment.officialBadges ?? []).map(function(b) { return BADGE_TYPE_TO_TITLE[b] ?? b }),
          imageUrlPrefix: null,
          buyUrl: null,
          acquisitionMethod: view.selectedMoment.acquisitionMethod ?? null,
          sourceAddress: view.selectedMoment.sourceAddress ?? null,
          loanPrincipal: view.selectedMoment.loanPrincipal ?? null,
          editionKey: view.selectedMoment.editionKey ?? null,
        } : null}
        collectionUrlSlug={collectionSlug}
        onClose={function() { dispatchView({ type: "SELECT_MOMENT", moment: null }) }}
      />
    </div>
  )
}

// ── Collection section (Moments | Packs sub-toggle) ─────────────────────
// After the 2026-07-18 IA reorg the Collection tab carries a Moments|Packs
// sub-toggle for Top Shot + NFL All Day (the collections with pack-ownership
// data). Moments is the existing wallet view (<WalletMomentsBody/>); Packs is
// the wallet's sealed-pack activity scoped to this collection
// (<WalletPacksView/>). Other collections render Moments-only with no sub-nav.
function CollectionSection() {
  const routeParams = useParams()
  const collectionSlug = (routeParams?.collection as string) ?? "nba-top-shot"
  const accent = getCollection(collectionSlug)?.accent ?? "var(--rpc-red)"
  const searchParams = useSearchParams()
  const router = useRouter()
  const section = subSectionFromParams(searchParams)
  const hasPacks = collectionSlug === "nba-top-shot" || collectionSlug === "nfl-all-day"
  const packsActive = hasPacks && section === "packs"

  // Moments sub-state: Owned | Sold (Trevor 2026-07-18). URL-param driven
  // (`?moments=sold`) so it stays deep-linkable, matching the `?section=packs`
  // convention PackSubNav established. Only meaningful on the Moments side.
  const momentsView = searchParams.get("moments") === "sold" ? "sold" : "owned"

  const setMomentsView = (next: "owned" | "sold") => {
    const sp = new URLSearchParams(searchParams.toString())
    if (next === "sold") sp.set("moments", "sold")
    else sp.delete("moments")
    const qs = sp.toString()
    router.replace(qs ? `?${qs}` : "?", { scroll: false })
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {hasPacks && (
        <div style={{ display: "flex" }}>
          <PackSubNav accent={accent} active={packsActive ? "packs" : "moments"} />
        </div>
      )}

      {!packsActive && (
        <div style={{ display: "flex", gap: 6 }}>
          {(["owned", "sold"] as const).map((v) => {
            const on = momentsView === v
            return (
              <button
                key={v}
                type="button"
                onClick={() => setMomentsView(v)}
                aria-pressed={on}
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  padding: "6px 14px",
                  minHeight: 32,
                  borderRadius: 4,
                  cursor: "pointer",
                  background: on ? accent : "transparent",
                  // brand-exception: active state paints white text on the
                  // colored `accent` fill — theme-independent (text on a colored
                  // surface), so #fff is correct in both light and dark.
                  color: on ? "#fff" : "var(--rpc-text-muted)",
                  border: `1px solid ${on ? accent : "var(--rpc-border)"}`,
                }}
              >
                {v === "owned" ? "Owned" : "Sold"}
              </button>
            )
          })}
        </div>
      )}

      {packsActive ? (
        <WalletPacksView collection={collectionSlug} />
      ) : momentsView === "sold" ? (
        <WalletSoldMomentsView collection={collectionSlug} />
      ) : (
        <WalletMomentsBody />
      )}
    </div>
  )
}

export default function CollectionTabClient() {
  return (
    <Suspense
      fallback={
        <div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>
          Loading…
        </div>
      }
    >
      <CollectionSection />
    </Suspense>
  )
}