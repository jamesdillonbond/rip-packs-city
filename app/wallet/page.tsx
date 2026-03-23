"use client"

import { Fragment, useMemo, useState } from "react"
import {
  normalizeSetName,
  normalizeParallel,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"

type MarketResult = {
  momentId: string
  fmv: number | null
  bestOffer: number | null
  lowAsk: number | null
  valuationScope: "Parallel" | "Edition" | "Modeled"
  isSpecialSerial: boolean
  debugReason:
    | "OK"
    | "NO_LOW_ASK"
    | "NO_BEST_OFFER"
    | "NO_MARKET_INPUTS"
    | "SPECIAL_SERIAL_NO_BASE"
  normalizedParallel: string
  normalizedSetName: string
  scopeKey: string
  marketSource:
    | "row"
    | "edition"
    | "row+edition"
    | "edition-sale"
    | "special-serial"
    | "none"
  fmvMethod:
    | "band"
    | "low-ask-only"
    | "best-offer-only"
    | "edition-last-sale"
    | "special-serial-premium"
    | "none"
  marketConfidence: "high" | "medium" | "low" | "none"
  rowLowAsk: number | null
  rowBestOffer: number | null
  editionLowAsk: number | null
  editionBestOffer: number | null
  editionLastSale: number | null
  editionAskCount: number
  editionOfferCount: number
  editionSaleCount: number
  editionMarketSource: string | null
  editionMarketSourceChain: string[]
  editionMarketTags: string[]
}

type MomentRow = {
  momentId: string
  playerName: string
  team?: string
  league?: string
  setName: string
  series?: string
  tier?: string
  serialNumber?: number
  serial?: number
  mintCount?: number
  mintSize?: number
  officialBadges?: string[]
  specialSerialTraits?: string[]
  traits?: string[]
  isLocked?: boolean
  locked?: boolean
  bestAsk?: number | null
  lowAsk?: number | null
  topshotAsk?: number | null
  flowtyAsk?: number | null
  bestMarket?: "Top Shot" | "Flowty" | null
  bestOffer?: number | null
  lastPurchasePrice?: number | null
  editionKey?: string | null
  parallel?: string | null
  subedition?: string | null
  editionsOwned?: number
  editionsLocked?: number
  thumbnailUrl?: string | null
  flowId?: string | null
  flowtyListingUrl?: string | null
  fmv?: number | null
  valuationScope?: "Parallel" | "Edition" | "Modeled"
  marketDebugReason?: string
  marketSource?: "row" | "edition" | "row+edition" | "edition-sale" | "special-serial" | "none"
  fmvMethod?: "band" | "low-ask-only" | "best-offer-only" | "edition-last-sale" | "special-serial-premium" | "none"
  marketConfidence?: "high" | "medium" | "low" | "none"
  scopeKey?: string
  rowLowAsk?: number | null
  rowBestOffer?: number | null
  editionLowAsk?: number | null
  editionBestOffer?: number | null
  editionLastSale?: number | null
  editionAskCount?: number
  editionOfferCount?: number
  editionSaleCount?: number
  editionMarketSource?: string | null
  editionMarketSourceChain?: string[]
  editionMarketTags?: string[]
}

type WalletSearchResponse = {
  rows?: MomentRow[]
  summary?: {
    totalMoments: number
    returnedMoments: number
    remainingMoments: number
  }
  error?: string
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  return `$${value.toFixed(2)}`
}

function compareText(a?: string | null, b?: string | null) {
  return (a ?? "").localeCompare(b ?? "")
}

function compareNumber(a?: number | null, b?: number | null) {
  return (a ?? -1) - (b ?? -1)
}

function getParallel(row: MomentRow) {
  return normalizeParallel(row.parallel ?? row.subedition ?? "")
}

function getSerial(row: MomentRow) {
  return row.serialNumber ?? row.serial ?? null
}

function getMint(row: MomentRow) {
  return row.mintCount ?? row.mintSize ?? null
}

function getBestAsk(row: MomentRow) {
  const values = [row.lowAsk, row.bestAsk, row.topshotAsk, row.flowtyAsk].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  )
  if (!values.length) return null
  return Math.min(...values)
}

