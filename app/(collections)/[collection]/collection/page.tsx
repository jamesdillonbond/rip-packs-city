"use client"

import { Fragment, useMemo, useState, useEffect, useCallback, useRef, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  normalizeSetName,
  normalizeParallel,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketResult = {
  momentId: string
  fmv: number | null
  bestOffer: number | null
  lowAsk: number | null
  valuationScope: "Parallel" | "Edition" | "Modeled"
  isSpecialSerial: boolean
  debugReason: "OK" | "NO_LOW_ASK" | "NO_BEST_OFFER" | "NO_MARKET_INPUTS" | "SPECIAL_SERIAL_NO_BASE"
  normalizedParallel: string
  normalizedSetName: string
  scopeKey: string
  marketSource: "row" | "edition" | "row+edition" | "edition-sale" | "special-serial" | "none"
  fmvMethod: "band" | "low-ask-only" | "best-offer-only" | "edition-last-sale" | "special-serial-premium" | "none"
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
  series?: string
  tier?: string
  serialNumber?: number
  serial?: number
  mintCount?: number
  mintSize?: number
  jerseyNumber?: number | null
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
  acquiredAt?: string | null
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
  summary?: { totalMoments: number; returnedMoments: number; remainingMoments: number }
  error?: string
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
  "Rookie Year", "Rookie Premiere", "Top Shot Debut",
  "Rookie of the Year", "Rookie Mint", "Championship Year",
])

const SERIES_INT_TO_SEASON: Record<number, string> = {
  0: "2019-20", 1: "2019-20", 2: "2020-21", 3: "2021",
  4: "2021-22", 5: "2022-23", 6: "2023-24", 7: "2024-25", 8: "2025-26",
}

function seriesIntToSeason(seriesRaw: string | undefined | null): string {
  if (!seriesRaw) return ""
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && SERIES_INT_TO_SEASON[n] !== undefined) return SERIES_INT_TO_SEASON[n]
  if (/^\d{4}-\d{2}$/.test(seriesRaw.trim())) return seriesRaw.trim()
  if (/^\d{4}$/.test(seriesRaw.trim())) return seriesRaw.trim()
  return seriesRaw
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  return "$" + value.toFixed(2)
}

function formatCurrencyCompact(value: number): string {
  if (value >= 1000000) return "$" + (value / 1000000).toFixed(1) + "M"
  if (value >= 1000) return "$" + (value / 1000).toFixed(1) + "K"
  return "$" + value.toFixed(2)
}

function formatAcquiredAt(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const now = Date.now()
  const diff = now - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return days + "d ago"
  if (days < 30) return Math.floor(days / 7) + "w ago"
  if (days < 365) return Math.floor(days / 30) + "mo ago"
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
}

function compareText(a?: string | null, b?: string | null) { return (a ?? "").localeCompare(b ?? "") }
function compareNumber(a?: number | null, b?: number | null) { return (a ?? -1) - (b ?? -1) }
function getParallel(row: MomentRow) { return normalizeParallel(row.parallel ?? row.subedition ?? "") }
function getSerial(row: MomentRow) { return row.serialNumber ?? row.serial ?? null }
function getMint(row: MomentRow) { return row.mintCount ?? row.mintSize ?? null }
function getTraits(row: MomentRow) { return row.specialSerialTraits ?? row.traits ?? [] }
function getLocked(row: MomentRow) { return Boolean(row.isLocked ?? row.locked) }

function getBestAsk(row: MomentRow) {
  const values = [row.lowAsk, row.bestAsk, row.topshotAsk, row.flowtyAsk].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  )
  return values.length ? Math.min(...values) : null
}

function getPrimarySerialBadge(row: MomentRow) {
  const traits = getTraits(row)
  if (traits.includes("#1")) return "#1"
  if (traits.includes("Perfect Mint")) return "Perfect Mint"
  if (traits.includes("Jersey Match")) return "Jersey Match"
  return null
}

function badgeClass(name: string) {
  const l = name.toLowerCase()
  if (l.includes("rookie")) return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
  if (l.includes("debut")) return "bg-white text-black dark:bg-zinc-100 dark:text-black"
  if (l.includes("champ")) return "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-white"
  return "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
}

function supadgePillClass(title: string) {
  return BADGE_COLORS[title] ?? "bg-zinc-800 text-zinc-300 border border-zinc-700"
}

const BADGE_ICONS: Record<string, string> = {
  "Rookie Year":        "https://nbatopshot.com/img/momentTags/static/rookieYear.svg",
  "Rookie Premiere":    "https://nbatopshot.com/img/momentTags/static/rookiePremiere.svg",
  "Top Shot Debut":     "https://nbatopshot.com/img/momentTags/static/topShotDebut.svg",
  "Rookie of the Year": "https://nbatopshot.com/img/momentTags/static/rookieOfTheYear.svg",
  "Rookie Mint":        "https://nbatopshot.com/img/momentTags/static/rookieMint.svg",
  "Championship Year":  "https://nbatopshot.com/img/momentTags/static/championshipYear.svg",
}


