"use client"

import { Fragment, useMemo, useState, useEffect, useCallback, useRef, Suspense } from "react"
import { useSearchParams, useRouter, useParams } from "next/navigation"
import {
  normalizeSetName,
  normalizeParallel,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"
import { getCollection } from "@/lib/collections"

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
  topshotAsk?: number | null
  flowtyAsk?: number | null
  fmvUsd?: number | null
  fmvConfidence?: string | null
  fmvComputedAt?: string | null
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
  fmvComputedAt?: string | null
  tssPoints?: number | null
  badgeInfo?: BadgeInfo | null
  editionOffer?: number | null
  bestOfferType?: "edition" | "serial" | null
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
  0: "2019-20", 1: "2019-20", 2: "2020-21", 3: "2021-22",
  4: "2022-23", 5: "2023-24", 6: "2024-25", 7: "2025-26", 8: "2026-27",
}

const SERIES_DISPLAY: Record<number, string> = {
  0: "Beta",
  1: "S1 · 2019-20",
  2: "S2 · 2020-21",
  3: "S3 · 2021-22",
  4: "S4 · 2022-23",
  5: "S5 · 2023-24",
  6: "S6 · 2024-25",
  7: "S7 · 2025-26",
  8: "S8 · 2026-27",
}

function seriesDisplayLabel(seriesRaw: string | undefined | null): string {
  if (!seriesRaw) return "—"
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && SERIES_DISPLAY[n] !== undefined) return SERIES_DISPLAY[n]
  return seriesRaw
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
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0
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

type SortKey = "player" | "series" | "set" | "parallel" | "rarity" | "serial" | "fmv" | "tss" | "bestOffer" | "held" | "badge" | "acquired"

// ── Edition Recent Sales (inline in expand panel) ────────────────────────────

