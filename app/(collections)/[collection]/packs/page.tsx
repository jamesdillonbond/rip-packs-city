"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { LineChart, Line, ResponsiveContainer } from "recharts"
import { getCollection } from "@/lib/collections"
import { getOwnerKey } from "@/lib/owner-key"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"

type EvHistoryPoint = { snapshotted_at: string; gross_ev: number; pack_ev: number; value_ratio: number | null }
type PullStat = { pull_tier: string; pull_count: number; avg_fmv_usd: number | null; pct_of_total: number }

type PackType = "standard" | "topper" | "chance_hit" | "reward" | "bundle"

type EditionEV = {
  editionId: string
  playerName: string
  setName: string
  tier: string
  parallelName: string | null
  probability: number
  averageSalePrice: number
  lowAsk: number
  editionEV: number
  remaining: number
  count: number
  circulationCount: number
  hiddenInPacks: number
  forSaleByCollectors: number
  locked: number
  burned: number
  lockedPct: number
  depletionPct: number
  hasSerialOne: boolean
  hasLastMint: boolean
  hasJerseyMatch: boolean
  serialPremiumLabel: string | null
}

type TierEVSummary = {
  editionCount: number
  totalEV: number
  avgEditionEV: number
  remainingMoments: number
}

type SupplySnapshot = {
  totalUnopened: number
  totalPackCount: number
  depletionPct: number
  remainingByTier: Record<string, number>
  originalByTier: Record<string, number>
  forSale: boolean
  isSoldOut: boolean
}

type PackEVResponse = {
  packListingId: string
  packPrice: number
  packEV: number
  grossEV: number
  isPositiveEV: boolean
  evVerdict: string
  topPulls: EditionEV[]
  serialPremiumAlerts: string[]
  tierBreakdown: Record<string, TierEVSummary>
  supplySnapshot: SupplySnapshot
  editionCount: number
  methodology: string
  fmvCoverageNote?: string | null
  error?: string
}

type PackListing = {
  packListingId: string
  distId: string
  title: string
  tier: string
  imageUrl: string
  momentsPerPack: number
  retailPrice: number
  lowestAsk: number
  startTime: string
  listingCount: number
  packType: PackType
  seriesLabel?: string
}

type PackEVSummary = {
  grossEV: number
  packEV: number
  isPositiveEV: boolean
  valueRatio: number
  loading: boolean
  error: boolean
  fmvCoverageNote?: string | null
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  return "$" + value.toFixed(2)
}

function tierOrder(tier: string): number {
  if (tier === "ultimate") return 0
  if (tier === "legendary") return 1
  if (tier === "rare") return 2
  if (tier === "fandom") return 3
  return 4
}

function tierBadge(tier: string): string {
  if (tier === "ultimate") return "bg-yellow-950 text-yellow-300 border-yellow-800"
  if (tier === "legendary") return "bg-purple-950 text-purple-300 border-purple-800"
  if (tier === "rare") return "bg-blue-950 text-blue-300 border-blue-800"
  if (tier === "fandom") return "bg-pink-950 text-pink-300 border-pink-800"
  return "bg-zinc-900 text-zinc-300 border-zinc-700"
}

function tierText(tier: string): string {
  if (tier === "ultimate") return "text-yellow-300"
  if (tier === "legendary") return "text-purple-300"
  if (tier === "rare") return "text-blue-300"
  if (tier === "fandom") return "text-pink-300"
  return "text-zinc-300"
}

function evColor(isPositive: boolean): string {
  return isPositive ? "text-green-400" : "text-red-400"
}

function packTypeBadge(packType: PackType): { label: string; className: string } {
  switch (packType) {
    case "topper": return { label: "Topper", className: "bg-orange-950 text-orange-300 border-orange-800" }
    case "chance_hit": return { label: "Chance Hit", className: "bg-sky-950 text-sky-300 border-sky-800" }
    case "reward": return { label: "Reward", className: "bg-emerald-950 text-emerald-300 border-emerald-800" }
    case "bundle": return { label: "Bundle", className: "bg-violet-950 text-violet-300 border-violet-800" }
    default: return { label: "Standard", className: "bg-zinc-900 text-zinc-500 border-zinc-700" }
  }
}

function canAnalyzeEV(packType: PackType): boolean {
  return packType !== "bundle"
}

type AllDayDistribution = {
  dist_id: string
  title: string
  nft_type: string
  metadata: {
    tier?: string
    distributionUUID?: string
    description?: string
    thumbnail?: string
    productID?: string
  } | null
}

const ALLDAY_TIER_ORDER = ["ULTIMATE", "LEGENDARY", "RARE", "PREMIUM", "STANDARD", "COMMON"] as const

const ALLDAY_TIER_STYLES: Record<string, { color: string; bg: string; border: string; label: string }> = {
  ULTIMATE: { color: "#fbbf24", bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.45)", label: "Ultimate" },
  LEGENDARY: { color: "#c084fc", bg: "rgba(192,132,252,0.10)", border: "rgba(192,132,252,0.45)", label: "Legendary" },
  RARE: { color: "#818cf8", bg: "rgba(129,140,248,0.10)", border: "rgba(129,140,248,0.45)", label: "Rare" },
  PREMIUM: { color: "#2dd4bf", bg: "rgba(45,212,191,0.10)", border: "rgba(45,212,191,0.45)", label: "Premium" },
  STANDARD: { color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.45)", label: "Standard" },
  COMMON: { color: "#a1a1aa", bg: "rgba(161,161,170,0.10)", border: "rgba(161,161,170,0.40)", label: "Common" },
}

function normalizeAllDayTier(raw: string | undefined | null): string {
  const t = (raw ?? "").toUpperCase().trim()
  if (ALLDAY_TIER_ORDER.includes(t as any)) return t
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGEND")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("PREMIUM")) return "PREMIUM"
  if (t.includes("STANDARD")) return "STANDARD"
  if (t.includes("COMMON")) return "COMMON"
  return "COMMON"
}

type SortKey = "tier" | "lowestAsk" | "retailPrice" | "momentsPerPack" | "title" | "owned" | "grossEV" | "valueRatio"
type PackTypeFilter = "all" | PackType