function SerialBadge({ serial, mintSize, jerseyNumber }: { serial: number | undefined; mintSize: number | undefined; jerseyNumber: number | null | undefined }) {
  if (!serial) return null
  const tags: { label: string; title: string; color: string }[] = []
  if (serial === 1)
    tags.push({ label: "#1", title: "Serial #1", color: "bg-yellow-950 text-yellow-300 border border-yellow-700" })
  if (jerseyNumber && serial === jerseyNumber)
    tags.push({ label: "JM", title: "Jersey Match — #" + jerseyNumber, color: "bg-teal-950 text-teal-300 border border-teal-700" })
  if (mintSize && serial === mintSize)
    tags.push({ label: "PM", title: "Perfect Mint — #" + serial + "/" + mintSize, color: "bg-violet-950 text-violet-300 border border-violet-700" })
  if (tags.length === 0) return null
  return (
    <span className="flex gap-1 flex-wrap">
      {tags.map(tag => (
        <span key={tag.label} title={tag.title} className={"rounded px-1 py-0.5 text-[10px] font-bold " + tag.color}>
          {tag.label}
        </span>
      ))}
    </span>
  )
}
function BadgeIcon({ title, size = 20 }: { title: string; size?: number }) {
  const src = BADGE_ICONS[title]
  if (src) return (
    <img src={src} alt={title} title={title} width={size} height={size}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      onError={function(e) { (e.target as HTMLImageElement).style.display = "none" }} />
  )
  return <span className={"rounded px-1.5 py-0.5 text-[10px] font-semibold " + supadgePillClass(title)}>{title}</span>
}

function debugReasonLabel(reason?: string | null) {
  switch (reason) {
    case "OK": return "OK"
    case "NO_LOW_ASK": return "No low ask"
    case "NO_BEST_OFFER": return "No best offer"
    case "NO_MARKET_INPUTS": return "No market inputs"
    case "SPECIAL_SERIAL_NO_BASE": return "No serial base"
    default: return reason ?? "-"
  }
}

function confidenceLabel(conf?: string | null): { label: string; color: string } {
  switch (conf) {
    case "high":   return { label: "Liquid",   color: "text-emerald-400" }
    case "medium": return { label: "Trading",  color: "text-yellow-400" }
    case "low":    return { label: "Thin",     color: "text-orange-400" }
    case "none":   return { label: "Illiquid", color: "text-zinc-500" }
    default:       return { label: "—",        color: "text-zinc-600" }
  }
}

function fmvDisplay(row: MomentRow): { text: string; muted: boolean } {
  const fmv = row.fmv
  const conf = row.marketConfidence
  if (fmv === null || fmv === undefined || fmv === 0) return { text: "—", muted: true }
  const ask = getBestAsk(row)
  switch (conf) {
    case "high":   return { text: "$" + fmv.toFixed(2), muted: false }
    case "medium": return { text: "~$" + fmv.toFixed(2), muted: false }
    case "low":    return { text: "$" + Math.floor(fmv) + "–$" + Math.ceil(fmv * 1.15), muted: false }
    case "none":   return ask ? { text: "Floor $" + ask.toFixed(2), muted: true } : { text: "No data", muted: true }
    default:       return { text: "$" + fmv.toFixed(2), muted: false }
  }
}

type SortKey = "player" | "series" | "set" | "parallel" | "rarity" | "serial" | "fmv" | "bestOffer" | "held" | "badge" | "acquired"

// ── Auto-search reader ────────────────────────────────────────────────────────