function EditionRecentSales({ editionKey, mintCount }: { editionKey: string | null; mintCount?: number | null }) {
  const [sales, setSales] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(function() {
    if (!editionKey) { setLoading(false); return }
    fetch("/api/recent-sales?editionKey=" + encodeURIComponent(editionKey) + "&limit=5")
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(d) { if (d && d.sales) setSales(d.sales) })
      .catch(function() {})
      .finally(function() { setLoading(false) })
  }, [editionKey])

  if (!editionKey) return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Sales</div>
      <div className="text-xs text-zinc-600">—</div>
    </div>
  )

  if (loading) return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Sales</div>
      <div className="text-xs text-zinc-600 animate-pulse">Loading sales...</div>
    </div>
  )

  if (!sales.length) return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Sales</div>
      <div className="text-xs text-zinc-600">No recent sales</div>
    </div>
  )

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Sales</div>
      <div className="space-y-1.5">
        {sales.map(function(s: any, i: number) {
          const age = s.soldAt ? Math.round((Date.now() - new Date(s.soldAt).getTime()) / 60000) : null
          const ageStr = age === null ? "—" : age < 60 ? age + "m ago" : age < 1440 ? Math.round(age / 60) + "h ago" : Math.round(age / 1440) + "d ago"
          const serialStr = s.serialNumber ? ("#" + s.serialNumber + (mintCount ? " / " + mintCount : "")) : "—"
          return (
            <div key={i} className="flex items-center justify-between text-xs gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-zinc-400 shrink-0">{serialStr}</span>
                <span className="text-zinc-600 shrink-0">{ageStr}</span>
                {s.buyerUsername && <span className="text-zinc-500 truncate">→ {s.buyerUsername}</span>}
              </div>
              <span className="font-semibold text-emerald-400 shrink-0">{s.price ? "$" + Number(s.price).toFixed(2) : "—"}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Auto-search reader ────────────────────────────────────────────────────────

function AutoSearchReader(props: { onSearch: (q: string) => void }) {
  const searchParams = useSearchParams()
  useEffect(function() {
    // Support both ?address= (preferred) and legacy ?q= param
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
  const routeParams = useParams()
  const collectionSlug = (routeParams?.collection as string) ?? "nba-top-shot"
  const collectionObj = getCollection(collectionSlug)
  const accent = collectionObj?.accent ?? "#E03A2F"
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
  const [packsByTitle, setPacksByTitle] = useState<Record<string, number>>({})
  const [recentSales, setRecentSales] = useState<any[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  const [backgroundProgress, setBackgroundProgress] = useState(0);

  const [playerFilter, setPlayerFilter] = useState("all")
  const [setFilter, setSetFilter] = useState("all")
  const [seriesFilter, setSeriesFilter] = useState("all")
  const [rarityFilter, setRarityFilter] = useState("all")
  const [lockedFilter, setLockedFilter] = useState("all")
  const [searchWithin, setSearchWithin] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("fmv")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [filterBadges, setFilterBadges] = useState(false)
  const [filterHasOffer, setFilterHasOffer] = useState(false)
  const [filterListed, setFilterListed] = useState(false)
  const [setsData, setSetsData] = useState<{ sets: any[] } | null>(null)

  // Hydrate filter state from localStorage on mount
  useEffect(function() {
    try {
      var stored = function(key: string) { return localStorage.getItem("rpc_collection_" + key) }
      var sk = stored("sortKey")
      if (sk) setSortKey(JSON.parse(sk) as SortKey)
      var sd = stored("sortDirection")
      if (sd) setSortDirection(JSON.parse(sd) as "asc" | "desc")
      var pf = stored("playerFilter")
      if (pf) setPlayerFilter(JSON.parse(pf))
      var sf = stored("setFilter")
      if (sf) setSetFilter(JSON.parse(sf))
      var serf = stored("seriesFilter")
      if (serf) setSeriesFilter(JSON.parse(serf))
      var rf = stored("rarityFilter")
      if (rf) setRarityFilter(JSON.parse(rf))
      var lf = stored("lockedFilter")
      if (lf) setLockedFilter(JSON.parse(lf))
      var bf = stored("badgeFilter")
      if (bf) setBadgeFilter(JSON.parse(bf) === true)
    } catch {}
  }, [])

  // Persist filter state to localStorage on every change
  useEffect(function() {
    try {
      localStorage.setItem("rpc_collection_sortKey", JSON.stringify(sortKey))
      localStorage.setItem("rpc_collection_sortDirection", JSON.stringify(sortDirection))
      localStorage.setItem("rpc_collection_playerFilter", JSON.stringify(playerFilter))
      localStorage.setItem("rpc_collection_setFilter", JSON.stringify(setFilter))
      localStorage.setItem("rpc_collection_seriesFilter", JSON.stringify(seriesFilter))
      localStorage.setItem("rpc_collection_rarityFilter", JSON.stringify(rarityFilter))
      localStorage.setItem("rpc_collection_lockedFilter", JSON.stringify(lockedFilter))
      localStorage.setItem("rpc_collection_badgeFilter", JSON.stringify(badgeFilter))
    } catch {}
  }, [sortKey, sortDirection, playerFilter, setFilter, seriesFilter, rarityFilter, lockedFilter, badgeFilter])

  useEffect(function() {
    setOwnerKey(getOwnerKey())
    return onOwnerKeyChange(function(key) { setOwnerKey(key) })
  }, [])

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
        topshotAsk: market?.topshotAsk ?? row.topshotAsk ?? null,
        flowtyAsk: market?.flowtyAsk ?? row.flowtyAsk ?? null,
      }
    })
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
      fetch("/api/best-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds, editionKeys }),
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
    // Persist address in URL for bookmarking and sharing
    try { router.replace("?address=" + encodeURIComponent(trimmed), { scroll: false }) } catch {}
    setLoading(true)
    setError("")
    setRows([])
    setSummary(undefined)
    setOffset(0)
    setExpandedRows({})
    setHasSearched(false)
    setSealedPackCount(null)
    setPacksByTitle({})
    setRecentSales([]);
    // Clear any pending offer enrichment from previous search
    pendingOfferRowsRef.current = []
    if (offerTimerRef.current) { clearTimeout(offerTimerRef.current); offerTimerRef.current = null }
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
        body: JSON.stringify({ input: query.trim(), offset: 0, limit: 50, collection: collectionSlug }),
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
      // Fire-and-forget: cache wallet moments for background analytics
      fetch("/api/wallet-cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: query.trim(),
          moments: withBadges.map(function(r) {
            return { momentId: r.momentId, editionKey: r.editionKey, fmv: r.fmv, serial: r.serialNumber ?? r.serial }
          }),
        }),
      }).catch(function() {})
      // Fire-and-forget: fetch sets data for "close to completing" callout
      fetch("/api/sets?wallet=" + encodeURIComponent(query.trim()) + "&skipAsks=1")
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) { if (d) setSetsData(d) })
        .catch(function() {})
      // Fire-and-forget: enrich best offers for loaded rows
      enrichOffers(withBadges)
      // Auto-load remaining moments in background
      if (json.summary?.remainingMoments && json.summary.remainingMoments > 0) {
        setIsBackgroundLoading(true)
        setBackgroundProgress(nextRows.length)
        backgroundAutoLoad(nextRows.length, json.summary.remainingMoments, json.summary.totalMoments)
      }
      // Fire-and-forget: load sealed pack count + titles for this wallet
      fetch("/api/wallet-packs?wallet=" + encodeURIComponent(query.trim()))
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) {
          if (d && typeof d.totalSealedPacks === "number") setSealedPackCount(d.totalSealedPacks)
          if (d && d.packsByTitle) setPacksByTitle(d.packsByTitle)
        })
        .catch(function() {})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [router, collectionSlug])

  async function fetchWalletPage(nextOffset: number, append: boolean) {
    const response = await fetch("/api/wallet-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, offset: nextOffset, limit: 50, collection: collectionSlug }),
    })
    const json = (await response.json()) as WalletSearchResponse
    if (!response.ok) throw new Error(json.error || "Wallet search failed")
    const nextRows = Array.isArray(json.rows) ? json.rows : []
    const hydrated = await hydrateMarket(nextRows)
    const withBadges = await enrichWithBadges(hydrated)
    setRows(function(prev) { return append ? [...prev, ...withBadges] : withBadges })
    setSummary(json.summary)
    setOffset(nextOffset + nextRows.length)
    enrichOffers(withBadges)
  }

  // Auto-search when ownerKey is available and no results loaded yet
  useEffect(function() {
    if (ownerKey && rows.length === 0 && !loading) {
      setInput(ownerKey)
      runSearch(ownerKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])

  // Background auto-load: fetch remaining wallet pages 3 at a time in parallel
  async function backgroundAutoLoad(startOffset: number, remaining: number, total: number) {
    let currentOffset = startOffset
    let left = remaining
    const PAGES_PER_BATCH = 3
    const PAGE_SIZE = 50
    try {
      while (left > 0) {
        await new Promise(function(r) { setTimeout(r, 300) })
        const batchCount = Math.min(PAGES_PER_BATCH, Math.ceil(left / PAGE_SIZE))
        const fetches: Promise<void>[] = []
        for (let i = 0; i < batchCount; i++) {
          const off = currentOffset + i * PAGE_SIZE
          if (off < total) {
            fetches.push(fetchWalletPage(off, true))
          }
        }
        await Promise.all(fetches)
        currentOffset += batchCount * PAGE_SIZE
        left -= batchCount * PAGE_SIZE
        setBackgroundProgress(Math.min(currentOffset, total))
      }
    } catch {
      // On error, stop background loading — Load More button will remain as fallback
    }
    setIsBackgroundLoading(false)
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

  // Build a lookup: normalized set name → pack count
  // Distribution titles look like "Base Set (Series 4)" or "Holo Icon"
  // We match by checking if a distribution title contains the set name
  const packLookup = useMemo(function() {
    const map = new Map<string, number>()
    if (!Object.keys(packsByTitle).length) return map
    for (const [title, count] of Object.entries(packsByTitle)) {
      const lowerTitle = title.toLowerCase()
      // Store by the raw title for exact match attempts
      map.set(lowerTitle, (map.get(lowerTitle) ?? 0) + count)
    }
    return map
  }, [packsByTitle])

  function getPackCount(setName: string): number {
    if (!packLookup.size) return 0
    const normalizedSet = normalizeSetName(setName).toLowerCase()
    // Direct match on title
    for (const [title, count] of packLookup.entries()) {
      if (title.includes(normalizedSet) || normalizedSet.includes(title)) return count
    }
    return 0
  }

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

  const availablePlayers = useMemo(function() {
    const s = new Set<string>()
    rows.forEach(function(r) { if (r.playerName) s.add(r.playerName) })
    return ["all", ...Array.from(s).sort()]
  }, [rows])

  const availableSets = useMemo(function() {
    const s = new Set<string>()
    rows.forEach(function(r) { if (r.setName) s.add(normalizeSetName(r.setName)) })
    return ["all", ...Array.from(s).sort()]
  }, [rows])

  const availableRarities = useMemo(function() {
    const s = new Set<string>()
    rows.forEach(function(r) { if (r.tier) s.add(r.tier) })
    return ["all", ...Array.from(s).sort()]
  }, [rows])

  // True when the loaded collection belongs to the signed-in / connected user
  const isOwnCollection = useMemo(function() {
    if (!input.trim()) return false
    const q = input.trim().toLowerCase()
    if (ownerKey && ownerKey.toLowerCase() === q) return true
    if (connectedWallet && connectedWallet.toLowerCase() === q) return true
    return false
  }, [input, ownerKey, connectedWallet])

  const filteredRows = useMemo(function() {
    const q = searchWithin.trim().toLowerCase()
    const filtered = rows.filter(function(r) {
      if (playerFilter !== "all" && r.playerName !== playerFilter) return false
      if (setFilter !== "all" && normalizeSetName(r.setName) !== setFilter) return false
      if (seriesFilter !== "all" && seriesDisplayLabel(r.series) !== seriesFilter) return false
      if (rarityFilter !== "all" && r.tier !== rarityFilter) return false
      if (lockedFilter === "locked" && !getLocked(r)) return false
      if (lockedFilter === "unlocked" && getLocked(r)) return false
      if (badgeFilter && !r.badgeInfo?.badge_score) return false
      if (filterBadges && !(r.officialBadges?.length || (r as any).badgeScore > 0)) return false
      if (filterHasOffer && !(typeof r.bestOffer === "number" && r.bestOffer > 0)) return false
      if (filterListed && r.lowAsk == null) return false
      if (q) {
        const haystack = [r.playerName, r.team ?? "", r.league ?? "", r.series ?? "", r.setName, getParallel(r), r.tier ?? "", ...(r.officialBadges ?? []), ...(r.badgeInfo?.badge_titles ?? []), ...getTraits(r)].join(" ").toLowerCase()
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
        case "tss":       result = compareNumber(a.tssPoints, b.tssPoints); break
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
  }, [rows, searchWithin, playerFilter, setFilter, seriesFilter, rarityFilter, lockedFilter, badgeFilter, filterBadges, filterHasOffer, filterListed, sortKey, sortDirection, batchEditionStats])

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

  const nearCompleteSets = useMemo(function() {
    if (!setsData?.sets) return []
    return setsData.sets
      .filter(function(s: any) { return s.missingCount >= 1 && s.missingCount <= 3 && s.completionPct >= 50 })
      .sort(function(a: any, b: any) { return a.missingCount - b.missingCount })
      .slice(0, 3)
  }, [setsData])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <Suspense fallback={null}>
        <AutoSearchReader onSearch={runSearch} />
      </Suspense>

      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

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
            className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none placeholder:text-zinc-500"
            style={{ ["--accent" as string]: accent }}
            onFocus={function(e) { e.currentTarget.style.borderColor = accent }}
            onBlur={function(e) { e.currentTarget.style.borderColor = "" }}
          />
          <button
            onClick={handleSearch}
            disabled={loading || !input.trim()}
            className="rounded-lg px-5 py-2 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {loading ? "Loading..." : "Search"}
          </button>
          {rows.length > 0 && (
            <button
              onClick={function() {
                navigator.clipboard.writeText(window.location.href)
                setCopied(true)
                setTimeout(function() { setCopied(false) }, 1500)
              }}
              title="Copy shareable link"
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 transition"
            >
              {copied ? "✓" : "🔗"}
            </button>
          )}
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
                      <div className="h-1 rounded-full transition-all duration-300" style={{ width: loadProgress.pct + "%", backgroundColor: accent }} />
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
          </div>
        )}

        {/* Close to Completing callout */}
        {nearCompleteSets.length > 0 && hasSearched && (
          <div style={{ borderLeft: "3px solid #22c55e", background: "rgba(34,197,94,0.05)", borderRadius: 6, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "#22c55e", letterSpacing: "0.1em", marginBottom: 4 }}>◉ CLOSE TO COMPLETING</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa" }}>
              {nearCompleteSets.map(function(s: any, i: number) {
                return (
                  <span key={s.setId ?? s.setName}>
                    {i > 0 && " · "}
                    <a href={"/nba-top-shot/sets"} style={{ color: "#a1a1aa", textDecoration: "none" }}>
                      {s.setName} — {s.missingCount} away{s.totalMissingCost != null ? " · $" + s.totalMissingCost.toFixed(2) : ""}
                    </a>
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-5 grid gap-2 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <select value={playerFilter} onChange={function(e) { setPlayerFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availablePlayers.map(function(p) { return <option key={p} value={p}>{p === "all" ? "All Players" : p}</option> })}
          </select>
          <select value={setFilter} onChange={function(e) { setSetFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableSets.map(function(s) { return <option key={s} value={s}>{s === "all" ? "All Sets" : s}</option> })}
          </select>
          <select value={seriesFilter} onChange={function(e) { setSeriesFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            <option value="all">All Series</option>
            <option value="Beta">Beta</option>
            <option value="S1 · 2019-20">S1 · 2019-20</option>
            <option value="S2 · 2020-21">S2 · 2020-21</option>
            <option value="S3 · 2021-22">S3 · 2021-22</option>
            <option value="S4 · 2022-23">S4 · 2022-23</option>
            <option value="S5 · 2023-24">S5 · 2023-24</option>
            <option value="S6 · 2024-25">S6 · 2024-25</option>
            <option value="S7 · 2025-26">S7 · 2025-26</option>
            <option value="S8 · 2026-27">S8 · 2026-27</option>
          </select>
          <select value={rarityFilter} onChange={function(e) { setRarityFilter(e.target.value) }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
            {availableRarities.map(function(tier) { return <option key={tier} value={tier}>{tier === "all" ? "All Rarities" : tier}</option> })}
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
              <button key={key} onClick={function() { toggleSort(key) }} className={"shrink-0 rounded-lg border px-3 py-1 text-sm hover:bg-zinc-900 " + (sortKey === key ? "text-white" : "border-zinc-700 text-zinc-400")} style={sortKey === key ? { borderColor: accent } : undefined}>
                {label}{sortKey === key && <span className="ml-1 text-zinc-500">{sortDirection === "asc" ? "↑" : "↓"}</span>}
              </button>
            )
          })}
          <div className="border-l border-zinc-700 mx-1" />
          <button onClick={function() { setFilterBadges(function(f) { return !f }) }} className={"shrink-0 rounded-lg border px-3 py-1 text-sm " + (filterBadges ? "text-white" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900")} style={filterBadges ? { borderColor: accent, backgroundColor: accent + "1A", color: accent } : undefined}>🏷 BADGES</button>
          <button onClick={function() { setFilterHasOffer(function(f) { return !f }) }} className={"shrink-0 rounded-lg border px-3 py-1 text-sm " + (filterHasOffer ? "text-white" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900")} style={filterHasOffer ? { borderColor: accent, backgroundColor: accent + "1A", color: accent } : undefined}>💰 HAS OFFER</button>
          <button onClick={function() { setFilterListed(function(f) { return !f }) }} className={"shrink-0 rounded-lg border px-3 py-1 text-sm " + (filterListed ? "text-white" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900")} style={filterListed ? { borderColor: accent, backgroundColor: accent + "1A", color: accent } : undefined}>📋 LISTED</button>
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
                <th className="p-3">Set</th>
                <th className="p-3 hidden sm:table-cell text-left">Series</th>
                <th className="p-3 hidden md:table-cell">Parallel</th>
                <th className="p-3 hidden md:table-cell">Rarity</th>
                <th className="p-3">Serial / Mint</th>
                <th className="p-3 hidden lg:table-cell">Held / Locked</th>
                <th className="p-3 hidden xl:table-cell">Packs</th>
                <th className="p-3">FMV</th>
                <th className="p-3 hidden lg:table-cell" style={{ cursor: "pointer" }} onClick={function() { if (sortKey === "tss") { setSortDirection(sortDirection === "asc" ? "desc" : "asc") } else { setSortKey("tss"); setSortDirection("desc") } }}>
                  TSS{sortKey === "tss" ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
                </th>
                <th className="p-3 hidden lg:table-cell">Low Ask</th>
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
                    <tr className={"group border-b border-zinc-800 align-top " + (isLocked ? "opacity-60" : "") + (row.tier?.toUpperCase() === "LEGENDARY" ? " rpc-holo-legendary" : row.tier?.toUpperCase() === "ULTIMATE" ? " rpc-holo-ultimate" : row.tier?.toUpperCase() === "RARE" ? " rpc-holo-rare" : "")}>
                      <td className="p-3 min-w-[160px]">
                        <div className="flex items-center gap-2">
                          {row.thumbnailUrl ? (
                            <img
                              src={row.thumbnailUrl}
                              alt={row.playerName}
                              width={36}
                              height={36}
                              loading="lazy"
                              className="shrink-0 rounded object-cover bg-zinc-900"
                              style={{ width: 36, height: 36 }}
                            />
                          ) : (
                            <div className="shrink-0 rounded bg-zinc-900" style={{ width: 36, height: 36 }} />
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
                      <td className="p-3 text-sm">{normalizeSetName(row.setName)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden sm:table-cell">{seriesDisplayLabel(row.series)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{getParallel(row)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{row.tier ?? "—"}</td>
                      <td className="p-3">
                        <div className={"inline-flex min-w-[80px] flex-col rounded-lg border px-2 py-1 " + (primaryBadge ? "" : "border-zinc-800 bg-black")} style={primaryBadge ? { borderColor: accent, backgroundColor: accent + "1A" } : undefined}>
                          <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} />
                          <div className={"text-sm font-black " + (primaryBadge ? "" : "text-white")} style={primaryBadge ? { color: accent } : undefined}>{"#" + (getSerial(row) ?? "-")}</div>
                          <div className="text-xs text-zinc-400">{"/ " + (getMint(row) ?? "-")}</div>
                          {primaryBadge ? <div className="mt-1 rounded bg-white px-1 py-0.5 text-[9px] font-bold text-black">{primaryBadge}</div> : null}
                        </div>
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        {editionCounts.owned} / {editionCounts.locked}
                        {isLocked && <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Locked</span>}
                      </td>
                      <td className="p-3 text-sm hidden xl:table-cell">
                        {(function() {
                          const count = getPackCount(row.setName)
                          if (!count) return <span className="text-zinc-600">—</span>
                          return (
                            <a href={"/" + collectionSlug + "/packs?wallet=" + encodeURIComponent(input.trim())} className="hover:opacity-80" style={{ color: accent }}>
                              {count + (count === 1 ? " pack" : " packs")}
                            </a>
                          )
                        })()}
                      </td>
                      <td className="p-3">
                        <div className={"font-semibold text-sm " + (fmv.muted ? "text-zinc-500" : "text-white")}>{fmv.text}</div>
                        <div className={"text-[10px] " + conf.color}>{conf.label}</div>
                        {(function() {
                          if (row.marketConfidence === "none" || !row.fmv || row.fmv <= 0 || row.lowAsk == null) return null
                          const delta = ((row.lowAsk - row.fmv) / row.fmv) * 100
                          if (Math.abs(delta) < 3) return null
                          return (
                            <div className={"text-[10px] font-mono " + (delta < 0 ? "text-emerald-400" : "text-red-400")}>
                              {delta > 0 ? "↑+" : "↓"}{delta.toFixed(0)}%
                            </div>
                          )
                        })()}
                        {(function() {
                          const ask = getBestAsk(row)
                          if (ask == null || !row.fmv || row.fmv <= 0) return null
                          const pctDiff = Math.abs((ask - row.fmv) / row.fmv) * 100
                          if (pctDiff <= 1) return null
                          return <div className="text-[10px] text-zinc-500 font-mono">Ask {"$" + ask.toFixed(2)}</div>
                        })()}
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        {row.tssPoints != null ? (
                          <span className="font-mono text-zinc-300">{row.tssPoints.toLocaleString()}</span>
                        ) : (
                          <span className="text-zinc-600">&mdash;</span>
                        )}
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        {row.lowAsk != null ? (
                          <span style={{ color: row.fmv && row.lowAsk < row.fmv ? "#22c55e" : "#9ca3af" }}>
                            ${row.lowAsk.toFixed(2)}
                          </span>
                        ) : row.flowtyAsk != null ? (
                          <span style={{ color: row.fmv && row.flowtyAsk < row.fmv ? "#22c55e" : "#9ca3af" }}>
                            ${row.flowtyAsk.toFixed(2)}
                            <span className="ml-1 text-[10px] font-bold text-blue-400">F</span>
                          </span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        {(function() {
                          const offer = row.bestOffer
                          const edOffer = row.editionOffer
                          // Show the higher of edition vs serial offer
                          const displayOffer = (typeof offer === "number" && offer > 0) ? offer : null
                          const displayEdOffer = (typeof edOffer === "number" && edOffer > 0) ? edOffer : null
                          const best = displayOffer && displayEdOffer
                            ? (displayOffer >= displayEdOffer ? { val: displayOffer, label: row.bestOfferType ?? "serial" } : { val: displayEdOffer, label: "edition" })
                            : displayOffer ? { val: displayOffer, label: row.bestOfferType ?? "offer" }
                            : displayEdOffer ? { val: displayEdOffer, label: "edition" }
                            : null
                          if (!best) return <span className="text-zinc-600">—</span>
                          return (
                            <div>
                              <div className="text-zinc-300 font-semibold">{formatCurrency(best.val)}</div>
                              <div className="text-[10px] font-mono text-zinc-500">{best.label} offer</div>
                              {best.val > (getBestAsk(row) ?? Infinity) && (
                                <span className="inline-block mt-0.5 rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-800">Flip</span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="p-3 text-zinc-500 text-xs hidden xl:table-cell">{formatAcquiredAt(row.acquiredAt)}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <button onClick={function() { toggleExpanded(row.momentId) }} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-white hover:bg-zinc-900">
                            {expanded ? "Hide" : "Show"}
                          </button>
                          {isOwnCollection && (
                            <a
                              href={"https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/" + row.momentId}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hidden group-hover:inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors"
                              title="List on Flowty"
                            >
                              List
                              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr className="border-b border-zinc-800 bg-black/60">
                        <td colSpan={12} className="p-4">
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
                                  {getTraits(row).map(function(trait) { return <span key={trait} className="rounded px-2 py-0.5 text-[10px]" style={{ backgroundColor: accent + "1A", color: accent }}>{trait}</span> })}
                                </div>
                              </div>
                            </div>
                            {row.badgeInfo?.badge_score ? (
                              <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Badges</div>
                                <div className="space-y-1 text-sm">
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-400">Score</span>
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black text-white" style={{ backgroundColor: accent }}>{row.badgeInfo.badge_score}</span>
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
                          <div className="mt-4">
                            <EditionRecentSales editionKey={row.editionKey ?? null} mintCount={getMint(row)} />
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

        {/* Empty state */}
        {hasSearched && !loading && filteredRows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-lg font-bold text-zinc-400 uppercase tracking-widest">No Moments Found</div>
            <div className="mt-2 text-sm text-zinc-500">Try searching a different wallet or connect yours</div>
            <button
              onClick={function() { runSearch("0xbd94cade097e50ac") }}
              className="mt-4 text-sm transition-colors hover:opacity-80"
              style={{ color: accent }}
            >
              View example: 0xbd94cade097e50ac →
            </button>
          </div>
        )}

        {isBackgroundLoading ? (
          <div className="mt-6 flex justify-center">
            <span className="text-sm text-zinc-500">Loading… ({backgroundProgress} / {summary?.totalMoments ?? "?"})</span>
          </div>
        ) : summary && summary.remainingMoments > 0 ? (
          <div className="mt-6 flex justify-center">
            <button onClick={handleLoadMore} disabled={loadingMore} className="rounded-lg px-4 py-2 font-semibold text-white disabled:opacity-50" style={{ backgroundColor: accent }}>
              {loadingMore ? "Loading..." : "Load More (" + summary.remainingMoments + " left)"}
            </button>
          </div>
        ) : null}

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
    </div>
  )
}