export default function PacksPage() {
  const params = useParams()
  const collection = (params?.collection as string) ?? "nba-top-shot"
  const base = "/" + collection
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "#E03A2F"
  const isAllDay = collection === "nfl-all-day"
  const packListingsEndpoint = isAllDay ? "/api/allday-pack-listings" : "/api/pack-listings"
  const packEvEndpoint = isAllDay ? "/api/allday-pack-ev" : "/api/pack-ev"

  const [listings, setListings] = useState<PackListing[]>([])
  const [listingsLoading, setListingsLoading] = useState(true)
  const [listingsError, setListingsError] = useState("")
  const [tierFilter, setTierFilter] = useState("all")
  const [packTypeFilter, setPackTypeFilter] = useState<PackTypeFilter>("all")
  const [searchFilter, setSearchFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("valueRatio")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const [evCache, setEvCache] = useState<Record<string, PackEVSummary>>({})
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmActiveRef = useRef(false)
  const packMapRef = useRef<Map<string, PackListing>>(new Map())

  const [walletInput, setWalletInput] = useState("")
  const [walletQuery, setWalletQuery] = useState("")
  const autoWalletFired = useRef(false)
  const [ownedPacks, setOwnedPacks] = useState<Record<string, number>>({})
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState("")
  const [walletAddress, setWalletAddress] = useState("")

  const [selectedPack, setSelectedPack] = useState<PackListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<PackEVResponse | null>(null)
  const [showAllPulls, setShowAllPulls] = useState(false)
  const [showAllAlerts, setShowAllAlerts] = useState(false)

  const [ttMode, setTtMode] = useState(false)
  const [ttCount, setTtCount] = useState("")
  const [ttFloor, setTtFloor] = useState("")

  const [bundleArbitrage, setBundleArbitrage] = useState<Record<string, { sumOfParts: number; premium: number } | null>>({})
  const [evDetailCache, setEvDetailCache] = useState<Record<string, PackEVResponse>>({})
  const [modalPack, setModalPack] = useState<PackListing | null>(null)
  const [modalResult, setModalResult] = useState<PackEVResponse | null>(null)
  const [modalLoading, setModalLoading] = useState(false)
  const [historicalPulls, setHistoricalPulls] = useState<{ total: number; tierBreakdown: Record<string, number> } | null>(null)
  const [evHistoryCache, setEvHistoryCache] = useState<Record<string, EvHistoryPoint[]>>({})
  const [pullStats, setPullStats] = useState<PullStat[] | null>(null)
  const [showPullsSection, setShowPullsSection] = useState(false)
  const [pullForm, setPullForm] = useState({ tier: "COMMON", playerName: "", serial: "", price: "" })
  const [pullSubmitting, setPullSubmitting] = useState(false)
  const [pullSubmitSuccess, setPullSubmitSuccess] = useState(false)
  const [pullSubmitError, setPullSubmitError] = useState("")
  const [alldayDists, setAlldayDists] = useState<AllDayDistribution[]>([])
  const [alldayDistsLoading, setAlldayDistsLoading] = useState(true)
  const [alldayDistsError, setAlldayDistsError] = useState("")
  const [alldayTierFilter, setAlldayTierFilter] = useState<string>("all")
  const [calcAllProgress, setCalcAllProgress] = useState<{ done: number; total: number } | null>(null)
  const calcAllAbortRef = useRef(false)

  const ttCost = ttMode && ttCount && ttFloor ? parseFloat(ttCount) * parseFloat(ttFloor) : null
  const ttPackEV = result !== null && ttCost !== null ? Math.round((result.grossEV - ttCost) * 100) / 100 : null
  const ttIsPositive = ttPackEV !== null && ttPackEV > 0

  const fetchEVForPack = useCallback(async (pack: PackListing) => {
    if (!canAnalyzeEV(pack.packType)) return
    const id = pack.packListingId
    setEvCache((prev) => ({ ...prev, [id]: { grossEV: 0, packEV: 0, isPositiveEV: false, valueRatio: 0, loading: true, error: false } }))
    try {
      const res = await fetch(packEvEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packListingId: id, packPrice: pack.lowestAsk, packName: pack.title, distId: pack.distId }),
      })
      const json: PackEVResponse = await res.json()
      if (!res.ok || json.error) throw new Error(json.error ?? "failed")
      const valueRatio = pack.lowestAsk > 0 ? Math.round((json.grossEV / pack.lowestAsk) * 100) / 100 : 0
      setEvCache((prev) => ({
        ...prev,
        [id]: { grossEV: json.grossEV, packEV: json.packEV, isPositiveEV: json.isPositiveEV, valueRatio, loading: false, error: false, fmvCoverageNote: json.fmvCoverageNote ?? null },
      }))
      // Fire-and-forget history fetch
      fetch("/api/pack-ev-history?packListingId=" + encodeURIComponent(id))
        .then((r) => r.ok ? r.json() : null)
        .then((h) => {
          if (h && Array.isArray(h.history)) {
            setEvHistoryCache((prev) => ({ ...prev, [id]: h.history }))
          }
        })
        .catch(() => {})
    } catch {
      setEvCache((prev) => ({ ...prev, [id]: { grossEV: 0, packEV: 0, isPositiveEV: false, valueRatio: 0, loading: false, error: true } }))
    }
  }, [])

  const drainPrewarmQueue = useCallback(async () => {
    if (prewarmActiveRef.current) return
    prewarmActiveRef.current = true
    while (prewarmQueueRef.current.length > 0) {
      const id = prewarmQueueRef.current.shift()!
      const pack = packMapRef.current.get(id)
      if (pack && canAnalyzeEV(pack.packType)) await fetchEVForPack(pack)
      await new Promise((r) => setTimeout(r, 2000))
    }
    prewarmActiveRef.current = false
  }, [fetchEVForPack])

  const computeBundleArbitrage = useCallback((bundles: PackListing[], allListings: PackListing[]) => {
    for (const bundle of bundles) {
      const slots = bundle.momentsPerPack
      let stdPackSlots = 5
      let topperCount = 2
      if (slots >= 13) { stdPackSlots = 10; topperCount = 3 }
      else if (slots >= 7) { stdPackSlots = 5; topperCount = 2 }
      else if (slots >= 4) { stdPackSlots = 3; topperCount = 1 }

      const sameTierStdPacks = allListings.filter(
        l => l.packType === "standard" && l.tier === bundle.tier && l.lowestAsk > 0
      ).sort((a, b) => a.lowestAsk - b.lowestAsk)

      const toppers = allListings.filter(
        l => l.packType === "topper" && l.lowestAsk > 0
      ).sort((a, b) => a.lowestAsk - b.lowestAsk)

      if (sameTierStdPacks.length === 0 || toppers.length === 0) {
        setBundleArbitrage(prev => ({ ...prev, [bundle.distId]: null }))
        continue
      }

      const cheapestStd = sameTierStdPacks[0].lowestAsk
      const cheapestTopper = toppers[0].lowestAsk
      const stdPackCount = Math.max(1, Math.floor(stdPackSlots / (sameTierStdPacks[0].momentsPerPack || 5)))
      const sumOfParts = (stdPackCount * cheapestStd) + (topperCount * cheapestTopper)
      const premium = bundle.lowestAsk - sumOfParts

      setBundleArbitrage(prev => ({ ...prev, [bundle.distId]: { sumOfParts, premium } }))
    }
  }, [])

  useEffect(() => {
    if (!isAllDay) return
    let cancelled = false
    async function fetchAllDay() {
      try {
        setAlldayDistsLoading(true)
        const res = await fetch("/api/allday-packs")
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || "Failed to load All Day packs")
        if (cancelled) return
        setAlldayDists(json.distributions ?? [])
      } catch (err) {
        if (!cancelled) setAlldayDistsError(err instanceof Error ? err.message : "Failed to load All Day packs")
      } finally {
        if (!cancelled) setAlldayDistsLoading(false)
      }
    }
    fetchAllDay()
    return () => { cancelled = true }
  }, [isAllDay])

  useEffect(() => {
    if (isAllDay) { setListingsLoading(false); return }
    async function fetchListings() {
      try {
        const res = await fetch(packListingsEndpoint)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || "Failed to load pack listings")
        const data: PackListing[] = json.listings ?? []
        setListings(data)
        packMapRef.current = new Map(data.map((p) => [p.packListingId, p]))
        const top20 = data.filter(p => canAnalyzeEV(p.packType)).slice(0, 20)
        prewarmQueueRef.current = top20.map((p) => p.packListingId)
        drainPrewarmQueue()
        const bundles = data.filter(p => p.packType === "bundle")
        computeBundleArbitrage(bundles, data)
      } catch (err) {
        setListingsError(err instanceof Error ? err.message : "Failed to load listings")
      } finally {
        setListingsLoading(false)
      }
    }
    fetchListings()
  }, [drainPrewarmQueue, computeBundleArbitrage])

  const listingsByDistId = listings.reduce<Record<string, PackListing>>((acc, l) => {
    acc[l.distId] = l
    return acc
  }, {})

  const myOwnedPackCards = Object.keys(ownedPacks)
    .map((distId) => ({ distId, listing: listingsByDistId[distId], count: ownedPacks[distId] ?? 1 }))
    .sort((a, b) => {
      const tierDiff = tierOrder(a.listing?.tier ?? "common") - tierOrder(b.listing?.tier ?? "common")
      if (tierDiff !== 0) return tierDiff
      return (a.listing?.lowestAsk || 99999) - (b.listing?.lowestAsk || 99999)
    })

  async function handleWalletSearch() {
    const q = walletInput.trim()
    if (!q) return
    setWalletQuery(q)
    setWalletLoading(true)
    setWalletError("")
    setOwnedPacks({})
    setWalletAddress("")
    try {
      const res = await fetch("/api/wallet-packs?wallet=" + encodeURIComponent(q))
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to load wallet packs")
      setOwnedPacks(json.owned ?? {})
      setWalletAddress(json.walletAddress ?? "")
      setSortKey("owned")
      setSortDir("desc")
      if (json.totalSealedPacks === 0) setWalletError("No sealed packs found for this wallet.")
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setWalletLoading(false)
    }
  }

  // Auto-load wallet: prefer localStorage owner key; otherwise fall back to
  // the signed-in user's saved wallet for this collection. Fires exactly once
  // on mount via autoWalletFired.
  useEffect(() => {
    if (autoWalletFired.current) return
    let cancelled = false

    async function autoLoad(source: string) {
      autoWalletFired.current = true
      setWalletInput(source)
      setWalletQuery(source)
      setWalletLoading(true)
      setWalletError("")
      setOwnedPacks({})
      setWalletAddress("")
      try {
        const res = await fetch("/api/wallet-packs?wallet=" + encodeURIComponent(source))
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || "Failed")
        setOwnedPacks(json.owned ?? {})
        setWalletAddress(json.walletAddress ?? "")
        setSortKey("owned")
        setSortDir("desc")
        if (json.totalSealedPacks === 0) setWalletError("No sealed packs found for this wallet.")
      } catch (err) {
        if (!cancelled) setWalletError(err instanceof Error ? err.message : "Something went wrong")
      } finally {
        if (!cancelled) setWalletLoading(false)
      }
    }

    const key = getOwnerKey()
    if (key && !walletInput) {
      autoLoad(key)
      return () => { cancelled = true }
    }

    if (!walletInput) {
      fetchSavedWalletForCollection(collection).then((addr) => {
        if (cancelled || !addr || walletInput) return
        autoLoad(addr)
      })
    }

    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => d === "asc" ? "desc" : "asc")
    } else {
      setSortKey(key)
      setSortDir(key === "owned" || key === "grossEV" || key === "valueRatio" ? "desc" : "asc")
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return " ↕"
    return sortDir === "asc" ? " ↑" : " ↓"
  }

  const hasWalletData = Object.keys(ownedPacks).length > 0

  const filteredListings = listings
    .filter((l) => {
      if (tierFilter !== "all" && l.tier !== tierFilter) return false
      if (packTypeFilter !== "all" && l.packType !== packTypeFilter) return false
      if (searchFilter && !(l.title ?? "").toLowerCase().includes(searchFilter.toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      let diff = 0
      const evA = evCache[a.packListingId]
      const evB = evCache[b.packListingId]
      if (sortKey === "tier") {
        diff = tierOrder(a.tier) - tierOrder(b.tier)
        if (diff === 0) diff = (a.lowestAsk || 99999) - (b.lowestAsk || 99999)
      } else if (sortKey === "lowestAsk") {
        diff = (a.lowestAsk || 99999) - (b.lowestAsk || 99999)
      } else if (sortKey === "retailPrice") {
        diff = (a.retailPrice || 0) - (b.retailPrice || 0)
      } else if (sortKey === "momentsPerPack") {
        diff = a.momentsPerPack - b.momentsPerPack
      } else if (sortKey === "title") {
        diff = (a.title ?? "").localeCompare(b.title ?? "")
      } else if (sortKey === "owned") {
        diff = (ownedPacks[b.distId] ?? 0) - (ownedPacks[a.distId] ?? 0)
        if (diff === 0) diff = tierOrder(a.tier) - tierOrder(b.tier)
      } else if (sortKey === "grossEV") {
        const gA = evA && !evA.loading && !evA.error ? evA.grossEV : -Infinity
        const gB = evB && !evB.loading && !evB.error ? evB.grossEV : -Infinity
        diff = gA - gB
      } else if (sortKey === "valueRatio") {
        const rA = evA && !evA.loading && !evA.error ? evA.valueRatio : -Infinity
        const rB = evB && !evB.loading && !evB.error ? evB.valueRatio : -Infinity
        diff = rA - rB
      }
      return sortDir === "asc" ? diff : -diff
    })

  async function handleAnalyze(pack: PackListing) {
    if (!canAnalyzeEV(pack.packType)) return
    setSelectedPack(pack)
    setLoading(true)
    setError("")
    setResult(null)
    setShowAllPulls(false)
    setShowAllAlerts(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
    try {
      const response = await fetch(packEvEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packListingId: pack.packListingId,
          packPrice: !ttMode ? pack.lowestAsk : 0,
          packName: pack.title,
        }),
      })
      const json: PackEVResponse = await response.json()
      if (!response.ok) throw new Error(json.error || "Pack EV analysis failed")
      setResult(json)
      setEvDetailCache((prev) => ({ ...prev, [pack.packListingId]: json }))
      const valueRatio = pack.lowestAsk > 0 ? Math.round((json.grossEV / pack.lowestAsk) * 100) / 100 : 0
      setEvCache((prev) => ({
        ...prev,
        [pack.packListingId]: { grossEV: json.grossEV, packEV: json.packEV, isPositiveEV: json.isPositiveEV, valueRatio, loading: false, error: false, fmvCoverageNote: json.fmvCoverageNote ?? null },
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  async function submitPull() {
    if (!modalPack) return
    setPullSubmitting(true)
    setPullSubmitError("")
    try {
      const res = await fetch("/api/pack-pulls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packListingId: modalPack.packListingId,
          tier: pullForm.tier,
          playerName: pullForm.playerName || undefined,
          serialNumber: pullForm.serial || undefined,
          packPricePaid: pullForm.price || undefined,
          collection,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? "Submit failed")
      setPullSubmitSuccess(true)
      setPullForm({ tier: "COMMON", playerName: "", serial: "", price: "" })
      setTimeout(() => setPullSubmitSuccess(false), 3000)
      // Re-fetch stats
      fetch("/api/pack-pulls?packListingId=" + encodeURIComponent(modalPack.packListingId))
        .then((r) => r.ok ? r.json() : null)
        .then((s) => { if (s && Array.isArray(s.stats)) setPullStats(s.stats) })
        .catch(() => {})
    } catch (err) {
      setPullSubmitError(err instanceof Error ? err.message : "Submit failed")
    } finally {
      setPullSubmitting(false)
    }
  }

  async function openEvModal(pack: PackListing) {
    if (!canAnalyzeEV(pack.packType)) return
    setModalPack(pack)
    setHistoricalPulls(null)
    setPullStats(null)
    setShowPullsSection(false)
    setPullSubmitSuccess(false)
    setPullSubmitError("")
    // Fetch pull stats for this pack
    fetch("/api/pack-pulls?packListingId=" + encodeURIComponent(pack.packListingId))
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s && Array.isArray(s.stats)) setPullStats(s.stats) })
      .catch(() => {})
    // Fetch EV history if not cached
    if (!evHistoryCache[pack.packListingId]) {
      fetch("/api/pack-ev-history?packListingId=" + encodeURIComponent(pack.packListingId))
        .then((r) => r.ok ? r.json() : null)
        .then((h) => {
          if (h && Array.isArray(h.history)) {
            setEvHistoryCache((prev) => ({ ...prev, [pack.packListingId]: h.history }))
          }
        })
        .catch(() => {})
    }
    // Fire historical pulls fetch in parallel
    fetch("/api/pack-listings/historical-pulls?title=" + encodeURIComponent(pack.title))
      .then((r) => r.ok ? r.json() : null)
      .then((h) => { if (h && typeof h.total === "number") setHistoricalPulls(h) })
      .catch(() => {})
    const cached = evDetailCache[pack.packListingId]
    if (cached) {
      setModalResult(cached)
      setModalLoading(false)
      return
    }
    setModalResult(null)
    setModalLoading(true)
    try {
      const res = await fetch(packEvEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packListingId: pack.packListingId, packPrice: pack.lowestAsk, packName: pack.title, distId: pack.distId }),
      })
      const json: PackEVResponse = await res.json()
      if (!res.ok || json.error) throw new Error(json.error ?? "failed")
      setModalResult(json)
      setEvDetailCache((prev) => ({ ...prev, [pack.packListingId]: json }))
      const valueRatio = pack.lowestAsk > 0 ? Math.round((json.grossEV / pack.lowestAsk) * 100) / 100 : 0
      setEvCache((prev) => ({
        ...prev,
        [pack.packListingId]: { grossEV: json.grossEV, packEV: json.packEV, isPositiveEV: json.isPositiveEV, valueRatio, loading: false, error: false, fmvCoverageNote: json.fmvCoverageNote ?? null },
      }))
    } catch {
      setModalResult(null)
    } finally {
      setModalLoading(false)
    }
  }

  async function calculateAllEV() {
    const needsCalc = filteredListings.filter(function(p) {
      if (!canAnalyzeEV(p.packType)) return false
      const cached = evCache[p.packListingId]
      return !cached || (cached.error && !cached.loading)
    })
    if (!needsCalc.length) return
    calcAllAbortRef.current = false
    setCalcAllProgress({ done: 0, total: needsCalc.length })
    const BATCH = 5
    let done = 0
    for (let i = 0; i < needsCalc.length; i += BATCH) {
      if (calcAllAbortRef.current) break
      const batch = needsCalc.slice(i, i + BATCH)
      await Promise.all(batch.map(function(pack) { return fetchEVForPack(pack) }))
      done += batch.length
      setCalcAllProgress({ done: Math.min(done, needsCalc.length), total: needsCalc.length })
      if (i + BATCH < needsCalc.length) await new Promise(function(r) { setTimeout(r, 500) })
    }
    setCalcAllProgress(null)
  }

  function buildVerdict(): string {
    if (ttMode) {
      if (ttPackEV === null) return "Enter TT count and floor price to get verdict"
      const abs = Math.abs(ttPackEV).toFixed(2)
      if (ttIsPositive) return "+EV by $" + abs + " — burning TTs beats buying direct"
      return "-EV by $" + abs + " — cheaper to buy moments directly"
    }
    if (!result) return ""
    if (result.packPrice === 0) return "No price available"
    const abs = Math.abs(result.packEV).toFixed(2)
    if (result.isPositiveEV) return "+EV by $" + abs + " — opening beats buying direct"
    return "-EV by $" + abs + " — cheaper to buy moments directly"
  }

  function displayPackEV(): number | null {
    if (ttMode && ttPackEV !== null) return ttPackEV
    if (result !== null) return result.packEV
    return null
  }

  function displayIsPositive(): boolean {
    if (ttMode && ttPackEV !== null) return ttIsPositive
    if (result !== null) return result.isPositiveEV
    return false
  }

  const displayedPulls = result ? (showAllPulls ? result.topPulls : result.topPulls.slice(0, 5)) : []
  const displayedAlerts = result ? (showAllAlerts ? result.serialPremiumAlerts : result.serialPremiumAlerts.slice(0, 8)) : []

  function renderEVCell(pack: PackListing) {
    if (pack.packType === "bundle") return <span className="text-[10px] text-violet-400 font-semibold">Bundle</span>
    if (pack.packType === "reward") return <span className="text-[10px] text-emerald-500">Reward</span>
    const ev = evCache[pack.packListingId]
    if (!ev) return <span className="text-zinc-700 text-xs">—</span>
    if (ev.loading) return <span className="text-zinc-600 text-xs animate-pulse">...</span>
    if (ev.error) return <span className="text-zinc-600 text-xs">—</span>
    return (
      <span className="inline-flex items-center gap-1">
        <span className={"text-xs font-semibold " + (ev.isPositiveEV ? "text-green-400" : "text-red-400")}>{fmt(ev.grossEV)}</span>
        {ev.fmvCoverageNote && <span className="text-amber-500 text-xs cursor-help" title={ev.fmvCoverageNote}>⚠</span>}
      </span>
    )
  }

  function renderRatioCell(pack: PackListing) {
    if (pack.packType === "bundle") {
      const arb = bundleArbitrage[pack.distId]
      if (arb === undefined || arb === null) return <span className="text-zinc-700 text-xs">—</span>
      return (
        <span className={"text-[10px] font-semibold " + (arb.premium > 0 ? "text-red-400" : "text-green-400")}>
          {arb.premium > 0 ? "+" : ""}{fmt(arb.premium)}
        </span>
      )
    }
    if (pack.packType === "reward") return <span className="text-zinc-600 text-xs">—</span>
    const ev = evCache[pack.packListingId]
    if (!ev) return <span className="text-zinc-700 text-xs">—</span>
    if (ev.loading) return <span className="text-zinc-600 text-xs animate-pulse">...</span>
    if (ev.error) return <span className="text-zinc-600 text-xs">—</span>
    const ratio = ev.valueRatio
    const color = ratio >= 1.2 ? "text-green-400" : ratio >= 1.0 ? "text-yellow-400" : "text-red-400"
    return <span className={"text-xs font-semibold " + color}>{ratio.toFixed(2) + "x"}</span>
  }

  function renderEvSparkline(packListingId: string, currentIsPositive: boolean) {
    const history = evHistoryCache[packListingId]
    if (!history || history.length < 3) return null
    const data = [...history].reverse().map((h, i) => ({ i, gross: Number(h.gross_ev ?? 0) }))
    const stroke = currentIsPositive ? "#34d399" : "#f87171"
    const daysSpan = history.length > 0
      ? (new Date(history[0].snapshotted_at).getTime() - new Date(history[history.length - 1].snapshotted_at).getTime()) / (1000 * 60 * 60 * 24)
      : 0
    const label = daysSpan >= 7 ? "EV 7d trend" : "EV recent"
    return (
      <div className="mt-2">
        <div style={{ width: 100, height: 40 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <Line type="monotone" dataKey="gross" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-[9px] text-zinc-500 mt-0.5">{label}</div>
      </div>
    )
  }

  const packTypeFilters: { key: PackTypeFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "standard", label: "Standard" },
    { key: "topper", label: "Toppers" },
    { key: "chance_hit", label: "Chance Hit" },
    { key: "reward", label: "Rewards" },
    { key: "bundle", label: "Bundles" },
  ]

  // ── All Day packs view — full distribution catalog from pack_distributions ──
  if (isAllDay) {
    const grouped: Record<string, AllDayDistribution[]> = {}
    for (const t of ALLDAY_TIER_ORDER) grouped[t] = []
    for (const d of alldayDists) {
      const tier = normalizeAllDayTier(d.metadata?.tier)
      if (!grouped[tier]) grouped[tier] = []
      grouped[tier].push(d)
    }
    const total = alldayDists.length
    const activeTiers = ALLDAY_TIER_ORDER.filter((t) => grouped[t] && grouped[t].length > 0)
    const visibleTiers = alldayTierFilter === "all" ? activeTiers : activeTiers.filter((t) => t === alldayTierFilter)

    return (
      <div className="min-h-screen bg-black text-zinc-100">
        <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">
          <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white mb-1">NFL All Day — Pack Distributions</div>
                <div className="text-xs text-zinc-400 leading-relaxed">
                  Full catalog of on-chain pack distributions, grouped by tier. Marketplace buying
                  happens at <span className="font-mono text-zinc-300">nflallday.com/marketplace</span>.
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Distributions</div>
                <div className="text-2xl font-black text-white">{total.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Tier</span>
            <button
              onClick={() => setAlldayTierFilter("all")}
              className={"rounded-full px-3 py-1 text-xs font-semibold transition " + (alldayTierFilter === "all" ? "text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}
              style={alldayTierFilter === "all" ? { backgroundColor: accent } : undefined}
            >
              All · {total}
            </button>
            {activeTiers.map((t) => {
              const style = ALLDAY_TIER_STYLES[t]
              const active = alldayTierFilter === t
              return (
                <button
                  key={t}
                  onClick={() => setAlldayTierFilter(t)}
                  className="rounded-full px-3 py-1 text-xs font-semibold transition border"
                  style={
                    active
                      ? { backgroundColor: style.color, color: "#0a0a0a", borderColor: style.color }
                      : { backgroundColor: style.bg, color: style.color, borderColor: style.border }
                  }
                >
                  {style.label} · {grouped[t].length}
                </button>
              )
            })}
          </div>

          {alldayDistsLoading && (
            <div className="space-y-6">
              {[0, 1].map((s) => (
                <div key={s}>
                  <div className="mb-3 h-5 w-40 rounded bg-zinc-900 animate-pulse" />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                        <div className="aspect-square bg-zinc-900 animate-pulse" />
                        <div className="p-3 space-y-2">
                          <div className="h-4 w-3/4 rounded bg-zinc-900 animate-pulse" />
                          <div className="h-3 w-full rounded bg-zinc-900 animate-pulse" />
                          <div className="h-3 w-1/2 rounded bg-zinc-900 animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {alldayDistsError && (
            <div className="rounded-xl border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">{alldayDistsError}</div>
          )}

          {!alldayDistsLoading && !alldayDistsError && total === 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-10 text-center">
              <div className="text-3xl mb-2 opacity-40">🏈</div>
              <div className="text-sm font-semibold text-zinc-300 mb-1">No distributions cached</div>
              <div className="text-xs text-zinc-500">Run the pack distribution ingest to populate <span className="font-mono text-zinc-400">pack_distributions</span>.</div>
            </div>
          )}

          {!alldayDistsLoading && !alldayDistsError && total > 0 && (
            <div className="space-y-8">
              {visibleTiers.map((tier) => {
                const dists = grouped[tier]
                const style = ALLDAY_TIER_STYLES[tier]
                return (
                  <section key={tier}>
                    <div className="mb-3 flex items-baseline gap-3">
                      <h2 className="text-lg font-black tracking-tight" style={{ color: style.color }}>
                        {style.label}
                      </h2>
                      <span
                        className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                        style={{ backgroundColor: style.bg, color: style.color, borderColor: style.border }}
                      >
                        {dists.length} {dists.length === 1 ? "distribution" : "distributions"}
                      </span>
                    </div>
                    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {dists.map((d) => {
                        const thumb = d.metadata?.thumbnail
                        const desc = d.metadata?.description ?? ""
                        return (
                          <div
                            key={d.dist_id}
                            className="group rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden flex flex-col transition hover:border-zinc-700"
                          >
                            <div className="aspect-square overflow-hidden bg-zinc-900 relative">
                              {thumb ? (
                                <img
                                  src={thumb}
                                  alt={d.title}
                                  loading="lazy"
                                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                />
                              ) : (
                                <div className="h-full w-full flex items-center justify-center text-zinc-700 text-4xl">🏈</div>
                              )}
                              <span
                                className="absolute top-2 left-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur"
                                style={{ backgroundColor: style.bg, color: style.color, borderColor: style.border }}
                              >
                                {style.label}
                              </span>
                            </div>
                            <div className="p-3 space-y-1.5 flex-1 flex flex-col">
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-sm font-bold text-white leading-snug line-clamp-2" title={d.title}>
                                  {d.title}
                                </div>
                                <a
                                  href="https://nflallday.com/marketplace"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="shrink-0 text-zinc-500 hover:text-zinc-200 transition"
                                  title="Open NFL All Day marketplace"
                                  aria-label="Open marketplace"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                  </svg>
                                </a>
                              </div>
                              {desc && (
                                <div
                                  className="text-[11px] text-zinc-400 leading-relaxed line-clamp-2 group-hover:line-clamp-none transition-all"
                                  title={desc}
                                >
                                  {desc}
                                </div>
                              )}
                              <div className="mt-auto pt-1 text-[9px] uppercase tracking-wide text-zinc-600 font-mono">
                                #{d.dist_id}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">

        {(loading || result !== null || error) && selectedPack !== null && (
          <div className="mb-6">
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3">
              {selectedPack.imageUrl && <img src={selectedPack.imageUrl} alt={selectedPack.title} className="h-10 w-10 rounded object-cover" />}
              <div>
                <div className="font-bold text-white">{selectedPack.title}</div>
                <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                  <span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize " + tierBadge(selectedPack.tier)}>{selectedPack.tier}</span>
                  <span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold " + packTypeBadge(selectedPack.packType).className}>{packTypeBadge(selectedPack.packType).label}</span>
                  <span>{selectedPack.momentsPerPack} moments · Lowest Ask {fmt(selectedPack.lowestAsk)}</span>
                  {hasWalletData && (ownedPacks[selectedPack.distId] ?? 0) > 0 && (
                    <span className="rounded bg-green-950 px-2 py-0.5 text-[10px] font-semibold text-green-400">{"You own " + (ownedPacks[selectedPack.distId] ?? 0)}</span>
                  )}
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button onClick={() => setTtMode(false)} className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (!ttMode ? "text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")} style={!ttMode ? { backgroundColor: accent } : undefined}>Cash Price</button>
                <button onClick={() => setTtMode(true)} className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (ttMode ? "text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")} style={ttMode ? { backgroundColor: accent } : undefined}>Trade Tickets</button>
                {ttMode && (
                  <>
                    <input value={ttCount} onChange={(e) => setTtCount(e.target.value)} placeholder="# TTs" type="number" min="1" className="w-20 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-white outline-none" />
                    <input value={ttFloor} onChange={(e) => setTtFloor(e.target.value)} placeholder="Floor $" type="number" min="0" step="any" className="w-24 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-white outline-none" />
                  </>
                )}
                <button onClick={() => { setResult(null); setSelectedPack(null); setError("") }} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-900">Close</button>
              </div>
            </div>

            {loading && <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950 p-8 text-center text-zinc-500 text-sm">Analyzing pack contents... this takes ~30 seconds on first load.</div>}
            {error && <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300 text-sm">{error}</div>}

            {result !== null && (
              <div>
                <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">{ttMode ? "TT Pack EV" : "Pack EV"}</div>
                    <div className={"text-2xl font-black " + evColor(displayIsPositive())}>{fmt(displayPackEV())}</div>
                    <div className={"mt-1 text-xs " + evColor(displayIsPositive())}>{buildVerdict()}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">Gross EV</div>
                    <div className="text-2xl font-black text-white">{fmt(result.grossEV)}</div>
                    <div className="mt-1 text-xs text-zinc-500">Before subtracting pack cost</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">{ttMode ? "TT Cost" : "Pack Price"}</div>
                    <div className="text-2xl font-black text-white">{ttMode ? (ttCost !== null ? fmt(ttCost) : "—") : fmt(result.packPrice)}</div>
                    <div className="mt-1 text-xs text-zinc-500">{ttMode && ttCost !== null ? ttCount + " TTs x " + fmt(parseFloat(ttFloor)) : result.editionCount + " editions analyzed"}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">Value Ratio</div>
                    <div className={"text-2xl font-black " + (result.grossEV / (result.packPrice || 1) >= 1 ? "text-green-400" : "text-red-400")}>
                      {result.packPrice > 0 ? (result.grossEV / result.packPrice).toFixed(2) + "x" : "—"}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">EV per $ spent · {result.supplySnapshot.depletionPct}% depleted</div>
                  </div>
                </div>

                {ttMode && ttCost !== null && (
                  <div className="mb-5 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Trade Ticket Breakdown</div>
                    <div className="grid gap-3 sm:grid-cols-3 text-sm">
                      <div><div className="text-zinc-500 text-xs">TTs Required</div><div className="text-white font-bold text-lg">{ttCount}</div></div>
                      <div><div className="text-zinc-500 text-xs">Floor Price per TT</div><div className="text-white font-bold text-lg">{fmt(parseFloat(ttFloor))}</div><div className="text-zinc-500 text-xs mt-0.5">Cheapest burnable across all markets</div></div>
                      <div>
                        <div className="text-zinc-500 text-xs">Total Opportunity Cost</div>
                        <div className="text-white font-bold text-lg">{fmt(ttCost)}</div>
                        <div className={"text-xs mt-0.5 " + evColor(ttIsPositive)}>{ttPackEV !== null ? (ttIsPositive ? "You gain " : "You lose ") + fmt(Math.abs(ttPackEV)) + " vs buying direct" : ""}</div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mb-5 grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">EV by Tier</div>
                    <div className="space-y-2">
                      {Object.entries(result.tierBreakdown).sort((a, b) => b[1].totalEV - a[1].totalEV).map(([tier, data]) => (
                        <div key={tier} className="flex items-center gap-3">
                          <span className={"w-20 rounded border px-2 py-0.5 text-center text-[11px] font-semibold capitalize " + tierBadge(tier)}>{tier}</span>
                          <div className="flex-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-zinc-400">{data.editionCount} editions · {data.remainingMoments.toLocaleString()} remaining</span>
                              <span className={"font-semibold " + tierText(tier)}>{fmt(data.totalEV)}</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                              <div className="h-full rounded-full" style={{ width: (result.grossEV > 0 ? Math.min(100, (data.totalEV / result.grossEV) * 100) : 0) + "%", backgroundColor: accent }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 border-t border-zinc-800 pt-3 text-[10px] text-zinc-500">{result.methodology}</div>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Supply Snapshot</div>
                    <div className="space-y-2">
                      {Object.entries(result.supplySnapshot.remainingByTier).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([tier, remaining]) => {
                        const original = result.supplySnapshot.originalByTier[tier] ?? 0
                        const pct = original > 0 ? Math.round((remaining / original) * 100) : 0
                        return (
                          <div key={tier} className="flex items-center gap-3">
                            <span className={"w-20 rounded border px-2 py-0.5 text-center text-[11px] font-semibold capitalize " + tierBadge(tier)}>{tier}</span>
                            <div className="flex-1">
                              <div className="flex justify-between text-xs">
                                <span className="text-zinc-400">{remaining.toLocaleString()} of {original.toLocaleString()}</span>
                                <span className="text-zinc-300">{pct}% left</span>
                              </div>
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                                <div className="h-full rounded-full bg-zinc-600" style={{ width: pct + "%" }} />
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-3 flex gap-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                      <span>Status: <span className={result.supplySnapshot.forSale ? "text-green-400" : "text-red-400"}>{result.supplySnapshot.forSale ? "For Sale" : "Not For Sale"}</span></span>
                      <span>Sold Out: <span className={result.supplySnapshot.isSoldOut ? "text-red-400" : "text-green-400"}>{result.supplySnapshot.isSoldOut ? "Yes" : "No"}</span></span>
                    </div>
                  </div>
                </div>

                <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950">
                  <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Top Pulls by EV</div>
                    <div className="text-xs text-zinc-500">{result.topPulls.length} editions</div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[700px] border-collapse text-sm">
                      <thead className="bg-zinc-900">
                        <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                          <th className="p-3">Player</th><th className="p-3">Set</th><th className="p-3">Tier</th>
                          <th className="p-3">Pull Chance</th><th className="p-3">Avg Sale</th><th className="p-3">Low Ask</th>
                          <th className="p-3">Edition EV</th><th className="p-3">Remaining</th><th className="p-3">Locked %</th><th className="p-3">Flags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedPulls.map((edition) => (
                          <tr key={edition.editionId} className="border-b border-zinc-800 hover:bg-zinc-900/50">
                            <td className="p-3 font-medium text-white">{edition.playerName}</td>
                            <td className="p-3 text-zinc-400">{edition.setName}{edition.parallelName ? " · " + edition.parallelName : ""}</td>
                            <td className="p-3"><span className={"rounded border px-2 py-0.5 text-[11px] font-semibold capitalize " + tierBadge(edition.tier)}>{edition.tier}</span></td>
                            <td className="p-3 text-zinc-300">{edition.probability}%</td>
                            <td className="p-3 text-zinc-300">{fmt(edition.averageSalePrice)}</td>
                            <td className="p-3 text-zinc-400">{edition.lowAsk > 0 ? fmt(edition.lowAsk) : "—"}</td>
                            <td className="p-3 font-semibold text-white">{fmt(edition.editionEV)}</td>
                            <td className="p-3 text-zinc-400">{edition.remaining} / {edition.count}</td>
                            <td className="p-3 text-zinc-400">{edition.lockedPct}%</td>
                            <td className="p-3">{edition.serialPremiumLabel && <span className="rounded bg-red-950 px-2 py-0.5 text-[10px] font-semibold text-red-300">{edition.serialPremiumLabel}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {result.topPulls.length > 5 && (
                    <div className="border-t border-zinc-800 px-4 py-3">
                      <button onClick={() => setShowAllPulls((p) => !p)} className="text-xs text-zinc-400 hover:text-white">{showAllPulls ? "Show fewer" : "Show all " + result.topPulls.length + " pulls"}</button>
                    </div>
                  )}
                </div>

                {result.serialPremiumAlerts.length > 0 && (
                  <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950">
                    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Premium Serials Still in Packs</div>
                      <div className="text-xs text-zinc-500">{result.serialPremiumAlerts.length} found</div>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-wrap gap-2">
                        {displayedAlerts.map((alert, i) => (
                          <span key={i} className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs text-red-300">{alert}</span>
                        ))}
                      </div>
                      {result.serialPremiumAlerts.length > 8 && (
                        <button onClick={() => setShowAllAlerts((p) => !p)} className="mt-3 text-xs text-zinc-400 hover:text-white">{showAllAlerts ? "Show fewer" : "Show all " + result.serialPremiumAlerts.length + " alerts"}</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {hasWalletData && (
          <div className="mb-6 rounded-xl border border-zinc-700 bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{"My Sealed Packs — " + walletQuery + " — " + myOwnedPackCards.length + " packs"}</div>
              <div className="text-xs text-zinc-500">Click to analyze</div>
            </div>
            <div className="flex flex-wrap gap-3 p-4">
              {myOwnedPackCards.map(({ distId, listing, count }) => {
                if (listing) {
                  const ptBadge = packTypeBadge(listing.packType)
                  return (
                    <button key={distId}
                      onClick={() => canAnalyzeEV(listing.packType) ? handleAnalyze(listing) : undefined}
                      className={"flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition " + (canAnalyzeEV(listing.packType) ? "hover:bg-zinc-800 cursor-pointer" : "cursor-default opacity-80") + " " + (selectedPack?.distId === distId ? "bg-zinc-800" : "border-zinc-700 bg-zinc-900")}
                      style={selectedPack?.distId === distId ? { borderColor: accent } : undefined}>
                      {listing.imageUrl && <img src={listing.imageUrl} alt={listing.title} className="h-8 w-8 rounded object-cover flex-shrink-0" />}
                      <div>
                        <div className="text-xs font-semibold text-white max-w-[140px] truncate">{listing.title}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={"rounded border px-1 py-0 text-[9px] font-semibold capitalize " + tierBadge(listing.tier)}>{listing.tier}</span>
                          <span className={"rounded border px-1 py-0 text-[9px] font-semibold " + ptBadge.className}>{ptBadge.label}</span>
                          {listing.lowestAsk > 0 && <span className="text-[10px] text-zinc-400">{fmt(listing.lowestAsk)}</span>}
                          {count > 1 && <span className="rounded bg-green-950 px-1.5 py-0 text-[10px] font-semibold text-green-400">{"x" + count}</span>}
                        </div>
                      </div>
                    </button>
                  )
                }
                return (
                  <div key={distId} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 opacity-50">
                    <div className="h-8 w-8 rounded bg-zinc-800 flex items-center justify-center flex-shrink-0">
                      <span className="text-[9px] text-zinc-500">?</span>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-400">{"Pack #" + distId}</div>
                      <div className="text-[10px] text-zinc-600">Not on market</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-3 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {"Secondary Market — " + (listings.length > 0 ? listings.length + " drops" : "loading...")}
              </div>
              <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Search packs..."
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 w-40"
                style={{ "--tw-ring-color": accent } as React.CSSProperties}
                onFocus={(e) => (e.currentTarget.style.borderColor = accent)}
                onBlur={(e) => (e.currentTarget.style.borderColor = "")} />
              <button
                onClick={calculateAllEV}
                disabled={calcAllProgress !== null || listingsLoading}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
                style={{ backgroundColor: accent }}
              >
                {calcAllProgress !== null
                  ? "Calculating… " + calcAllProgress.done + " / " + calcAllProgress.total
                  : "Calculate All EV"}
              </button>
              <div className="ml-auto flex items-center gap-2">
                <input value={walletInput} onChange={(e) => setWalletInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && walletInput.trim()) handleWalletSearch() }}
                  placeholder="Username or wallet to show owned"
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 w-56"
                  onFocus={(e) => (e.currentTarget.style.borderColor = accent)}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "")} />
                <button onClick={handleWalletSearch} disabled={walletLoading || !walletInput.trim()}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">
                  {walletLoading ? "Loading..." : "Show Owned"}
                </button>
                {walletAddress && <span className="text-xs text-green-400">{walletQuery}</span>}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-[10px] text-zinc-600 mr-1">TIER</span>
              {["all", "ultimate", "legendary", "rare", "fandom", "common"].map((t) => (
                <button key={t} onClick={() => setTierFilter(t)}
                  className={"rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition " + (tierFilter === t ? "text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}
                  style={tierFilter === t ? { backgroundColor: accent } : undefined}>
                  {t === "all" ? "All" : t}
                </button>
              ))}
              <span className="text-[10px] text-zinc-600 ml-3 mr-1">TYPE</span>
              {packTypeFilters.map(({ key, label }) => (
                <button key={key} onClick={() => setPackTypeFilter(key)}
                  className={"rounded-lg px-2.5 py-1 text-xs font-semibold transition " + (packTypeFilter === key ? "text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}
                  style={packTypeFilter === key ? { backgroundColor: accent } : undefined}>
                  {label}
                </button>
              ))}
            </div>
            {walletError && <div className="text-xs text-red-400">{walletError}</div>}
          </div>

          {listingsLoading && (
            <div style={{ padding: "60px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              {[100, 85, 70, 55, 40].map((w, i) => (
                <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, maxWidth: 500, height: 14, opacity: 1 - i * 0.15 }} />
              ))}
              <p className="rpc-label" style={{ marginTop: 12 }}>SCANNING THE MARKETPLACE&hellip;</p>
            </div>
          )}
          {listingsError && <div className="p-4 text-red-400 text-sm">{listingsError}</div>}
          {!listingsLoading && filteredListings.length === 0 && (
            <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              <span style={{ fontSize: 40, opacity: 0.3 }}>▣</span>
              <p className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>NO ACTIVE DROPS</p>
              <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)" }}>Check back when the next pack drops.</p>
            </div>
          )}
          {!listingsLoading && filteredListings.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
              {filteredListings.map((listing) => {
                const ownedCount = ownedPacks[listing.distId] ?? 0
                const isSelected = selectedPack?.packListingId === listing.packListingId
                const ptBadge = packTypeBadge(listing.packType)
                const ev = evCache[listing.packListingId]
                const ratio = ev && !ev.loading && !ev.error ? ev.valueRatio : null
                const ratioTintBorder = ratio != null && ratio >= 1.0 ? "rgba(34,197,94,0.55)" : ratio != null && ratio < 0.8 ? "rgba(239,68,68,0.45)" : "var(--rpc-border)"
                const canAnalyze = canAnalyzeEV(listing.packType)
                return (
                  <div key={listing.packListingId}
                    onClick={() => canAnalyze ? openEvModal(listing) : undefined}
                    style={{ background: "var(--rpc-surface)", border: `1px solid ${ratioTintBorder}`, borderRadius: 8, overflow: "hidden", cursor: canAnalyze ? "pointer" : "default", opacity: canAnalyze ? 1 : 0.75, display: "flex", flexDirection: "column" }}>
                    <div style={{ height: 160, background: "#111", position: "relative", overflow: "hidden" }}>
                      {listing.imageUrl ? (
                        <img src={listing.imageUrl} alt={listing.title} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.25)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em" }}>{listing.tier}</div>
                      )}
                      <span className={"absolute top-2 left-2 rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize " + tierBadge(listing.tier)} style={{ position: "absolute", top: 8, left: 8 }}>{listing.tier}</span>
                      {ownedCount > 0 && (
                        <span style={{ position: "absolute", top: 8, right: 8, background: "rgba(20,83,45,0.9)", color: "#4ade80", padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 700 }}>OWN {ownedCount}</span>
                      )}
                    </div>
                    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                      <div style={{ fontWeight: 700, color: "#fff", fontSize: 13, lineHeight: 1.2 }} title={listing.title}>{listing.title}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span className={"rounded border px-1.5 py-0 text-[9px] font-semibold " + ptBadge.className}>{ptBadge.label}</span>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>{listing.momentsPerPack} slots</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                        <span>Ask {listing.lowestAsk > 0 ? fmt(listing.lowestAsk) : "—"}</span>
                        {ratio != null && (
                          <span style={{ color: ratio >= 1 ? "#4ade80" : ratio < 0.8 ? "#f87171" : "#facc15", fontWeight: 700 }}>{(ratio * 100).toFixed(0)}%</span>
                        )}
                      </div>
                      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, paddingTop: 4 }}>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.35)" }}>#{listing.distId}</span>
                        {canAnalyze ? (
                          <button onClick={(e) => { e.stopPropagation(); handleAnalyze(listing) }}
                            style={{ background: isSelected ? "#52525b" : accent, color: "#fff", padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer" }}>
                            {isSelected && loading ? "..." : "ANALYZE"}
                          </button>
                        ) : (
                          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>N/A</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* EV Modal */}
        {modalPack && (
          <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { setModalPack(null); setModalResult(null) }}>
            <div className="absolute inset-0 bg-black/60" />
            <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl m-4" onClick={(e) => e.stopPropagation()}>
              <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-5 py-4">
                {modalPack.imageUrl && <img src={modalPack.imageUrl} alt={modalPack.title} className="h-12 w-12 rounded object-cover flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-white text-lg truncate">{modalPack.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize " + tierBadge(modalPack.tier)}>{modalPack.tier}</span>
                    <span className="text-xs text-zinc-400">{modalPack.momentsPerPack} moments</span>
                  </div>
                </div>
                <button onClick={() => { setModalPack(null); setModalResult(null) }} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-900">✕</button>
              </div>

              {modalLoading && (
                <div className="p-8 text-center text-zinc-500 text-sm animate-pulse">Analyzing pack contents...</div>
              )}

              {modalResult && (
                <div className="p-5 space-y-5">
                  {/* Summary stats */}
                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Pack Price</div>
                      <div className="text-lg font-black text-white">{fmt(modalPack.lowestAsk)}</div>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Gross EV</div>
                      <div className={"text-lg font-black " + (modalResult.isPositiveEV ? "text-green-400" : "text-red-400")}>{fmt(modalResult.grossEV)}</div>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">EV Ratio</div>
                      <div className={"text-lg font-black " + (modalResult.grossEV / (modalPack.lowestAsk || 1) >= 1 ? "text-green-400" : "text-red-400")}>
                        {modalPack.lowestAsk > 0 ? (modalResult.grossEV / modalPack.lowestAsk).toFixed(2) + "x" : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Pack EV</div>
                      <div className={"text-lg font-black " + (modalResult.isPositiveEV ? "text-green-400" : "text-red-400")}>{fmt(modalResult.packEV)}</div>
                    </div>
                  </div>

                  {modalResult.fmvCoverageNote && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-2.5">
                      <span className="text-amber-500 text-sm mt-0.5">⚠</span>
                      <span className="text-xs text-amber-400">{modalResult.fmvCoverageNote}</span>
                    </div>
                  )}

                  {renderEvSparkline(modalPack.packListingId, modalResult.isPositiveEV)}

                  {/* Top Pulls table */}
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Top Pulls</div>
                    <div className="overflow-x-auto rounded-lg border border-zinc-800">
                      <table className="w-full border-collapse text-sm">
                        <thead className="bg-zinc-900">
                          <tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                            <th className="p-2.5">Player</th>
                            <th className="p-2.5">Tier</th>
                            <th className="p-2.5">Prob %</th>
                            <th className="p-2.5">Price</th>
                            <th className="p-2.5">EV</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modalResult.topPulls.slice(0, 15).map((pull) => (
                            <tr key={pull.editionId} className="border-t border-zinc-800/50">
                              <td className="p-2.5">
                                <div className="font-medium text-white text-xs">{pull.playerName}</div>
                                <div className="text-[10px] text-zinc-500 truncate max-w-[180px]">{pull.setName}</div>
                              </td>
                              <td className="p-2.5"><span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize " + tierBadge(pull.tier)}>{pull.tier}</span></td>
                              <td className="p-2.5 text-zinc-300 text-xs">{pull.probability}%</td>
                              <td className="p-2.5 text-zinc-300 text-xs">{pull.averageSalePrice > 0 ? fmt(pull.averageSalePrice) : pull.lowAsk > 0 ? fmt(pull.lowAsk) : "—"}</td>
                              <td className="p-2.5 font-semibold text-white text-xs">{fmt(pull.editionEV)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {modalResult.topPulls.length > 15 && (
                      <div className="mt-2 text-[10px] text-zinc-500">{modalResult.topPulls.length - 15} more editions not shown</div>
                    )}
                  </div>

                  {/* Community Pulls collapsible */}
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950">
                    <button
                      onClick={() => setShowPullsSection((v) => !v)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">📊 Community Pulls</span>
                      <span className="text-xs text-zinc-500">{showPullsSection ? "▾" : "▸"}</span>
                    </button>
                    {showPullsSection && (
                      <div className="border-t border-zinc-800 p-4 space-y-4">
                        {pullStats === null ? (
                          <div className="text-xs text-zinc-500">Loading pulls…</div>
                        ) : pullStats.length === 0 ? (
                          <div className="text-xs text-zinc-500">No community pulls logged yet. Be the first!</div>
                        ) : (
                          <div className="overflow-x-auto rounded border border-zinc-800">
                            <table className="w-full text-xs">
                              <thead className="bg-zinc-900 text-[10px] uppercase tracking-wide text-zinc-500">
                                <tr>
                                  <th className="p-2 text-left">Tier</th>
                                  <th className="p-2 text-right">Pulls</th>
                                  <th className="p-2 text-right">Avg FMV</th>
                                  <th className="p-2 text-right">% of Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {pullStats.map((s) => (
                                  <tr key={s.pull_tier} className="border-t border-zinc-800/50">
                                    <td className="p-2">
                                      <span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize " + tierBadge(String(s.pull_tier ?? "").toLowerCase())}>
                                        {s.pull_tier}
                                      </span>
                                    </td>
                                    <td className="p-2 text-right text-zinc-300">{s.pull_count}</td>
                                    <td className="p-2 text-right text-zinc-300">{s.avg_fmv_usd != null ? fmt(Number(s.avg_fmv_usd)) : "—"}</td>
                                    <td className="p-2 text-right text-zinc-300">{Number(s.pct_of_total ?? 0).toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="rounded border border-zinc-800 bg-black p-3">
                          <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">Submit a Pull</div>
                          <div className="grid grid-cols-2 gap-2">
                            <select
                              value={pullForm.tier}
                              onChange={(e) => setPullForm((f) => ({ ...f, tier: e.target.value }))}
                              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white"
                            >
                              <option value="COMMON">Common</option>
                              <option value="RARE">Rare</option>
                              <option value="LEGENDARY">Legendary</option>
                              <option value="ULTIMATE">Ultimate</option>
                            </select>
                            <input
                              type="text"
                              placeholder="Player (optional)"
                              value={pullForm.playerName}
                              onChange={(e) => setPullForm((f) => ({ ...f, playerName: e.target.value }))}
                              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600"
                            />
                            <input
                              type="number"
                              placeholder="Serial # (optional)"
                              value={pullForm.serial}
                              onChange={(e) => setPullForm((f) => ({ ...f, serial: e.target.value }))}
                              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600"
                            />
                            <input
                              type="number"
                              step="0.01"
                              placeholder="Price paid (optional)"
                              value={pullForm.price}
                              onChange={(e) => setPullForm((f) => ({ ...f, price: e.target.value }))}
                              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600"
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={submitPull}
                              disabled={pullSubmitting}
                              className="rounded px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                              style={{ backgroundColor: accent }}
                            >
                              {pullSubmitting ? "Submitting…" : "Submit Pull"}
                            </button>
                            {pullSubmitSuccess && <span className="text-xs text-green-400">✓ Thanks for sharing!</span>}
                            {pullSubmitError && <span className="text-xs text-red-400">{pullSubmitError}</span>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {historicalPulls && (
                    <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                      <div className="mb-2 text-[11px] uppercase tracking-widest text-zinc-500">Historical Pulls from RPC Data</div>
                      {historicalPulls.total < 10 ? (
                        <div className="text-sm text-zinc-500">Not enough pull data yet for this pack.</div>
                      ) : (
                        <>
                          <div className="font-mono text-sm text-white">Total tracked pulls: <span className="font-black">{historicalPulls.total.toLocaleString()}</span></div>
                          <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 font-mono text-xs">
                            {Object.entries(historicalPulls.tierBreakdown).map(([tier, count]) => {
                              const pct = historicalPulls.total > 0 ? Math.round((count / historicalPulls.total) * 1000) / 10 : 0
                              return (
                                <div key={tier} className="rounded border border-zinc-800 bg-black p-2">
                                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">{tier}</div>
                                  <div className="text-white">{pct}%</div>
                                  <div className="text-[10px] text-zinc-600">{count.toLocaleString()}</div>
                                </div>
                              )
                            })}
                          </div>
                          <div className="mt-3 text-[10px] text-zinc-500">Based on {historicalPulls.total.toLocaleString()} pulls tracked by RPC — sample may be small.</div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!modalLoading && !modalResult && (
                <div className="p-8 text-center text-zinc-500 text-sm">Failed to load EV data.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}