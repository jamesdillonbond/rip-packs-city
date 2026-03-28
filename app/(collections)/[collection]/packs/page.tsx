"use client"

import { useEffect, useState, useRef, useCallback } from "react"

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
}

// Lightweight EV summary stored per pack in the client cache
type PackEVSummary = {
  grossEV: number
  packEV: number
  isPositiveEV: boolean
  valueRatio: number // grossEV / lowestAsk
  loading: boolean
  error: boolean
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

type SortKey = "tier" | "lowestAsk" | "retailPrice" | "momentsPerPack" | "title" | "owned" | "grossEV" | "valueRatio"

export default function PacksPage() {
  const [listings, setListings] = useState<PackListing[]>([])
  const [listingsLoading, setListingsLoading] = useState(true)
  const [listingsError, setListingsError] = useState("")
  const [tierFilter, setTierFilter] = useState("all")
  const [searchFilter, setSearchFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("tier")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  // Client-side EV cache: packListingId -> summary
  const [evCache, setEvCache] = useState<Record<string, PackEVSummary>>({})
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmActiveRef = useRef(false)

  const [walletInput, setWalletInput] = useState("")
  const [walletQuery, setWalletQuery] = useState("")
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

  const ttCost = ttMode && ttCount && ttFloor
    ? parseFloat(ttCount) * parseFloat(ttFloor)
    : null
  const ttPackEV = result !== null && ttCost !== null
    ? Math.round((result.grossEV - ttCost) * 100) / 100
    : null
  const ttIsPositive = ttPackEV !== null && ttPackEV > 0

  // Fetch EV for a single pack and store in client cache
  const fetchEVForPack = useCallback(async (pack: PackListing) => {
    const id = pack.packListingId
    setEvCache((prev) => ({ ...prev, [id]: { grossEV: 0, packEV: 0, isPositiveEV: false, valueRatio: 0, loading: true, error: false } }))
    try {
      const res = await fetch("/api/pack-ev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packListingId: id, packPrice: pack.lowestAsk }),
      })
      const json: PackEVResponse = await res.json()
      if (!res.ok || json.error) throw new Error(json.error ?? "failed")
      const valueRatio = pack.lowestAsk > 0 ? Math.round((json.grossEV / pack.lowestAsk) * 100) / 100 : 0
      setEvCache((prev) => ({
        ...prev,
        [id]: { grossEV: json.grossEV, packEV: json.packEV, isPositiveEV: json.isPositiveEV, valueRatio, loading: false, error: false },
      }))
    } catch {
      setEvCache((prev) => ({ ...prev, [id]: { grossEV: 0, packEV: 0, isPositiveEV: false, valueRatio: 0, loading: false, error: true } }))
    }
  }, [])

  // Process prewarm queue one at a time with a small delay between requests
  const drainPrewarmQueue = useCallback(async (packMap: Map<string, PackListing>) => {
    if (prewarmActiveRef.current) return
    prewarmActiveRef.current = true
    while (prewarmQueueRef.current.length > 0) {
      const id = prewarmQueueRef.current.shift()!
      const pack = packMap.get(id)
      if (pack) await fetchEVForPack(pack)
      // 2 second gap between prewarm requests to avoid hammering the server
      await new Promise((r) => setTimeout(r, 2000))
    }
    prewarmActiveRef.current = false
  }, [fetchEVForPack])

  useEffect(() => {
    async function fetchListings() {
      try {
        const res = await fetch("/api/pack-listings")
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || "Failed to load pack listings")
        const data: PackListing[] = json.listings ?? []
        setListings(data)

        // Build a map for the prewarm queue lookup
        const packMap = new Map(data.map((p) => [p.packListingId, p]))

        // Queue top 20 packs (Ultimate + Legendary sorted by lowest ask) for background EV fetching
        const top20 = data.slice(0, 20)
        prewarmQueueRef.current = top20.map((p) => p.packListingId)
        drainPrewarmQueue(packMap)
      } catch (err) {
        setListingsError(err instanceof Error ? err.message : "Failed to load listings")
      } finally {
        setListingsLoading(false)
      }
    }
    fetchListings()
  }, [drainPrewarmQueue])

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

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => d === "asc" ? "desc" : "asc")
    } else {
      setSortKey(key)
      // EV columns default to descending (highest first)
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
      if (searchFilter && !l.title.toLowerCase().includes(searchFilter.toLowerCase())) return false
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
        diff = a.title.localeCompare(b.title)
      } else if (sortKey === "owned") {
        diff = (ownedPacks[b.distId] ?? 0) - (ownedPacks[a.distId] ?? 0)
        if (diff === 0) diff = tierOrder(a.tier) - tierOrder(b.tier)
      } else if (sortKey === "grossEV") {
        const gA = evA && !evA.loading && !evA.error ? evA.grossEV : -1
        const gB = evB && !evB.loading && !evB.error ? evB.grossEV : -1
        diff = gA - gB
      } else if (sortKey === "valueRatio") {
        const rA = evA && !evA.loading && !evA.error ? evA.valueRatio : -1
        const rB = evB && !evB.loading && !evB.error ? evB.valueRatio : -1
        diff = rA - rB
      }
      return sortDir === "asc" ? diff : -diff
    })

  async function handleAnalyze(pack: PackListing) {
    setSelectedPack(pack)
    setLoading(true)
    setError("")
    setResult(null)
    setShowAllPulls(false)
    setShowAllAlerts(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
    try {
      const response = await fetch("/api/pack-ev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packListingId: pack.packListingId,
          packPrice: !ttMode ? pack.lowestAsk : 0,
        }),
      })
      const json: PackEVResponse = await response.json()
      if (!response.ok) throw new Error(json.error || "Pack EV analysis failed")
      setResult(json)
      // Update EV cache with fresh data from full analysis
      const valueRatio = pack.lowestAsk > 0 ? Math.round((json.grossEV / pack.lowestAsk) * 100) / 100 : 0
      setEvCache((prev) => ({
        ...prev,
        [pack.packListingId]: { grossEV: json.grossEV, packEV: json.packEV, isPositiveEV: json.isPositiveEV, valueRatio, loading: false, error: false },
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
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

  const displayedPulls = result
    ? showAllPulls ? result.topPulls : result.topPulls.slice(0, 5)
    : []

  const displayedAlerts = result
    ? showAllAlerts ? result.serialPremiumAlerts : result.serialPremiumAlerts.slice(0, 8)
    : []

  // EV badge renderer for table cells
  function renderEVCell(pack: PackListing) {
    const ev = evCache[pack.packListingId]
    if (!ev) return <span className="text-zinc-700 text-xs">—</span>
    if (ev.loading) return <span className="text-zinc-600 text-xs animate-pulse">...</span>
    if (ev.error) return <span className="text-zinc-700 text-xs">err</span>
    return (
      <span className={"text-xs font-semibold " + (ev.isPositiveEV ? "text-green-400" : "text-red-400")}>
        {fmt(ev.grossEV)}
      </span>
    )
  }

  function renderRatioCell(pack: PackListing) {
    const ev = evCache[pack.packListingId]
    if (!ev) return <span className="text-zinc-700 text-xs">—</span>
    if (ev.loading) return <span className="text-zinc-600 text-xs animate-pulse">...</span>
    if (ev.error) return <span className="text-zinc-700 text-xs">err</span>
    const ratio = ev.valueRatio
    const color = ratio >= 1.2 ? "text-green-400" : ratio >= 1.0 ? "text-yellow-400" : "text-red-400"
    return <span className={"text-xs font-semibold " + color}>{ratio.toFixed(2) + "x"}</span>
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">

        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img src="/rip-packs-city-logo.png" alt="Rip Packs City" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 9999 }} />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">RIP PACKS CITY</h1>
            <p className="text-xs text-zinc-400 md:text-sm">Pack EV Calculator</p>
          </div>
          <div className="ml-auto flex gap-2">
            <a href="/nba-top-shot/collection" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Wallet</a>
            <a href="/nba-top-shot/sniper" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sniper</a>
            <a href="/nba-top-shot/sets" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sets</a>
            <a href="/nba-top-shot/badges" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
          </div>
        </div>

        {(loading || result !== null || error) && selectedPack !== null && (
          <div className="mb-6">
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3">
              {selectedPack.imageUrl && <img src={selectedPack.imageUrl} alt={selectedPack.title} className="h-10 w-10 rounded object-cover" />}
              <div>
                <div className="font-bold text-white">{selectedPack.title}</div>
                <div className="text-xs text-zinc-400">
                  <span className={"rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize mr-2 " + tierBadge(selectedPack.tier)}>{selectedPack.tier}</span>
                  {selectedPack.momentsPerPack} moments · Lowest Ask {fmt(selectedPack.lowestAsk)}
                  {hasWalletData && (ownedPacks[selectedPack.distId] ?? 0) > 0 && (
                    <span className="ml-2 rounded bg-green-950 px-2 py-0.5 text-[10px] font-semibold text-green-400">{"You own " + (ownedPacks[selectedPack.distId] ?? 0)}</span>
                  )}
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button onClick={() => setTtMode(false)} className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (!ttMode ? "bg-red-600 text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}>Cash Price</button>
                <button onClick={() => setTtMode(true)} className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (ttMode ? "bg-red-600 text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}>Trade Tickets</button>
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
                    <div className="mt-1 text-xs text-zinc-500">{ttMode && ttCost !== null && ttCount && ttFloor ? ttCount + " TTs x " + fmt(parseFloat(ttFloor)) : result.editionCount + " editions analyzed"}</div>
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
                              <div className="h-full rounded-full bg-red-600" style={{ width: (result.grossEV > 0 ? Math.min(100, (data.totalEV / result.grossEV) * 100) : 0) + "%" }} />
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
                  return (
                    <button key={distId} onClick={() => handleAnalyze(listing)}
                      className={"flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition hover:bg-zinc-800 " + (selectedPack?.distId === distId ? "border-red-600 bg-zinc-800" : "border-zinc-700 bg-zinc-900")}>
                      {listing.imageUrl && <img src={listing.imageUrl} alt={listing.title} className="h-8 w-8 rounded object-cover flex-shrink-0" />}
                      <div>
                        <div className="text-xs font-semibold text-white max-w-[140px] truncate">{listing.title}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={"rounded border px-1 py-0 text-[9px] font-semibold capitalize " + tierBadge(listing.tier)}>{listing.tier}</span>
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
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {"Secondary Market — " + (listings.length > 0 ? listings.length + " drops" : "loading...")}
              </div>
              <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Search packs..."
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-red-600 w-40" />
              <div className="flex flex-wrap gap-1">
                {["all", "ultimate", "legendary", "rare", "fandom", "common"].map((t) => (
                  <button key={t} onClick={() => setTierFilter(t)}
                    className={"rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition " + (tierFilter === t ? "bg-red-600 text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}>
                    {t === "all" ? "All" : t}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <input value={walletInput} onChange={(e) => setWalletInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && walletInput.trim()) handleWalletSearch() }}
                  placeholder="Username or wallet to show owned"
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-red-600 w-56" />
                <button onClick={handleWalletSearch} disabled={walletLoading || !walletInput.trim()}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">
                  {walletLoading ? "Loading..." : "Show Owned"}
                </button>
                {walletAddress && <span className="text-xs text-green-400">{walletQuery}</span>}
              </div>
            </div>
            {walletError && <div className="mt-2 text-xs text-red-400">{walletError}</div>}
          </div>

          {listingsLoading && <div className="p-8 text-center text-zinc-500 text-sm">Loading pack listings...</div>}
          {listingsError && <div className="p-4 text-red-400 text-sm">{listingsError}</div>}
          {!listingsLoading && filteredListings.length === 0 && <div className="p-8 text-center text-zinc-500 text-sm">No packs found.</div>}
          {!listingsLoading && filteredListings.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] border-collapse text-sm">
                <thead className="bg-zinc-900">
                  <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                    <th className="p-3"><button onClick={() => toggleSort("title")} className="hover:text-white">{"Pack" + sortIndicator("title")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("tier")} className="hover:text-white">{"Tier" + sortIndicator("tier")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("momentsPerPack")} className="hover:text-white">{"Moments" + sortIndicator("momentsPerPack")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("retailPrice")} className="hover:text-white">{"Retail" + sortIndicator("retailPrice")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("lowestAsk")} className="hover:text-white">{"Lowest Ask" + sortIndicator("lowestAsk")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("grossEV")} className="hover:text-white">{"Gross EV" + sortIndicator("grossEV")}</button></th>
                    <th className="p-3"><button onClick={() => toggleSort("valueRatio")} className="hover:text-white">{"Value" + sortIndicator("valueRatio")}</button></th>
                    {hasWalletData && <th className="p-3"><button onClick={() => toggleSort("owned")} className="hover:text-white">{"Owned" + sortIndicator("owned")}</button></th>}
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredListings.map((listing) => {
                    const ownedCount = ownedPacks[listing.distId] ?? 0
                    const isSelected = selectedPack?.packListingId === listing.packListingId
                    return (
                      <tr key={listing.packListingId}
                        className={"border-b border-zinc-800 hover:bg-zinc-900/50 cursor-pointer " + (isSelected ? "bg-zinc-900/70" : "")}
                        onClick={() => handleAnalyze(listing)}>
                        <td className="p-3">
                          <div className="flex items-center gap-3">
                            {listing.imageUrl && <img src={listing.imageUrl} alt={listing.title} className="h-10 w-10 rounded object-cover flex-shrink-0" />}
                            <span className="font-medium text-white">{listing.title}</span>
                          </div>
                        </td>
                        <td className="p-3"><span className={"rounded border px-2 py-0.5 text-[11px] font-semibold capitalize " + tierBadge(listing.tier)}>{listing.tier}</span></td>
                        <td className="p-3 text-zinc-400">{listing.momentsPerPack}</td>
                        <td className="p-3 text-zinc-400">{listing.retailPrice > 0 ? fmt(listing.retailPrice) : "—"}</td>
                        <td className="p-3 font-semibold text-white">{listing.lowestAsk > 0 ? fmt(listing.lowestAsk) : "—"}</td>
                        <td className="p-3">{renderEVCell(listing)}</td>
                        <td className="p-3">{renderRatioCell(listing)}</td>
                        {hasWalletData && (
                          <td className="p-3">
                            {ownedCount > 0
                              ? <span className="rounded bg-green-950 px-2 py-0.5 text-xs font-semibold text-green-400">{ownedCount}</span>
                              : <span className="text-zinc-600">—</span>}
                          </td>
                        )}
                        <td className="p-3">
                          <button onClick={(e) => { e.stopPropagation(); handleAnalyze(listing) }}
                            className={"rounded-lg px-3 py-1 text-xs font-semibold text-white transition " + (isSelected ? "bg-zinc-600" : "bg-red-600 hover:bg-red-500")}>
                            {isSelected && loading ? "..." : "Analyze"}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}