function getTraits(row: MomentRow) {
  return row.specialSerialTraits ?? row.traits ?? []
}

function getLocked(row: MomentRow) {
  return Boolean(row.isLocked ?? row.locked)
}

function getPrimarySerialBadge(row: MomentRow) {
  const traits = getTraits(row)
  if (traits.includes("#1")) return "#1"
  if (traits.includes("Perfect Mint")) return "Perfect Mint"
  if (traits.includes("Jersey Match")) return "Jersey Match"
  return null
}

function badgeClass(name: string) {
  const lowered = name.toLowerCase()
  if (lowered.includes("rookie")) return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
  if (lowered.includes("debut")) return "bg-white text-black dark:bg-zinc-100 dark:text-black"
  if (lowered.includes("champ")) return "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-white"
  return "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
}

function debugReasonLabel(reason?: string | null) {
  if (!reason) return "-"
  switch (reason) {
    case "OK": return "OK"
    case "NO_LOW_ASK": return "No low ask"
    case "NO_BEST_OFFER": return "No best offer"
    case "NO_MARKET_INPUTS": return "No market inputs"
    case "SPECIAL_SERIAL_NO_BASE": return "No serial base"
    default: return reason
  }
}

type SortKey =
  | "player"
  | "series"
  | "set"
  | "parallel"
  | "rarity"
  | "serial"
  | "fmv"
  | "bestOffer"
  | "held"