function AutoSearchReader(props: { onSearch: (q: string) => void }) {
  const searchParams = useSearchParams()
  useEffect(function() {
    const address = searchParams.get("address")
    const q = searchParams.get("q")
    const query = address || q
    if (query && query.trim()) props.onSearch(query.trim())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WalletPage() {
  const router = useRouter()
  const lastSearchedRef = useRef("")
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
  const [hasSearched, setHasSearched] = useState(false)
  const [ownerKey, setOwnerKey] = useState("")
  const [sealedPackCount, setSealedPackCount] = useState<number | null>(null)
  const [recentSales, setRecentSales] = useState<any[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);

  const [teamFilter, setTeamFilter] = useState("all")
  const [leagueFilter, setLeagueFilter] = useState("all")
  const [rarityFilter, setRarityFilter] = useState("all")
  const [parallelFilter, setParallelFilter] = useState("all")
  const [lockedFilter, setLockedFilter] = useState("all")
  const [searchWithin, setSearchWithin] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("acquired")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")

  useEffect(function() {
    setOwnerKey(getOwnerKey())
    return onOwnerKeyChange(function(key) { setOwnerKey(key) })
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
      for (let i = 0; i < playerNames.length; i += CHUNK) {
        const chunk = playerNames.slice(i, i + CHUNK)
        const params = new URLSearchParams({
          mode: "all", sort: "badge_score", dir: "desc",
          limit: "500", offset: "0", players: chunk.join(","),
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
          })
        }
      }
      return rowsIn.map((row: MomentRow) => {
        const seriesNum = typeof row.series === "string"
          ? parseInt(row.series, 10)
          : (row.series as number | undefined)
        if (seriesNum == null || isNaN(seriesNum)) return { ...row, badgeInfo: null }
        const key = (row.playerName?.toLowerCase().trim() ?? "") + "::" + seriesNum
        return { ...row, badgeInfo: badgeMap.get(key) ?? null }
      })
    } catch {
      return rowsIn
    }
  }

  async function hydrateMarket(rowsIn: MomentRow[]) {
    if (!rowsIn.length) return rowsIn
    const response = await fetch("/api/market-truth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: rowsIn.map(function(row) {
          return {
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
          }
        }),
      }),
    })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error || "market-truth failed")
    const marketRows = Array.isArray(json.rows) ? (json.rows as MarketResult[]) : []
    const marketMap = new Map<string, MarketResult>()
    marketRows.forEach(function(r) { marketMap.set(String(r.momentId), r) })
    return rowsIn.map(function(row) {
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

  async function maybePatchProfileStats(query: string, resultRows: MomentRow[], resultSummary: WalletSearchResponse["summary"]) {
    const key = getOwnerKey()
    if (!key) return
    try {
      const res = await fetch("/api/profile/saved-wallets?ownerKey=" + encodeURIComponent(key))
      if (!res.ok) return
      const d = await res.json()
      const wallets: any[] = d.wallets ?? []
      const q = query.toLowerCase().trim()
      const matched = wallets.find(function(w) {
        return (w.username ?? "").toLowerCase() === q || (w.wallet_addr ?? "").toLowerCase() === q
      })
      if (!matched) return
      let totalFmv = 0
      for (const row of resultRows) {
        if (typeof row.fmv === "number") totalFmv += row.fmv
      }
      const momentCount = resultSummary?.totalMoments ?? resultRows.length
      await fetch("/api/profile/saved-wallets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey: key,
          walletAddr: matched.wallet_addr,
          cachedFmv: totalFmv,
          cachedMomentCount: momentCount,
        }),
      })
    } catch {}
  }

  const runSearch = useCallback(async function(query: string) {
    if (!query.trim()) return
    const trimmed = query.trim()
    setInput(trimmed)
    lastSearchedRef.current = trimmed
    // Persist address in URL for bookmarkability and sharing
    try { router.replace("?address=" + encodeURIComponent(trimmed), { scroll: false }) } catch {}
    setLoading(true)
    setError("")
    setRows([])
    setSummary(undefined)
    setOffset(0)
    setExpandedRows({})
    setHasSearched(false)
    setSealedPackCount(null)
    setRecentSales([]);
    setSalesLoading(true);
    fetch("/api/recent-sales?limit=15")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d && d.sales) setRecentSales(d.sales); })
      .catch(function() {})
      .finally(function() { setSalesLoading(false); });
    try {
      const response = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: query.trim(), offset: 0, limit: 50 }),
      })
      const json = (await response.json()) as WalletSearchResponse
      if (!response.ok) throw new Error(json.error || "Wallet search failed")
      const nextRows = Array.isArray(json.rows) ? json.rows : []
      const hydrated = await hydrateMarket(nextRows)
      const withBadges = await enrichWithBadges(hydrated)
      setRows(withBadges)
      setSummary(json.summary)
      setOffset(nextRows.length)
      setHasSearched(true)
      maybePatchProfileStats(query.trim(), withBadges, json.summary).catch(function() {})
      // Fire-and-forget: load sealed pack count for this wallet
      fetch("/api/wallet-packs?wallet=" + encodeURIComponent(query.trim()))
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) { if (d && typeof d.totalSealedPacks === "number") setSealedPackCount(d.totalSealedPacks) })
        .catch(function() {})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [])

  async function fetchWalletPage(nextOffset: number, append: boolean) {
    const response = await fetch("/api/wallet-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, offset: nextOffset, limit: 50 }),
    })
    const json = (await response.json()) as WalletSearchResponse
    if (!response.ok) throw new Error(json.error || "Wallet search failed")
    const nextRows = Array.isArray(json.rows) ? json.rows : []
    const hydrated = await hydrateMarket(nextRows)
    const withBadges = await enrichWithBadges(hydrated)
    setRows(function(prev) { return append ? [...prev, ...withBadges] : withBadges })
    setSummary(json.summary)
    setOffset(nextOffset + nextRows.length)
  }

  async function handleSearch() { await runSearch(input) }

  async function handleLoadMore() {
    setLoadingMore(true)
    setError("")
    try { await fetchWalletPage(offset, true) }
    catch (err) { setError(err instanceof Error ? err.message : "Something went wrong") }
    finally { setLoadingMore(false) }
  }

  function toggleSort(next: SortKey) {
    if (sortKey === next) { setSortDirection(function(prev) { return prev === "asc" ? "desc" : "asc" }) }
    else { setSortKey(next); setSortDirection("desc") }
  }

  function toggleExpanded(momentId: string) {
    setExpandedRows(function(prev) { return { ...prev, [momentId]: !prev[momentId] } })
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

  const batchEditionStats = useMemo(function() {
    const map = new Map<string, { owned: number; locked: number }>()
    for (const row of rows) {
      const key = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
      const current = map.get(key) ?? { owned: 0, locked: 0 }
      current.owned += 1
      if (getLocked(row)) current.locked += 1
      map.set(key, current)
    }
    return map
  }, [rows])

  const availableTeams = useMemo(function() {
    const set = new Set<string>()
    rows.forEach(function(r) { if (r.team) set.add(r.team) })
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableLeagues = useMemo(function() {
    const set = new Set<string>()
    rows.forEach(function(r) { if (r.league) set.add(r.league) })
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableRarities = useMemo(function() {
    const set = new Set<string>()
    rows.forEach(function(r) { if (r.tier) set.add(r.tier) })
    return ["all", ...Array.from(set).sort()]
  }, [rows])

  const availableParallels = useMemo(function() {
    const set = new Set<string>()
    rows.forEach(function(r) { const p = getParallel(r); if (p && p !== "Base") set.add(p) })
    return ["all", "Base", ...Array.from(set).sort()]
  }, [rows])

  const filteredRows = useMemo(function() {
    const q = searchWithin.trim().toLowerCase()
    const filtered = rows.filter(function(r) {
      const parallel = getParallel(r)
      if (teamFilter !== "all" && r.team !== teamFilter) return false
      if (leagueFilter !== "all" && r.league !== leagueFilter) return false
      if (rarityFilter !== "all" && r.tier !== rarityFilter) return false
      if (parallelFilter !== "all" && parallel !== parallelFilter) return false
      if (lockedFilter === "locked" && !getLocked(r)) return false
      if (lockedFilter === "unlocked" && getLocked(r)) return false
      if (badgeFilter && !r.badgeInfo?.badge_score) return false
      if (q) {
        const haystack = [r.playerName, r.team ?? "", r.league ?? "", r.series ?? "", r.setName, parallel, r.tier ?? "", ...(r.officialBadges ?? []), ...(r.badgeInfo?.badge_titles ?? []), ...getTraits(r)].join(" ").toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    filtered.sort(function(a, b) {
      let result = 0
      switch (sortKey) {
        case "player":    result = compareText(a.playerName, b.playerName); break
        case "series":    result = compareText(a.series, b.series); break
        case "set":       result = compareText(a.setName, b.setName); break
        case "parallel":  result = compareText(getParallel(a), getParallel(b)); break
        case "rarity":    result = compareText(a.tier, b.tier); break
        case "serial":    result = compareNumber(getSerial(a), getSerial(b)); break
        case "fmv":       result = compareNumber(a.fmv, b.fmv); break
        case "bestOffer": result = compareNumber(a.bestOffer, b.bestOffer); break
        case "badge":     result = compareNumber(a.badgeInfo?.badge_score, b.badgeInfo?.badge_score); break
        case "acquired": {
          const ta = a.acquiredAt ? new Date(a.acquiredAt).getTime() : 0
          const tb = b.acquiredAt ? new Date(b.acquiredAt).getTime() : 0
          result = ta - tb
          break
        }
        case "held":
          result = compareNumber(
            a.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(a))?.owned,
            b.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(b))?.owned
          ); break
      }
      return sortDirection === "asc" ? result : -result
    })
    return filtered
  }, [rows, searchWithin, teamFilter, leagueFilter, rarityFilter, parallelFilter, lockedFilter, badgeFilter, sortKey, sortDirection, batchEditionStats])

  const totals = useMemo(function() {
    let totalFmv = 0, totalBestOffer = 0, lockedFmv = 0, unlockedFmv = 0
    let lockedCount = 0, unlockedCount = 0, badgeCount = 0
    let confHigh = 0, confMedium = 0, confLow = 0, confNone = 0
    for (const row of filteredRows) {
      const fmv = row.fmv ?? null
      const offer = row.bestOffer ?? null
      const locked = getLocked(row)
      if (typeof fmv === "number") totalFmv += fmv
      if (typeof offer === "number") totalBestOffer += offer
      const value = fmv ?? offer ?? getBestAsk(row) ?? 0
      if (locked) { lockedFmv += value; lockedCount++ } else { unlockedFmv += value; unlockedCount++ }
      if (row.badgeInfo?.badge_score) badgeCount++
      switch (row.marketConfidence) {
        case "high": confHigh++; break
        case "medium": confMedium++; break
        case "low": confLow++; break
        default: confNone++; break
      }
    }
    return { totalFmv, totalBestOffer, lockedFmv, unlockedFmv, totalCount: filteredRows.length, lockedCount, unlockedCount, spreadGap: totalFmv - totalBestOffer, badgeCount, confHigh, confMedium, confLow, confNone }
  }, [filteredRows])

  const projectedFmv = useMemo(function() {
    const totalMoments = summary?.totalMoments ?? 0
    const loadedCount = rows.length
    if (!totalMoments || !loadedCount || loadedCount >= totalMoments) return null
    const rowsWithFmv = rows.filter(function(r) { return typeof r.fmv === "number" && r.fmv > 0 })
    if (!rowsWithFmv.length) return null
    const sumLoaded = rowsWithFmv.reduce(function(acc, r) { return acc + (r.fmv ?? 0) }, 0)
    return (sumLoaded / rowsWithFmv.length) * totalMoments
  }, [rows, summary])

  const loadProgress = summary
    ? { loaded: rows.length, total: summary.totalMoments, pct: Math.min(100, Math.round((rows.length / Math.max(1, summary.totalMoments)) * 100)) }
    : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <Suspense fallback={null}>
        <AutoSearchReader onSearch={runSearch} />
      </Suspense>

      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img src="/rip-packs-city-logo.png" alt="Rip Packs City" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 9999 }} />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">RIP PACKS CITY</h1>
            <p className="text-xs text-zinc-400 md:text-sm">Wallet intelligence for digital collectibles</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <a href="/profile" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Profile</a>
            <a href="/nba-top-shot/packs"   className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Packs</a>
            <a href="/nba-top-shot/badges"  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
            <a href="/nba-top-shot/sniper"  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sniper</a>
            <a href="/nba-top-shot/sets"    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Sets</a>
          </div>
        </div>

        {/* Profile key indicator */}
        {ownerKey && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            Signed in as <span className="font-semibold text-white">{ownerKey}</span>
            <span className="ml-1 text-zinc-600">· Loading wallet will update your profile stats</span>
          </div>
        )}

        {/* Search bar */}
        <div className="mb-5 flex gap-2">
          <input
            value={input}
            onChange={function(e) { setInput(e.target.value) }}
            onKeyDown={function(e) { if (e.key === "Enter" && !loading && input.trim()) handleSearch() }}
            placeholder={ownerKey ? "Enter Top Shot username or wallet address (or press Enter to load your wallet)" : "Enter Top Shot username or wallet address"}
            className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
          />
          <button
            onClick={handleSearch}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-red-600 px-5 py-2 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading..." : "Search"}
          </button>
        </div>

        {/* Portfolio summary */}
        {hasSearched && rows.length > 0 && (
          <div className="mb-5 space-y-3">
            <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">

              {/* Wallet FMV with projected estimate + load progress */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Wallet FMV</div>
                <div className="text-xl font-black text-white">
                  {formatCurrency(totals.totalFmv)}
                  {projectedFmv !== null && (
                    <span className="ml-2 text-sm font-normal text-zinc-500">
                      {"~" + formatCurrencyCompact(projectedFmv) + " est."}
                    </span>
                  )}
                </div>
                {loadProgress && loadProgress.total > loadProgress.loaded ? (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-[10px] text-zinc-600">
                      <span>{loadProgress.loaded} / {loadProgress.total} loaded</span>
                      <span>{loadProgress.pct}%</span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-zinc-800">
                      <div className="h-1 rounded-full bg-red-600 transition-all duration-300" style={{ width: loadProgress.pct + "%" }} />
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-zinc-500">{totals.totalCount} moments shown</div>
                )}
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Unlocked FMV</div>
                <div className="text-xl font-black text-white">{formatCurrency(totals.unlockedFmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{totals.unlockedCount} unlocked</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Locked FMV</div>
                <div className="text-xl font-black text-white">{formatCurrency(totals.lockedFmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{totals.lockedCount} locked</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Best Offer Total</div>
                <div className="text-xl font-black text-white">{formatCurrency(totals.totalBestOffer)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">Spread gap: {formatCurrency(totals.spreadGap)}</div>
              </div>
            </div>
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
              <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3">
                <div className="text-[10px] uppercase tracking-widest text-emerald-600">Liquid</div>
                <div className="text-lg font-black text-emerald-400">{totals.confHigh}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">High confidence FMV</div>
              </div>
              <div className="rounded-xl border border-yellow-900/50 bg-yellow-950/20 p-3">
                <div className="text-[10px] uppercase tracking-widest text-yellow-600">Trading</div>
                <div className="text-lg font-black text-yellow-400">{totals.confMedium}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Medium confidence FMV</div>
              </div>
              <div className="rounded-xl border border-orange-900/50 bg-orange-950/20 p-3">
                <div className="text-[10px] uppercase tracking-widest text-orange-600">Thin</div>
                <div className="text-lg font-black text-orange-400">{totals.confLow}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Low confidence FMV</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Illiquid</div>
                <div className="text-lg font-black text-zinc-500">{totals.confNone}</div>
                <div className="mt-0.5 text-[10px] text-zinc-600">Floor ask only</div>
              </div>
              <div
                className={"cursor-pointer rounded-xl border p-3 transition col-span-2 sm:col-span-1 " + (badgeFilter ? "border-red-600 bg-red-950/30" : "border-zinc-800 bg-zinc-950 hover:border-zinc-600")}
                onClick={function() { setBadgeFilter(function(f) { return !f }) }}
              >
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Badge Moments</div>
                <div className="text-lg font-black text-white">{totals.badgeCount}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">
                  {badgeFilter ? <span className="text-red-400">Filtered ✕</span> : "Click to filter"}
                </div>
              </div>
              <a
                href={"/nba-top-shot/packs?wallet=" + encodeURIComponent(input.trim())}
                className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 hover:border-zinc-600 transition col-span-2 sm:col-span-1 block"
              >
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Sealed Packs</div>
                <div className="text-lg font-black text-white">
                  {sealedPackCount === null ? <span className="text-zinc-600 text-sm font-normal">Loading...</span> : sealedPackCount}
                </div>
                <div className="mt-0.5 text-[10px] text-zinc-500">View in Packs →</div>
              </a>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-5 grid gap-2 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <select value={teamFilter} onChange={function(e) { setTeamFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableTeams.map(function(team) { return <option key={team} value={team}>{team === "all" ? "All Teams" : team}</option> })}
          </select>
          <select value={leagueFilter} onChange={function(e) { setLeagueFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableLeagues.map(function(league) { return <option key={league} value={league}>{league === "all" ? "All Leagues" : league}</option> })}
          </select>
          <select value={rarityFilter} onChange={function(e) { setRarityFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableRarities.map(function(tier) { return <option key={tier} value={tier}>{tier === "all" ? "All Rarities" : tier}</option> })}
          </select>
          <select value={parallelFilter} onChange={function(e) { setParallelFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableParallels.map(function(parallel) { return <option key={parallel} value={parallel}>{parallel === "all" ? "All Parallels" : parallel}</option> })}
          </select>
          <select value={lockedFilter} onChange={function(e) { setLockedFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            <option value="all">All Lock States</option>
            <option value="locked">Locked</option>
            <option value="unlocked">Unlocked</option>
          </select>
          <input value={searchWithin} onChange={function(e) { setSearchWithin(e.target.value) }} placeholder="Filter moments…" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-500 col-span-2 sm:col-span-1" />
        </div>

        {/* Sort buttons */}
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {([
            ["acquired", "Recent"],
            ["fmv", "FMV"],
            ["player", "Player"],
            ["series", "Series"],
            ["set", "Set"],
            ["parallel", "Parallel"],
            ["rarity", "Rarity"],
            ["serial", "Serial"],
            ["held", "Held"],
            ["bestOffer", "Best Offer"],
            ["badge", "Badge"],
          ] as [SortKey, string][]).map(function([key, label]) {
            return (
              <button key={key} onClick={function() { toggleSort(key) }} className={"shrink-0 rounded-lg border px-3 py-1 text-sm hover:bg-zinc-900 " + (sortKey === key ? "border-red-600 text-white" : "border-zinc-700 text-zinc-400")}>
                {label}{sortKey === key && <span className="ml-1 text-zinc-500">{sortDirection === "asc" ? "↑" : "↓"}</span>}
              </button>
            )
          })}
          <button onClick={function() { setShowDebug(function(prev) { return !prev }) }} className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-900">{showDebug ? "Hide Debug" : "Debug"}</button>
          <button onClick={copySeedCandidates} className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-900">Copy Seeds</button>
        </div>

        {error ? <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300 text-sm">{error}</div> : null}

        {/* Debug table */}
        {showDebug ? (
          <div className="mb-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
            <table className="w-full min-w-[2000px] border-collapse text-xs">
              <thead className="bg-zinc-900">
                <tr className="border-b border-zinc-800 text-left">
                  {["Player","Series (raw)","Season","Acquired","Edition Key","Parallel","Scope Key","Held","Locked","Badge Score","Badges","TS Ask","Flowty Ask","Best Market","Row Low Ask","Row Offer","Edition Low Ask","Edition Offer","Last Sale","FMV","FMV Method","Confidence","Reason"].map(function(h) { return <th key={h} className="p-2 whitespace-nowrap">{h}</th> })}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 50).map(function(row) {
                  const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
                  const counts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
                  return (
                    <tr key={"debug-" + row.momentId} className="border-b border-zinc-800">
                      <td className="p-2">{row.playerName}</td>
                      <td className="p-2">{row.series ?? "-"}</td>
                      <td className="p-2">{seriesIntToSeason(row.series)}</td>
                      <td className="p-2">{row.acquiredAt ? new Date(row.acquiredAt).toLocaleDateString() : "-"}</td>
                      <td className="p-2">{row.editionKey ?? "-"}</td>
                      <td className="p-2">{getParallel(row)}</td>
                      <td className="p-2">{scopeKey}</td>
                      <td className="p-2">{counts.owned}</td>
                      <td className="p-2">{counts.locked}</td>
                      <td className="p-2">{row.badgeInfo?.badge_score ?? "-"}</td>
                      <td className="p-2">{row.badgeInfo?.badge_titles?.join(", ") ?? "-"}</td>
                      <td className="p-2">{formatCurrency(row.topshotAsk)}</td>
                      <td className="p-2">{formatCurrency(row.flowtyAsk)}</td>
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

        {/* Main table */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead className="bg-zinc-900">
              <tr className="border-b border-zinc-800 text-left">
                <th className="p-3">Player</th>
                <th className="p-3 hidden sm:table-cell">Series</th>
                <th className="p-3">Set</th>
                <th className="p-3 hidden md:table-cell">Parallel</th>
                <th className="p-3 hidden md:table-cell">Rarity</th>
                <th className="p-3">Serial / Mint</th>
                <th className="p-3 hidden lg:table-cell">Held / Locked</th>
                <th className="p-3">FMV</th>
                <th className="p-3 hidden lg:table-cell">Best Offer</th>
                <th className="p-3 hidden xl:table-cell">Acquired</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(function(row) {
                const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
                const editionCounts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
                const expanded = !!expandedRows[row.momentId]
                const primaryBadge = getPrimarySerialBadge(row)
                const supaBadges = (row.badgeInfo?.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) })
                const officialBadges = row.officialBadges ?? []
                const fmv = fmvDisplay(row)
                const conf = confidenceLabel(row.marketConfidence)
                const isLocked = getLocked(row)

                return (
                  <Fragment key={row.momentId}>
                    <tr className={"border-b border-zinc-800 align-top " + (isLocked ? "opacity-60" : "") + (row.tier?.toUpperCase() === "LEGENDARY" ? " rpc-holo-legendary" : row.tier?.toUpperCase() === "ULTIMATE" ? " rpc-holo-ultimate" : row.tier?.toUpperCase() === "RARE" ? " rpc-holo-rare" : "")}>
                      <td className="p-3">
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {row.thumbnailUrl ? (
                            <img
                              src={row.thumbnailUrl}
                              alt=""
                              width={36}
                              height={36}
                              loading="lazy"
                              style={{ borderRadius: 4, objectFit: "cover", flexShrink: 0, background: "#1a1a1a" }}
                            />
                          ) : (
                            <div style={{ width: 36, height: 36, borderRadius: 4, background: "#1a1a1a", flexShrink: 0 }} />
                          )}
                          <div>
                            <div className="font-semibold text-white text-sm">{row.playerName}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {officialBadges.map(function(badge) { return <span key={"official-" + badge} className={"rounded px-1.5 py-0.5 text-[10px] font-semibold " + badgeClass(badge)}>{badge}</span> })}
                              {supaBadges.map(function(title) { return <BadgeIcon key={"supa-" + title} title={title} size={20} /> })}
                              {row.badgeInfo?.is_three_star_rookie && row.badgeInfo?.has_rookie_mint && (
                                <img src="https://nbatopshot.com/img/momentTags/static/threeStars.svg"
                                  alt="Three-Star Rookie" title="Three-Star Rookie"
                                  width={20} height={20}
                                  style={{ display: "inline-block", verticalAlign: "middle" }} />
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-zinc-400 text-sm hidden sm:table-cell">{row.series ?? "—"}</td>
                      <td className="p-3 text-sm">{normalizeSetName(row.setName)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{getParallel(row)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{row.tier ?? "—"}</td>
                      <td className="p-3">
                        <div className={"inline-flex min-w-[80px] flex-col rounded-lg border px-2 py-1 " + (primaryBadge ? "border-red-700 bg-red-950/50" : "border-zinc-800 bg-black")}>
                          <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} />
                          <div className={"text-sm font-black " + (primaryBadge ? "text-red-300" : "text-white")}>{"#" + (getSerial(row) ?? "-")}</div>
                          <div className="text-xs text-zinc-400">{"/ " + (getMint(row) ?? "-")}</div>
                          {primaryBadge ? <div className="mt-1 rounded bg-white px-1 py-0.5 text-[9px] font-bold text-black">{primaryBadge}</div> : null}
                        </div>
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        {editionCounts.owned} / {editionCounts.locked}
                        {isLocked && <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Locked</span>}
                      </td>
                      <td className="p-3">
                        <div className={"font-semibold text-sm " + (fmv.muted ? "text-zinc-500" : "text-white")}>{fmv.text}</div>
                        <div className={"text-[10px] " + conf.color}>{conf.label}</div>
                      </td>
                      <td className="p-3 text-zinc-300 text-sm hidden lg:table-cell">{formatCurrency(row.bestOffer)}</td>
                      <td className="p-3 text-zinc-500 text-xs hidden xl:table-cell">{formatAcquiredAt(row.acquiredAt)}</td>
                      <td className="p-3">
                        <button onClick={function() { toggleExpanded(row.momentId) }} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-white hover:bg-zinc-900">
                          {expanded ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr className="border-b border-zinc-800 bg-black/60">
                        <td colSpan={11} className="p-4">
                          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Market</div>
                              <div className="space-y-1 text-sm">
                                <div>Top Shot Ask: {formatCurrency(row.topshotAsk)}</div>
                                <div>Flowty Ask: {formatCurrency(row.flowtyAsk)}</div>
                                <div>Best Ask: {formatCurrency(getBestAsk(row))}</div>
                                <div>Best Market: {row.bestMarket ?? "-"}</div>
                                <div>Best Offer: {formatCurrency(row.bestOffer)}</div>
                                <div>FMV: {fmv.text}</div>
                                <div>FMV Method: {row.fmvMethod ?? "-"}</div>
                                <div className={"font-medium " + conf.color}>Confidence: {conf.label}</div>
                              </div>
                            </div>
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Links</div>
                              <div className="space-y-2">
                                <a href={"https://nbatopshot.com/moment/" + row.momentId} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">View on Top Shot</a>
                                {row.flowtyListingUrl ? (
                                  <a href={"/out/flowty/" + row.momentId + "?source=wallet-expand&priceAtClick=" + (row.flowtyAsk ?? "")} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">
                                    {"View on Flowty" + (row.flowtyAsk ? " (" + formatCurrency(row.flowtyAsk) + ")" : "")}
                                  </a>
                                ) : (
                                  <a href={"https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/" + row.momentId} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-500 hover:bg-zinc-900">Check Flowty</a>
                                )}
                                {summary && (
                                  <a href={"/nba-top-shot/sets?wallet=" + encodeURIComponent(input.trim())} className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-400 hover:bg-zinc-900">View Set Progress →</a>
                                )}
                                <a href={"/profile?pin=" + row.momentId} className="block rounded-lg border border-yellow-800 bg-yellow-950/30 px-3 py-1.5 text-center text-xs font-semibold text-yellow-400 hover:bg-yellow-950/60">⭐ Pin to Trophy Case</a>
                              </div>
                            </div>
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Metadata</div>
                              <div className="space-y-1 text-sm">
                                <div>Team: {row.team ?? "-"}</div>
                                <div>League: {row.league ?? "-"}</div>
                                <div>Parallel: {getParallel(row)}</div>
                                <div>Series: {row.series ?? "-"} ({seriesIntToSeason(row.series) || "—"})</div>
                                <div>Acquired: {formatAcquiredAt(row.acquiredAt)}</div>
                                <div>Locked: {isLocked ? "Yes" : "No"}</div>
                                <div className="flex flex-wrap gap-1 pt-1">
                                  {getTraits(row).map(function(trait) { return <span key={trait} className="rounded bg-red-950 px-2 py-0.5 text-[10px] text-red-300">{trait}</span> })}
                                </div>
                              </div>
                            </div>
                            {row.badgeInfo?.badge_score ? (
                              <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Badges</div>
                                <div className="space-y-1 text-sm">
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-400">Score</span>
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-[11px] font-black text-white">{row.badgeInfo.badge_score}</span>
                                  </div>
                                  <div className="flex flex-wrap gap-1 pt-1">
                                    {(row.badgeInfo.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) }).map(function(title) {
                                      return <BadgeIcon key={title} title={title} size={24} />
                                    })}
                                  </div>
                                  <div className="pt-1 text-xs text-zinc-500">
                                    <div>Burn rate: {row.badgeInfo.burn_rate_pct.toFixed(1)}%</div>
                                    <div>Lock rate: {row.badgeInfo.lock_rate_pct.toFixed(1)}%</div>
                                    <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>
                                    {row.badgeInfo.low_ask != null && <div>Edition ask: {formatCurrency(row.badgeInfo.low_ask)}</div>}
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
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {summary && summary.remainingMoments > 0 ? (
          <div className="mt-6 flex justify-center">
            <button onClick={handleLoadMore} disabled={loadingMore} className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-50 hover:bg-red-500">
              {loadingMore ? "Loading..." : "Load More (" + summary.remainingMoments + " left)"}
            </button>
          </div>
        ) : null}
      </div>
        {/* Recent Sales */}
        {hasSearched && (recentSales.length > 0 || salesLoading) && (
          <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Recent Flowty Sales</div>
              <div className="text-[10px] text-zinc-600">{recentSales.length} sales</div>
            </div>
            {salesLoading ? (
              <div className="text-xs text-zinc-600">Loading sales history…</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left pb-2 text-zinc-500 font-medium">Player</th>
                      <th className="text-right pb-2 text-zinc-500 font-medium">Serial</th>
                      <th className="text-right pb-2 text-zinc-500 font-medium">Price</th>
                      <th className="text-right pb-2 text-zinc-500 font-medium">vs FMV</th>
                      <th className="text-right pb-2 text-zinc-500 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {recentSales.map(function(s: any, i: number) {
                      const pct = s.fmv && s.fmv > 0 ? Math.round(((s.price - s.fmv) / s.fmv) * 100) : null;
                      const age = s.soldAt ? Math.round((Date.now() - new Date(s.soldAt).getTime()) / 60000) : null;
                      const ageStr = age === null ? "—" : age < 60 ? age + "m ago" : age < 1440 ? Math.round(age/60) + "h ago" : Math.round(age/1440) + "d ago";
                      return (
                        <tr key={i} className="hover:bg-zinc-900/50">
                          <td className="py-1.5 pr-3">
                            <div className="font-medium text-zinc-200">{s.playerName ?? "—"}</div>
                            <div className="text-zinc-600">{s.setName ?? ""}</div>
                          </td>
                          <td className="py-1.5 text-right text-zinc-400">#{s.serialNumber}</td>
                          <td className="py-1.5 text-right font-semibold text-emerald-400">{s.price ? "$" + Number(s.price).toFixed(2) : "—"}</td>
                          <td className="py-1.5 text-right">
                            {pct !== null ? (
                              <span className={"font-semibold " + (pct >= 0 ? "text-emerald-400" : "text-red-400")}>{pct >= 0 ? "+" : ""}{pct}%</span>
                            ) : <span className="text-zinc-600">—</span>}
                          </td>
                          <td className="py-1.5 text-right text-zinc-500">{ageStr}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
    </div>
  )
}