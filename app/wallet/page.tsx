"use client"

import { Fragment, useMemo, useState } from "react"
import {
  normalizeSetName,
  normalizeParallel,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"

// ── Types ─────────────────────────────────────────────────────────────────────

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

type BadgeInfo = {
  badge_score: number
  badge_titles: string[]
  is_three_star_rookie: boolean
  has_rookie_mint: boolean
  burn_rate_pct: number
  lock_rate_pct: number
  low_ask: number | null
  circulation_count: number
}

type MomentRow = {
  momentId: string
  playerName: string
  team?: string
  league?: string
  setName: string
  series?: string | number
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
  badgeInfo?: BadgeInfo | null
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

// ── Series display label mapping ───────────────────────────────────────────────
// on-chain series_number → human-readable label + NBA season for badge matching
const SERIES_MAP: Record<number, { label: string; season: string }> = {
  0: { label: "Beta",          season: "2019-20" },
  1: { label: "Series 1",      season: "2019-20" },
  2: { label: "Series 2",      season: "2020-21" },
  3: { label: "Summer 2021",   season: "2021"    },
  4: { label: "Series 3",      season: "2021-22" },
  5: { label: "Series 4",      season: "2022-23" },
  6: { label: "Series 2023-24",season: "2023-24" },
  7: { label: "Series 2024-25",season: "2024-25" },
  8: { label: "Series 2025-26",season: "2025-26" },
}

function seriesLabel(series: string | number | undefined): string {
  if (series === undefined || series === null) return "—"
  const n = typeof series === "string" ? parseInt(series, 10) : series
  if (isNaN(n)) return String(series)
  return SERIES_MAP[n]?.label ?? `Series ${n}`
}

function seriesSeason(series: string | number | undefined): string | null {
  if (series === undefined || series === null) return null
  const n = typeof series === "string" ? parseInt(series, 10) : series
  if (isNaN(n)) return null
  return SERIES_MAP[n]?.season ?? null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BADGE_COLORS: Record<string, string> = {
  "Rookie Year":        "bg-red-950 text-red-300 border border-red-800",
  "Rookie Premiere":    "bg-orange-950 text-orange-300 border border-orange-800",
  "Top Shot Debut":     "bg-zinc-100 text-zinc-900 border border-zinc-300",
  "Rookie of the Year": "bg-yellow-950 text-yellow-300 border border-yellow-700",
  "Rookie Mint":        "bg-blue-950 text-blue-300 border border-blue-800",
  "Championship Year":  "bg-zinc-800 text-white border border-zinc-600",
}

const BADGE_PILL_TITLES = new Set([
  "Rookie Year",
  "Rookie Premiere",
  "Top Shot Debut",
  "Rookie of the Year",
  "Rookie Mint",
  "Championship Year",
])

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function supaBadgePillClass(title: string) {
  return BADGE_COLORS[title] ?? "bg-zinc-800 text-zinc-300 border border-zinc-700"
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
  | "badge"

// ── Badge enrichment ───────────────────────────────────────────────────────────
// Matches wallet rows to badge_editions using:
//   playerName (normalized) + series_number (direct on-chain int join)
//
// Badge specificity by type:
//   - Top Shot Debut   → edition-specific (player's first ever TS moment)
//   - Rookie Year      → season-wide (any moment from rookie season)
//   - Rookie Premiere  → season-wide (first subset of rookie moments)
//   - Rookie Mint      → set-play specific (first minted moment in a set)
//   - ROY / MVP / Champ→ season-wide (awarded after season)
//
// We join on playerName + series_number which naturally scopes to the right
// season. A player with Rookie Year in series 2 will only match wallet moments
// that are also series 2 — no cross-season bleed.

async function enrichWithBadges(rowsIn: MomentRow[]): Promise<MomentRow[]> {
  if (!rowsIn.length) return rowsIn

  try {
    const res = await fetch(`/api/badges?mode=all&sort=badge_score&dir=desc&limit=500&offset=0`)
    if (!res.ok) return rowsIn

    const json = await res.json()
    const badgeEditions: any[] = json.editions ?? []

    // Build lookup: "playerNameNormalized::seriesNumber" → best BadgeInfo
    // series_number in badge_editions matches the on-chain series int in wallet rows
    const badgeMap = new Map<string, BadgeInfo>()

    for (const edition of badgeEditions) {
      if (!edition.player_name || edition.series_number == null) continue

      const key = `${edition.player_name.toLowerCase().trim()}::${edition.series_number}`
      const existing = badgeMap.get(key)

      // Keep highest badge_score entry per player+series combo
      if (!existing || edition.badge_score > existing.badge_score) {
        badgeMap.set(key, {
          badge_score:        edition.badge_score,
          badge_titles:       (edition.badge_titles ?? []).filter((t: string) => BADGE_PILL_TITLES.has(t)),
          is_three_star_rookie: edition.is_three_star_rookie,
          has_rookie_mint:    edition.has_rookie_mint,
          burn_rate_pct:      edition.burn_rate_pct,
          lock_rate_pct:      edition.lock_rate_pct,
          low_ask:            edition.low_ask,
          circulation_count:  edition.circulation_count,
        })
      }
    }

    // Merge: match each wallet row by playerName + series (on-chain int)
    return rowsIn.map(row => {
      const seriesNum = typeof row.series === "string"
        ? parseInt(row.series, 10)
        : row.series

      if (seriesNum == null || isNaN(seriesNum as number)) {
        return { ...row, badgeInfo: null }
      }

      const key = `${row.playerName?.toLowerCase().trim()}::${seriesNum}`
      const badgeInfo = badgeMap.get(key) ?? null
      return { ...row, badgeInfo }
    })
  } catch {
    return rowsIn
  }
}

// ── Main component ────────────────────────────────────────────────────────────

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
  const [badgeFilter, setBadgeFilter] = useState(false)

  const [teamFilter, setTeamFilter] = useState("all")
  const [leagueFilter, setLeagueFilter] = useState("all")
  const [rarityFilter, setRarityFilter] = useState("all")
  const [parallelFilter, setParallelFilter] = useState("all")
  const [lockedFilter, setLockedFilter] = useState("all")
  const [searchWithin, setSearchWithin] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("fmv")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")

  async function enrichWithMarket(rowsIn: MomentRow[]) {
    return rowsIn
  }

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
    if (!response.ok) throw new Error(json.error || "market-truth failed")

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
    if (!response.ok) throw new Error(json.error || "Wallet search failed")

    const nextRows = Array.isArray(json.rows) ? json.rows : []

    const enriched  = await enrichWithMarket(nextRows)
    const hydrated  = await hydrateMarket(enriched)
    const withBadges = await enrichWithBadges(hydrated)

    setRows((prev) => (append ? [...prev, ...withBadges] : withBadges))
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

  // ── Derived state ─────────────────────────────────────────────────────────

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
      if (badgeFilter && !r.badgeInfo?.badge_score) return false

      if (q) {
        const haystack = [
          r.playerName,
          r.team ?? "",
          r.league ?? "",
          seriesLabel(r.series),
          r.setName,
          parallel,
          r.tier ?? "",
          ...(r.officialBadges ?? []),
          ...(r.badgeInfo?.badge_titles ?? []),
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
        case "player":  result = compareText(a.playerName, b.playerName); break
        case "series":
          result = compareNumber(
            typeof a.series === "string" ? parseInt(a.series) : a.series,
            typeof b.series === "string" ? parseInt(b.series) : b.series
          ); break
        case "set":     result = compareText(a.setName, b.setName); break
        case "parallel":result = compareText(getParallel(a), getParallel(b)); break
        case "rarity":  result = compareText(a.tier, b.tier); break
        case "serial":  result = compareNumber(getSerial(a), getSerial(b)); break
        case "fmv":     result = compareNumber(a.fmv, b.fmv); break
        case "bestOffer":result = compareNumber(a.bestOffer, b.bestOffer); break
        case "badge":   result = compareNumber(a.badgeInfo?.badge_score, b.badgeInfo?.badge_score); break
        case "held":
          result = compareNumber(
            a.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(a))?.owned,
            b.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(b))?.owned
          ); break
      }
      return sortDirection === "asc" ? result : -result
    })

    return filtered
  }, [
    rows, searchWithin, teamFilter, leagueFilter, rarityFilter,
    parallelFilter, lockedFilter, badgeFilter, sortKey, sortDirection, batchEditionStats,
  ])

  const totals = useMemo(() => {
    let totalFmv = 0, totalBestOffer = 0, lockedFmv = 0, unlockedFmv = 0
    let lockedCount = 0, unlockedCount = 0, badgeCount = 0

    for (const row of filteredRows) {
      const fmv = row.fmv ?? null
      const offer = row.bestOffer ?? null
      const locked = getLocked(row)
      if (typeof fmv === "number") totalFmv += fmv
      if (typeof offer === "number") totalBestOffer += offer
      const value = fmv ?? offer ?? getBestAsk(row) ?? 0
      if (locked) { lockedFmv += value; lockedCount++ }
      else { unlockedFmv += value; unlockedCount++ }
      if (row.badgeInfo?.badge_score) badgeCount++
    }

    return {
      totalFmv, totalBestOffer, lockedFmv, unlockedFmv,
      totalCount: filteredRows.length, lockedCount, unlockedCount,
      spreadGap: totalFmv - totalBestOffer, badgeCount,
    }
  }, [filteredRows])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

        {/* Header */}
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
          <div className="ml-auto flex gap-2">
            <a href="/packs"   className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Packs</a>
            <a href="/sniper"  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sniper</a>
            <a href="/sets"    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sets</a>
            <a href="/badges"  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
          </div>
        </div>

        {/* Search + top stat cards */}
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

        {/* Second stat row */}
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
          <div
            className={`cursor-pointer rounded-xl border p-3 transition ${
              badgeFilter
                ? "border-red-600 bg-red-950/30"
                : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
            }`}
            onClick={() => setBadgeFilter(f => !f)}
            title="Click to show only badge-carrying moments"
          >
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">Badge Moments</div>
            <div className="text-lg font-bold text-white">{totals.badgeCount}</div>
            {badgeFilter && <div className="mt-0.5 text-[10px] text-red-400">Filtered ✕</div>}
          </div>
        </div>

        {/* Filters */}
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <select value={teamFilter}    onChange={(e) => setTeamFilter(e.target.value)}    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableTeams.map((t) => <option key={t} value={t}>{t === "all" ? "All Teams" : t}</option>)}
          </select>
          <select value={leagueFilter}  onChange={(e) => setLeagueFilter(e.target.value)}  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableLeagues.map((l) => <option key={l} value={l}>{l === "all" ? "All Leagues" : l}</option>)}
          </select>
          <select value={rarityFilter}  onChange={(e) => setRarityFilter(e.target.value)}  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableRarities.map((r) => <option key={r} value={r}>{r === "all" ? "All Rarities" : r}</option>)}
          </select>
          <select value={parallelFilter} onChange={(e) => setParallelFilter(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
            {availableParallels.map((p) => <option key={p} value={p}>{p === "all" ? "All Parallels" : p}</option>)}
          </select>
          <select value={lockedFilter}  onChange={(e) => setLockedFilter(e.target.value)}  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white">
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

        {/* Sort buttons */}
        <div className="mb-4 flex flex-wrap gap-2">
          {(["player","series","set","parallel","rarity","serial","held","fmv","bestOffer","badge"] as SortKey[]).map(key => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={`rounded-lg border px-3 py-1 text-sm hover:bg-zinc-900 ${sortKey === key ? "border-red-600 text-white" : "border-zinc-700"}`}
            >
              {key === "bestOffer" ? "Best Offer" : key === "badge" ? "Badge Score" : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
          <button onClick={() => setShowDebug(p => !p)} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">
            {showDebug ? "Hide Debug" : "Show Debug"}
          </button>
          <button onClick={copySeedCandidates} className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-900">
            Copy Seed Candidates
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300">{error}</div>
        )}

        {/* Debug table */}
        {showDebug && (
          <div className="mb-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
            <table className="w-full min-w-[1900px] border-collapse text-xs">
              <thead className="bg-zinc-900">
                <tr className="border-b border-zinc-800 text-left">
                  <th className="p-2">Player</th>
                  <th className="p-2">Edition Key</th>
                  <th className="p-2">Series</th>
                  <th className="p-2">Parallel</th>
                  <th className="p-2">Scope Key</th>
                  <th className="p-2">Held</th>
                  <th className="p-2">Locked</th>
                  <th className="p-2">Badge Score</th>
                  <th className="p-2">Badges</th>
                  <th className="p-2">TS Ask</th>
                  <th className="p-2">Flowty Ask</th>
                  <th className="p-2">Row Low Ask</th>
                  <th className="p-2">Row Offer</th>
                  <th className="p-2">Edition Low Ask</th>
                  <th className="p-2">Edition Offer</th>
                  <th className="p-2">Last Sale</th>
                  <th className="p-2">FMV</th>
                  <th className="p-2">FMV Method</th>
                  <th className="p-2">Confidence</th>
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
                    owned:  row.editionsOwned  ?? batchEditionStats.get(scopeKey)?.owned  ?? 0,
                    locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0,
                  }
                  return (
                    <tr key={`debug-${row.momentId}`} className="border-b border-zinc-800">
                      <td className="p-2">{row.playerName}</td>
                      <td className="p-2">{row.editionKey ?? "-"}</td>
                      <td className="p-2">{seriesLabel(row.series)}</td>
                      <td className="p-2">{getParallel(row)}</td>
                      <td className="p-2">{scopeKey}</td>
                      <td className="p-2">{counts.owned}</td>
                      <td className="p-2">{counts.locked}</td>
                      <td className="p-2">{row.badgeInfo?.badge_score ?? "-"}</td>
                      <td className="p-2">{row.badgeInfo?.badge_titles?.join(", ") ?? "-"}</td>
                      <td className="p-2">{formatCurrency(row.topshotAsk)}</td>
                      <td className="p-2">{formatCurrency(row.flowtyAsk)}</td>
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
        )}

        {/* Main table */}
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
                  owned:  row.editionsOwned  ?? batchEditionStats.get(scopeKey)?.owned  ?? 0,
                  locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0,
                }

                const expanded      = !!expandedRows[row.momentId]
                const primaryBadge  = getPrimarySerialBadge(row)
                const supaBadges    = (row.badgeInfo?.badge_titles ?? []).filter(t => BADGE_PILL_TITLES.has(t))
                const officialBadges = row.officialBadges ?? []

                return (
                  <Fragment key={row.momentId}>
                    <tr className="border-b border-zinc-800 align-top">
                      {/* Player + badge pills */}
                      <td className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="h-14 w-14 overflow-hidden rounded-lg border border-zinc-800 bg-black shrink-0">
                            {row.thumbnailUrl && (
                              <img src={row.thumbnailUrl} alt={row.playerName} className="h-full w-full object-cover" />
                            )}
                          </div>
                          <div>
                            <div className="font-semibold text-white">{row.playerName}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {officialBadges.map((badge) => (
                                <span key={`official-${badge}`} className={`rounded px-2 py-0.5 text-[10px] font-semibold ${badgeClass(badge)}`}>
                                  {badge}
                                </span>
                              ))}
                              {supaBadges.map((title) => (
                                <span key={`supa-${title}`} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${supaBadgePillClass(title)}`}>
                                  {title}
                                </span>
                              ))}
                              {row.badgeInfo?.is_three_star_rookie && row.badgeInfo?.has_rookie_mint && (
                                <span className="rounded bg-yellow-950 px-1.5 py-0.5 text-[10px] font-bold text-yellow-300 border border-yellow-700">
                                  ⭐ 3-Star
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Series — proper label */}
                      <td className="p-3 text-zinc-300">{seriesLabel(row.series)}</td>

                      <td className="p-3">{normalizeSetName(row.setName)}</td>
                      <td className="p-3">{getParallel(row)}</td>
                      <td className="p-3">{row.tier ?? "—"}</td>

                      {/* Serial */}
                      <td className="p-3">
                        <div className={`inline-flex min-w-[90px] flex-col rounded-lg border px-2 py-1 ${
                          primaryBadge ? "border-red-700 bg-red-950/50" : "border-zinc-800 bg-black"
                        }`}>
                          <div className={`text-base font-black ${primaryBadge ? "text-red-300" : "text-white"}`}>
                            #{getSerial(row) ?? "-"}
                          </div>
                          <div className="text-xs text-zinc-400">/ {getMint(row) ?? "-"}</div>
                          {primaryBadge && (
                            <div className="mt-1 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-black">
                              {primaryBadge}
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="p-3">{editionCounts.owned} / {editionCounts.locked}</td>
                      <td className="p-3 font-semibold text-white">{formatCurrency(row.fmv)}</td>
                      <td className="p-3">{formatCurrency(row.bestOffer)}</td>

                      <td className="p-3">
                        <button
                          onClick={() => toggleExpanded(row.momentId)}
                          className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-900"
                        >
                          {expanded ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>

                    {expanded && (
                      <tr className="border-b border-zinc-800 bg-black/60">
                        <td colSpan={10} className="p-4">
                          <div className="grid gap-4 md:grid-cols-4">

                            {/* Market */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Market</div>
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

                            {/* Links */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Links</div>
                              <div className="space-y-2">
                                <a href={`https://nbatopshot.com/moment/${row.momentId}`} target="_blank" rel="noopener noreferrer"
                                  className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">
                                  View on Top Shot
                                </a>
                                {row.flowtyListingUrl ? (
                                  <a href={`/out/flowty/${row.momentId}?source=wallet-expand&priceAtClick=${row.flowtyAsk ?? ""}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">
                                    View on Flowty {row.flowtyAsk ? `(${formatCurrency(row.flowtyAsk)})` : ""}
                                  </a>
                                ) : (
                                  <a href={`https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${row.momentId}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-500 hover:bg-zinc-900">
                                    Check Flowty
                                  </a>
                                )}
                              </div>
                            </div>

                            {/* Metadata */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Metadata</div>
                              <div className="space-y-1 text-sm">
                                <div>Team: {row.team ?? "-"}</div>
                                <div>League: {row.league ?? "-"}</div>
                                <div>Series: {seriesLabel(row.series)}</div>
                                <div>Season: {seriesSeason(row.series) ?? "-"}</div>
                                <div>Parallel: {getParallel(row)}</div>
                                <div>Locked: {getLocked(row) ? "Yes" : "No"}</div>
                                <div className="flex flex-wrap gap-1 pt-1">
                                  {getTraits(row).map((trait) => (
                                    <span key={trait} className="rounded bg-red-950 px-2 py-0.5 text-[10px] text-red-300">{trait}</span>
                                  ))}
                                </div>
                              </div>
                            </div>

                            {/* Badge panel OR debug */}
                            {row.badgeInfo?.badge_score ? (
                              <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Badges</div>
                                <div className="space-y-1 text-sm">
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-400">Score</span>
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-[11px] font-black text-white">
                                      {row.badgeInfo.badge_score}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-1 pt-1">
                                    {(row.badgeInfo.badge_titles ?? []).filter(t => BADGE_PILL_TITLES.has(t)).map(title => (
                                      <span key={title} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${supaBadgePillClass(title)}`}>
                                        {title}
                                      </span>
                                    ))}
                                  </div>
                                  <div className="pt-1 text-xs text-zinc-500">
                                    <div>Burn rate: {row.badgeInfo.burn_rate_pct.toFixed(1)}%</div>
                                    <div>Lock rate: {row.badgeInfo.lock_rate_pct.toFixed(1)}%</div>
                                    <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>
                                    {row.badgeInfo.low_ask != null && (
                                      <div>Edition ask: {formatCurrency(row.badgeInfo.low_ask)}</div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Debug</div>
                                <div className="space-y-1 text-sm">
                                  <div>Edition Key: {row.editionKey ?? "-"}</div>
                                  <div>Scope Key: {scopeKey}</div>
                                  <div>Valuation: {row.valuationScope ?? "-"}</div>
                                  <div>Market Source: {row.marketSource ?? "-"}</div>
                                  <div>Reason: {debugReasonLabel(row.marketDebugReason)}</div>
                                  <div>Edition Source: {row.editionMarketSource ?? "-"}</div>
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {summary && summary.remainingMoments > 0 && (
          <div className="mt-6 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-50 hover:bg-red-500"
            >
              {loadingMore ? "Loading..." : `Load More (${summary.remainingMoments} left)`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}