export default function WalletPage() {
  const [rows, setRows] = useState<MomentRow[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [summary, setSummary] = useState<WalletSearchResponse["summary"]>()
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const [offset, setOffset] = useState(0)
  const [showDebug, setShowDebug] = useState(false)

  const [teamFilter, setTeamFilter] = useState("all")
  const [leagueFilter, setLeagueFilter] = useState("all")
  const [rarityFilter, setRarityFilter] = useState("all")
  const [parallelFilter, setParallelFilter] = useState("all")
  const [lockedFilter, setLockedFilter] = useState("all")
  const [searchWithin, setSearchWithin] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("fmv")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")

  // Step 1: Flowty enrichment placeholder
  // Top Shot GraphQL blocks server-side requests without a browser session.
  // This is a no-op passthrough until we implement client-side Flowty enrichment.
  async function enrichWithMarket(rowsIn: MomentRow[]) {
    return rowsIn
  }

  // Step 2: Hydrate with FMV + edition-level market data
  async function hydrateMarket(rowsIn: MomentRow[]) {
    if (!rowsIn.length) return rowsIn

    const response = await fetch("/api/market-truth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: rowsIn.map((row) => ({
          momentId: row.momentId,
          editionKey: row.editionKey ?? null,
          parallel: row.parallel ?? row.subedition ?? null,
          setName: row.setName ?? null,
          playerName: row.playerName ?? null,
          bestAsk: row.bestAsk ?? null,
          lowAsk: row.lowAsk ?? null,
          bestOffer: row.bestOffer ?? null,
          lastPurchasePrice: row.lastPurchasePrice ?? null,
          specialSerialTraits: getTraits(row),
        })),
      }),
    })

    const json = await response.json()
    if (!response.ok) {
      throw new Error(json.error || "market-truth failed")
    }

    const marketRows = Array.isArray(json.rows) ? (json.rows as MarketResult[]) : []
    const marketMap = new Map<string, MarketResult>()
    marketRows.forEach((r) => marketMap.set(String(r.momentId), r))

    return rowsIn.map((row) => {
      const market = marketMap.get(String(row.momentId))
      return {
        ...row,
        setName: market?.normalizedSetName || normalizeSetName(row.setName),
        parallel: market?.normalizedParallel || normalizeParallel(row.parallel ?? row.subedition ?? ""),
        fmv: market?.fmv ?? row.fmv ?? null,
        bestOffer: market?.bestOffer ?? row.bestOffer ?? null,
        valuationScope: market?.valuationScope ?? row.valuationScope,
        marketDebugReason: market?.debugReason ?? row.marketDebugReason,
        marketSource: market?.marketSource ?? row.marketSource,
        fmvMethod: market?.fmvMethod ?? row.fmvMethod,
        marketConfidence: market?.marketConfidence ?? row.marketConfidence,
        scopeKey: market?.scopeKey ?? row.scopeKey,
        rowLowAsk: market?.rowLowAsk ?? row.rowLowAsk,
        rowBestOffer: market?.rowBestOffer ?? row.rowBestOffer,
        editionLowAsk: market?.editionLowAsk ?? row.editionLowAsk,
        editionBestOffer: market?.editionBestOffer ?? row.editionBestOffer,
        editionLastSale: market?.editionLastSale ?? row.editionLastSale,
        editionAskCount: market?.editionAskCount ?? row.editionAskCount,
        editionOfferCount: market?.editionOfferCount ?? row.editionOfferCount,
        editionSaleCount: market?.editionSaleCount ?? row.editionSaleCount,
        editionMarketSource: market?.editionMarketSource ?? row.editionMarketSource,
        editionMarketSourceChain: market?.editionMarketSourceChain ?? row.editionMarketSourceChain,
        editionMarketTags: market?.editionMarketTags ?? row.editionMarketTags,
      }
    })
  }

  async function fetchWalletPage(nextOffset: number, append: boolean) {
    const response = await fetch("/api/wallet-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, offset: nextOffset, limit: 50 }),
    })

    const json = (await response.json()) as WalletSearchResponse

    if (!response.ok) {
      throw new Error(json.error || "Wallet search failed")
    }

    const nextRows = Array.isArray(json.rows) ? json.rows : []

    // Enrich with Flowty data first, then compute FMV
    const enriched = await enrichWithMarket(nextRows)
    const hydrated = await hydrateMarket(enriched)

    setRows((prev) => (append ? [...prev, ...hydrated] : hydrated))
    setSummary(json.summary)
    setOffset(nextOffset + nextRows.length)
  }

  async function handleSearch() {
    setLoading(true)
    setError("")
    setRows([])
    setSummary(undefined)
    setOffset(0)
    setExpandedRows({})

    try {
      await fetchWalletPage(0, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  async function handleLoadMore() {
    setLoadingMore(true)
    setError("")

    try {
      await fetchWalletPage(offset, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoadingMore(false)
    }
  }

  function toggleSort(next: SortKey) {
    if (sortKey === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(next)
      setSortDirection("desc")
    }
  }

  function toggleExpanded(momentId: string) {
    setExpandedRows((prev) => ({ ...prev, [momentId]: !prev[momentId] }))
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

      const key = `${candidate.editionKey ?? "none"}::${candidate.parallel ?? "Base"}`
      if (!unique.has(key)) unique.set(key, candidate)
    }

    const text = JSON.stringify(Array.from(unique.values()), null, 2)
    await navigator.clipboard.writeText(text)
  }

  const batchEditionStats = useMemo(() => {
    const map = new Map<string, { owned: number; locked: number }>()

    for (const row of rows) {
      const key = buildEditionScopeKey({
        editionKey: row.editionKey,
        setName: row.setName,
        playerName: row.playerName,
        parallel: row.parallel,
        subedition: row.subedition,
      })

      const current = map.get(key) ?? { owned: 0, locked: 0 }
      current.owned += 1
      if (getLocked(row)) current.locked += 1
      map.set(key, current)
    }

    return map
  }, [rows])

  const availableTeams = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => r.team && set.add(r.team))
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableLeagues = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => r.league && set.add(r.league))
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableRarities = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => r.tier && set.add(r.tier))
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableParallels = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => {
      const p = getParallel(r)
      if (p && p !== "Base") set.add(p)
    })
    return ["all", "Base", ...Array.from(set).sort()]
  }, [rows])

  const filteredRows = useMemo(() => {
    const q = searchWithin.trim().toLowerCase()

    const filtered = rows.filter((r) => {
      const parallel = getParallel(r)

      if (teamFilter !== "all" && r.team !== teamFilter) return false
      if (leagueFilter !== "all" && r.league !== leagueFilter) return false
      if (rarityFilter !== "all" && r.tier !== rarityFilter) return false
      if (parallelFilter !== "all" && parallel !== parallelFilter) return false
      if (lockedFilter === "locked" && !getLocked(r)) return false
      if (lockedFilter === "unlocked" && getLocked(r)) return false

      if (q) {
        const haystack = [
          r.playerName,
          r.team ?? "",
          r.league ?? "",
          r.series ?? "",
          r.setName,
          parallel,
          r.tier ?? "",
          ...(r.officialBadges ?? []),
          ...getTraits(r),
        ]
          .join(" ")
          .toLowerCase()

        if (!haystack.includes(q)) return false
      }

      return true
    })

    filtered.sort((a, b) => {
      let result = 0

      switch (sortKey) {
        case "player":
          result = compareText(a.playerName, b.playerName)
          break
        case "series":
          result = compareText(a.series, b.series)
          break
        case "set":
          result = compareText(a.setName, b.setName)
          break
        case "parallel":
          result = compareText(getParallel(a), getParallel(b))
          break
        case "rarity":
          result = compareText(a.tier, b.tier)
          break
        case "serial":
          result = compareNumber(getSerial(a), getSerial(b))
          break
        case "fmv":
          result = compareNumber(a.fmv, b.fmv)
          break
        case "bestOffer":
          result = compareNumber(a.bestOffer, b.bestOffer)
          break
        case "held":
          result = compareNumber(
            a.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(a))?.owned,
            b.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(b))?.owned
          )
          break
      }

      return sortDirection === "asc" ? result : -result
    })

    return filtered
  }, [
    rows,
    searchWithin,
    teamFilter,
    leagueFilter,
    rarityFilter,
    parallelFilter,
    lockedFilter,
    sortKey,
    sortDirection,
    batchEditionStats,
  ])

  const totals = useMemo(() => {
    let totalFmv = 0
    let totalBestOffer = 0
    let lockedFmv = 0
    let unlockedFmv = 0
    let lockedCount = 0
    let unlockedCount = 0

    for (const row of filteredRows) {
      const fmv = row.fmv ?? null
      const offer = row.bestOffer ?? null
      const locked = getLocked(row)

      if (typeof fmv === "number") totalFmv += fmv
      if (typeof offer === "number") totalBestOffer += offer

      const value = fmv ?? offer ?? getBestAsk(row) ?? 0

      if (locked) {
        lockedFmv += value
        lockedCount += 1
      } else {
        unlockedFmv += value
        unlockedCount += 1
      }
    }

    return {
      totalFmv,
      totalBestOffer,
      lockedFmv,
      unlockedFmv,
      totalCount: filteredRows.length,
      lockedCount,
      unlockedCount,
      spreadGap: totalFmv - totalBestOffer,
    }
  }, [filteredRows])

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img
            src="/rip-packs-city-logo.png"
            alt="Rip Packs City"
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 9999 }}
          />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">
              RIP PACKS CITY
            </h1>
            <p className="text-xs text-zinc-400 md:text-sm">
              Wallet intelligence for digital collectibles
            </p>
          </div>
        </div>

        <div className="mb-5 grid gap-3 md:grid-cols-[minmax(260px,420px)_auto]">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && input.trim() && handleSearch()}
              placeholder="Enter Top Shot username or wallet"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
            />
            <button
              onClick={handleSearch}
              disabled={loading || !input.trim()}
              className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Loading..." : "Search"}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Wallet FMV</div>
              <div className="text-lg font-bold text-white">{formatCurrency(totals.totalFmv)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Locked FMV</div>
              <div className="text-lg font-bold text-white">{formatCurrency(totals.lockedFmv)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Unlocked FMV</div>
              <div className="text-lg font-bold text-white">{formatCurrency(totals.unlockedFmv)}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Best Offer Total</div>
              <div className="text-lg font-bold text-white">{formatCurrency(totals.totalBestOffer)}</div>
            </div>
          </div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">Spread Gap</div>
            <div className="text-lg font-bold text-white">{formatCurrency(totals.spreadGap)}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">Shown Moments</div>
            <div className="text-lg font-bold text-white">{totals.totalCount}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">Locked Count</div>
            <div className="text-lg font-bold text-white">{totals.lockedCount}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">Unlocked Count</div>
            <div className="text-lg font-bold text-white">{totals.unlockedCount}</div>
          </div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableTeams.map((team) => (
              <option key={team} value={team}>{team === "all" ? "All Teams" : team}</option>
            ))}
          </select>
          <select value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableLeagues.map((league) => (
              <option key={league} value={league}>{league === "all" ? "All Leagues" : league}</option>
            ))}
          </select>
          <select value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableRarities.map((tier) => (
              <option key={tier} value={tier}>{tier === "all" ? "All Rarities" : tier}</option>
            ))}
          </select>
          <select value={parallelFilter} onChange={(e) => setParallelFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableParallels.map((parallel) => (
              <option key={parallel} value={parallel}>{parallel === "all" ? "All Parallels" : parallel}</option>
            ))}
          </select>
          <select value={lockedFilter} onChange={(e) => setLockedFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            <option value="all">All Lock States</option>
            <option value="locked">Locked</option>
            <option value="unlocked">Unlocked</option>
          </select>
          <input
            value={searchWithin}
            onChange={(e) => setSearchWithin(e.target.value)}
            placeholder="Filter loaded moments"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white placeholder:text-zinc-500"
          />
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={() => toggleSort("player")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Player</button>
          <button onClick={() => toggleSort("series")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Series</button>
          <button onClick={() => toggleSort("set")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Set</button>
          <button onClick={() => toggleSort("parallel")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Parallel</button>
          <button onClick={() => toggleSort("rarity")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Rarity</button>
          <button onClick={() => toggleSort("serial")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Serial</button>
          <button onClick={() => toggleSort("held")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Held</button>
          <button onClick={() => toggleSort("fmv")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">FMV</button>
          <button onClick={() => toggleSort("bestOffer")} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">Best Offer</button>
          <button
            onClick={() => setShowDebug((prev) => !prev)}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900"
          >
            {showDebug ? "Hide Debug" : "Show Debug"}
          </button>
          <button
            onClick={copySeedCandidates}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900"
          >
            Copy Seed Candidates
          </button>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300">
            {error}
          </div>
        ) : null}

        {showDebug ? (
          <div className="mb-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
            <table className="w-full min-w-[1900px] border-collapse text-xs">
              <thead className="bg-zinc-900">
                <tr className="border-b border-zinc-800 text-left">
                  <th className="p-2">Player</th>
                  <th className="p-2">Edition Key</th>
                  <th className="p-2">Parallel</th>
                  <th className="p-2">Scope Key</th>
                  <th className="p-2">Held</th>
                  <th className="p-2">Locked</th>
                  <th className="p-2">TS Ask</th>
                  <th className="p-2">Flowty Ask</th>
                  <th className="p-2">Best Market</th>
                  <th className="p-2">Row Low Ask</th>
                  <th className="p-2">Row Offer</th>
                  <th className="p-2">Edition Low Ask</th>
                  <th className="p-2">Edition Offer</th>
                  <th className="p-2">Last Sale</th>
                  <th className="p-2">Ask Count</th>
                  <th className="p-2">Offer Count</th>
                  <th className="p-2">Sale Count</th>
                  <th className="p-2">Edition Source</th>
                  <th className="p-2">FMV</th>
                  <th className="p-2">FMV Method</th>
                  <th className="p-2">Confidence</th>
                  <th className="p-2">Market Source</th>
                  <th className="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 50).map((row) => {
                  const scopeKey = buildEditionScopeKey({
                    editionKey: row.editionKey,
                    setName: row.setName,
                    playerName: row.playerName,
                    parallel: row.parallel,
                    subedition: row.subedition,
                  })

                  const counts = {
                    owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0,
                    locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0,
                  }

                  return (
                    <tr key={`debug-${row.momentId}`} className="border-b border-zinc-800">
                      <td className="p-2">{row.playerName}</td>
                      <td className="p-2">{row.editionKey ?? "-"}</td>
                      <td className="p-2">{getParallel(row)}</td>
                      <td className="p-2">{scopeKey}</td>
                      <td className="p-2">{counts.owned}</td>
                      <td className="p-2">{counts.locked}</td>
                      <td className="p-2">{formatCurrency(row.topshotAsk)}</td>
                      <td className="p-2">{formatCurrency(row.flowtyAsk)}</td>
                      <td className="p-2">{row.bestMarket ?? "-"}</td>
                      <td className="p-2">{formatCurrency(row.rowLowAsk ?? getBestAsk(row))}</td>
                      <td className="p-2">{formatCurrency(row.rowBestOffer ?? row.bestOffer)}</td>
                      <td className="p-2">{formatCurrency(row.editionLowAsk)}</td>
                      <td className="p-2">{formatCurrency(row.editionBestOffer)}</td>
                      <td className="p-2">{formatCurrency(row.editionLastSale)}</td>
                      <td className="p-2">{row.editionAskCount ?? 0}</td>
                      <td className="p-2">{row.editionOfferCount ?? 0}</td>
                      <td className="p-2">{row.editionSaleCount ?? 0}</td>
                      <td className="p-2">{row.editionMarketSource ?? "-"}</td>
                      <td className="p-2">{formatCurrency(row.fmv)}</td>
                      <td className="p-2">{row.fmvMethod ?? "-"}</td>
                      <td className="p-2">{row.marketConfidence ?? "-"}</td>
                      <td className="p-2">{row.marketSource ?? "-"}</td>
                      <td className="p-2">{debugReasonLabel(row.marketDebugReason)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full min-w-[1200px] border-collapse text-sm">
            <thead className="bg-zinc-900">
              <tr className="border-b border-zinc-800 text-left">
                <th className="p-3">Player</th>
                <th className="p-3">Series</th>
                <th className="p-3">Set</th>
                <th className="p-3">Parallel</th>
                <th className="p-3">Rarity</th>
                <th className="p-3">Serial / Mint</th>
                <th className="p-3">Editions Held / Locked</th>
                <th className="p-3">FMV</th>
                <th className="p-3">Best Offer</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>

            <tbody>
              {filteredRows.map((row) => {
                const scopeKey = buildEditionScopeKey({
                  editionKey: row.editionKey,
                  setName: row.setName,
                  playerName: row.playerName,
                  parallel: row.parallel,
                  subedition: row.subedition,
                })

                const editionCounts = {
                  owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0,
                  locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0,
                }

                const expanded = !!expandedRows[row.momentId]
                const primaryBadge = getPrimarySerialBadge(row)

                return (
                  <Fragment key={row.momentId}>
                    <tr className="border-b border-zinc-800 align-top">
                      <td className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="h-14 w-14 overflow-hidden rounded-lg border border-zinc-800 bg-black">
                            {row.thumbnailUrl ? (
                              <img
                                src={row.thumbnailUrl}
                                alt={row.playerName}
                                className="h-full w-full object-cover"
                              />
                            ) : null}
                          </div>
                          <div>
                            <div className="font-semibold text-white">{row.playerName}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(row.officialBadges ?? []).map((badge) => (
                                <span
                                  key={badge}
                                  className={`rounded px-2 py-0.5 text-[10px] font-semibold ${badgeClass(badge)}`}
                                >
                                  {badge}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="p-3">{row.series ?? "—"}</td>
                      <td className="p-3">{normalizeSetName(row.setName)}</td>
                      <td className="p-3">{getParallel(row)}</td>
                      <td className="p-3">{row.tier ?? "—"}</td>

                      <td className="p-3">
                        <div
                          className={`inline-flex min-w-[90px] flex-col rounded-lg border px-2 py-1 ${
                            primaryBadge ? "border-red-700 bg-red-950/50" : "border-zinc-800 bg-black"
                          }`}
                        >
                          <div className={`text-base font-black ${primaryBadge ? "text-red-300" : "text-white"}`}>
                            #{getSerial(row) ?? "-"}
                          </div>
                          <div className="text-xs text-zinc-400">/ {getMint(row) ?? "-"}</div>
                          {primaryBadge ? (
                            <div className="mt-1 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-black">
                              {primaryBadge}
                            </div>
                          ) : null}
                        </div>
                      </td>

                      <td className="p-3">{editionCounts.owned} / {editionCounts.locked}</td>

                      <td className="p-3 font-semibold text-white">
                        {formatCurrency(row.fmv)}
                      </td>

                      <td className="p-3">
                        {formatCurrency(row.bestOffer)}
                      </td>

                      <td className="p-3">
                        <button
                          onClick={() => toggleExpanded(row.momentId)}
                          className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-900"
                        >
                          {expanded ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr className="border-b border-zinc-800 bg-black/60">
                        <td colSpan={10} className="p-4">
                          <div className="grid gap-4 md:grid-cols-4">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Market
                              </div>
                              <div className="space-y-1 text-sm">
                                <div>Top Shot Ask: {formatCurrency(row.topshotAsk)}</div>
                                <div>Flowty Ask: {formatCurrency(row.flowtyAsk)}</div>
                                <div>Best Ask: {formatCurrency(getBestAsk(row))}</div>
                                <div>Best Market: {row.bestMarket ?? "-"}</div>
                                <div>Best Offer: {formatCurrency(row.bestOffer)}</div>
                                <div>FMV: {formatCurrency(row.fmv)}</div>
                                <div>FMV Method: {row.fmvMethod ?? "-"}</div>
                                <div>Confidence: {row.marketConfidence ?? "-"}</div>
                              </div>
                            </div>

                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Links
                              </div>
                              <div className="space-y-2 text-sm">
                                <a
                                  href={`https://nbatopshot.com/moment/${row.momentId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900"
                                >
                                  View on Top Shot
                                </a>
                                {row.flowtyListingUrl ? (
                                  <a
                                    href={`/out/flowty/${row.momentId}?source=wallet-expand&priceAtClick=${row.flowtyAsk ?? ""}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900"
                                  >
                                    View on Flowty {row.flowtyAsk ? `(${formatCurrency(row.flowtyAsk)})` : ""}
                                  </a>
                                ) : (
                                  <a
                                    href={`https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${row.momentId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-500 hover:bg-zinc-900"
                                  >
                                    Check Flowty
                                  </a>
                                )}
                              </div>
                            </div>

                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Metadata
                              </div>
                              <div className="space-y-1 text-sm">
                                <div>Team: {row.team ?? "-"}</div>
                                <div>League: {row.league ?? "-"}</div>
                                <div>Parallel: {getParallel(row)}</div>
                                <div>Locked: {getLocked(row) ? "Yes" : "No"}</div>
                                <div className="flex flex-wrap gap-1 pt-1">
                                  {getTraits(row).map((trait) => (
                                    <span
                                      key={trait}
                                      className="rounded bg-red-950 px-2 py-0.5 text-[10px] text-red-300"
                                    >
                                      {trait}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Debug
                              </div>
                              <div className="space-y-1 text-sm">
                                <div>Edition Key: {row.editionKey ?? "-"}</div>
                                <div>Scope Key: {scopeKey}</div>
                                <div>Valuation: {row.valuationScope ?? "-"}</div>
                                <div>Market Source: {row.marketSource ?? "-"}</div>
                                <div>Reason: {debugReasonLabel(row.marketDebugReason)}</div>
                                <div>Edition Source: {row.editionMarketSource ?? "-"}</div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {summary && summary.remainingMoments > 0 ? (
          <div className="mt-6 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-50 hover:bg-red-500"
            >
              {loadingMore ? "Loading..." : `Load More (${summary.remainingMoments} left)`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}