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
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"
import { useWarmCache, usePrefetch } from "@/lib/warmup/WarmupContext"
import ExplainButton from "@/components/ExplainButton"
import { BADGE_TYPE_TO_TITLE } from "@/lib/topshot-badges"
import MomentDetailModal from "@/components/MomentDetailModal"
import BadgeIcon from "@/components/BadgeIcon"

function ThumbnailPreview({ thumbUrl, playerName, tierColor, children }: { thumbUrl: string | null; playerName: string; tierColor: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const previewUrl = thumbUrl ? thumbUrl.replace(/width=\d+/, "width=400") : null

  function onEnter() {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = Math.min(window.innerWidth - 240, r.right + 12)
    const y = Math.max(12, r.top - 40)
    setPos({ x, y })
    setHovered(true)
  }
  function onLeave() { setHovered(false) }

  return (
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ display: "inline-block" }}>
      {children}
      {hovered && previewUrl && pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500, pointerEvents: "none", background: "#000", border: `2px solid ${tierColor}`, borderRadius: 6, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          <img src={previewUrl} alt={playerName} width={200} height={200} style={{ width: 200, height: 200, objectFit: "contain", display: "block" }} />
          <div style={{ color: "#fff", fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{playerName}</div>
        </div>
      )}
    </div>
  )
}

const COLLECTION_UUID_BY_SLUG: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
  "disney-pinnacle": "7dd9dd11-e8b6-45c4-ac99-71331f959714",
  "ufc": "9b4824a8-736d-4a96-b450-8dcc0c46b023",
}
const ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR = new Set(["Rookie Year", "Rookie Premiere", "Rookie Mint"])

// ── Types ─────────────────────────────────────────────────────────────────────

type BadgeInfo = {
  badge_score: number
  badge_titles: string[]
  is_three_star_rookie: boolean
  has_rookie_mint: boolean
  burn_rate_pct: number
  lock_rate_pct: number
  low_ask: number | null
  circulation_count: number
  effective_supply: number | null
  burned: number
  owned: number
  hidden_in_packs: number
  for_sale_by_collectors: number | null
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
  fmvUsd?: number | null
  tssPoints?: number | null
  badgeInfo?: BadgeInfo | null
  editionOffer?: number | null
  bestOfferType?: "edition" | "serial" | null
  acquisitionMethod?: string | null
  acquisitionSource?: string | null
  acquisitionConfidence?: string | null
  buyPrice?: number | null
  costBasis?: number | null
  costBasisLabel?: string | null
}

type WalletSearchResponse = {
  rows?: MomentRow[]
  summary?: { totalMoments: number; returnedMoments: number; remainingMoments: number }
  error?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BADGE_PILL_TITLES = new Set([
  "Rookie Year", "Rookie Premiere", "Top Shot Debut",
  "Rookie of the Year", "Rookie Mint", "Championship Year",
])

// Fallback Top Shot series maps — used when collection_series data is not yet loaded
const SERIES_INT_TO_SEASON: Record<number, string> = {
  0: "2019-20", 2: "2020-21", 3: "2021",
  4: "2021-22", 5: "2022-23", 6: "2023-24", 7: "2024-25", 8: "2025-26",
}

const SERIES_DISPLAY_FALLBACK: Record<number, string> = {
  0: "S1 · 2019-20",
  2: "S2 · 2020-21",
  3: "Sum 21 · 2021",
  4: "S3 · 2021-22",
  5: "S4 · 2022-23",
  6: "23-24 · 2023-24",
  7: "24-25 · 2024-25",
  8: "25-26 · 2025-26",
}

const SERIES_FILTER_LABEL_FALLBACK: Record<number, string> = {
  0: "Series 1", 2: "Series 2", 3: "Summer 2021",
  4: "Series 3", 5: "Series 4", 6: "Series 2023-24",
  7: "Series 2024-25", 8: "Series 2025-26",
}

type CollectionSeriesEntry = {
  series_number: number
  display_label: string
  season: string | null
}

function seriesDisplayLabel(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
  if (!seriesRaw) return "—"
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && seriesMap?.has(n)) {
    const entry = seriesMap.get(n)!
    return entry.season ? entry.display_label + " · " + entry.season : entry.display_label
  }
  if (!Number.isNaN(n) && SERIES_DISPLAY_FALLBACK[n] !== undefined) return SERIES_DISPLAY_FALLBACK[n]
  return seriesRaw
}

function seriesFilterLabel(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
  if (!seriesRaw) return "—"
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && seriesMap?.has(n)) return seriesMap.get(n)!.display_label
  if (!Number.isNaN(n) && SERIES_FILTER_LABEL_FALLBACK[n] !== undefined) return SERIES_FILTER_LABEL_FALLBACK[n]
  return seriesRaw
}

function seriesIntToSeason(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
  if (!seriesRaw) return ""
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && seriesMap?.has(n)) {
    const entry = seriesMap.get(n)!
    return entry.season ?? entry.display_label
  }
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


function formatAcquiredAt(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function compareText(a?: string | null, b?: string | null) { return (a ?? "").localeCompare(b ?? "") }
function compareNumber(a?: number | null, b?: number | null) { return (a ?? -Infinity) - (b ?? -Infinity) }
function getParallel(row: MomentRow) { return normalizeParallel(row.parallel ?? row.subedition ?? "") }
function getSerial(row: MomentRow) { return row.serialNumber ?? row.serial ?? null }
function getMint(row: MomentRow) { return row.mintCount ?? row.mintSize ?? null }
function getTraits(row: MomentRow) { return row.specialSerialTraits ?? row.traits ?? [] }
function getLocked(row: MomentRow) { return Boolean(row.isLocked ?? row.locked) }

function proxyTopShotThumb(url: string): string {
  // Rewrite direct Top Shot CDN URLs through our proxy to bypass hotlink blocks.
  const m = url.match(/^https:\/\/assets\.nbatopshot\.com\/media\/([a-zA-Z0-9_-]+)(?:\/image)?(?:\?.*width=(\d+))?/)
  if (!m) return url
  const flowId = m[1]
  const width = m[2] ? parseInt(m[2], 10) : 180
  return `/api/moment-thumbnail?flowId=${encodeURIComponent(flowId)}&width=${width}`
}

function getThumbnailUrl(row: MomentRow, collectionSlug?: string): string | null {
  // UFC moments have IPFS thumbnail URLs stored on the edition; keep direct.
  if (collectionSlug === "ufc") return row.thumbnailUrl ?? null
  // Always route through the proxy — the CDN returns non-error responses for
  // hotlink blocks, so <img onError> fallbacks never fire.
  if (row.momentId) {
    return `/api/moment-thumbnail?flowId=${encodeURIComponent(row.momentId)}&width=180`
  }
  if (row.thumbnailUrl) return proxyTopShotThumb(row.thumbnailUrl)
  return null
}

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
// BadgeIcon, BadgePill, and their slug/camel lookups used to live inline
// here. They now ship as a single shared component that reads color /
// icon_url / priority from the badge_taxonomy RPC — import above.

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
  const fmv = row.fmv ?? (typeof row.fmvUsd === "number" && row.fmvUsd > 0 ? row.fmvUsd : null)
  if (fmv === null || fmv === undefined || fmv === 0) return { text: "—", muted: true }
  return { text: "$" + fmv.toFixed(2), muted: false }
}

type SortKey = "player" | "series" | "set" | "parallel" | "rarity" | "serial" | "fmv" | "bestOffer" | "held" | "badge" | "acquired" | "paid"

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

function AutoSearchReader(props: { onSearch: (q: string) => void; collectionSlug: string }) {
  const searchParams = useSearchParams()
  useEffect(function() {
    let cancelled = false
    // Support ?wallet= (preferred), ?address=, and legacy ?q= param
    const wallet = searchParams.get("wallet")
    const address = searchParams.get("address")
    const q = searchParams.get("q")
    const query = wallet || address || q
    if (query && query.trim()) {
      props.onSearch(query.trim())
      return
    }
    // No URL param — fall back to the signed-in user's saved wallet for this
    // collection so the page auto-loads without requiring a trip to /profile.
    fetchSavedWalletForCollection(props.collectionSlug).then((addr) => {
      if (cancelled) return
      if (addr) props.onSearch(addr)
    })
    return function() { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

// ── useMobile hook ───────────────────────────────────────────────────────────

function useMobile() {
  const [isMobile, setIsMobile] = useState(true)
  useEffect(function() {
    setIsMobile(window.innerWidth < 768)
    function onResize() { setIsMobile(window.innerWidth < 768) }
    window.addEventListener("resize", onResize)
    return function() { window.removeEventListener("resize", onResize) }
  }, [])
  return isMobile
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WalletPage() {
  const router = useRouter()
  const routeParams = useParams()
  const collectionSlug = (routeParams?.collection as string) ?? "nba-top-shot"
  const collectionObj = getCollection(collectionSlug)
  const accent = collectionObj?.accent ?? "#E03A2F"
  const lastSearchedRef = useRef("")
  const ownedFlowIdsRef: React.MutableRefObject<Set<string>> = useRef(new Set<string>())
  const [rows, setRows] = useState<MomentRow[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [summary, setSummary] = useState<WalletSearchResponse["summary"]>()
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const [selectedMoment, setSelectedMoment] = useState<MomentRow | null>(null)
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
    pnl: number
  } | null>(null)
  const [walletSummaryLoading, setWalletSummaryLoading] = useState(false)
  const [acquisitionStats, setAcquisitionStats] = useState<{
    pack_pull_count: number
    marketplace_count: number
    challenge_reward_count: number
    gift_count: number
    total_count: number
    locked_count: number
    total_spent: number
  } | null>(null)
  const [activeWallet, setActiveWallet] = useState("")
  const [costBasis, setCostBasis] = useState<Map<string, { buyPrice: number; acquiredDate: string; fmvAtAcquisition: number | null; acquisitionMethod: string | null; costBasisLabel: string | null }>>(new Map())
  const [serverSortBy, setServerSortBy] = useState("fmv_desc")

  // Task 2: FMV Alert UI state
  const [alertOpenMomentId, setAlertOpenMomentId] = useState<string | null>(null)
  const [alertTargetPrice, setAlertTargetPrice] = useState("")
  const [alertNotifType, setAlertNotifType] = useState<"email" | "in-app">("email")
  const [alertStatus, setAlertStatus] = useState<"idle" | "saving" | "success" | "error">("idle")
  const [alertError, setAlertError] = useState("")

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
  const isMobile = useMobile()

  // ── Task 14: Duplicate edition callout ─────────────────────────────────────
  const [dupDismissed, setDupDismissed] = useState(false)
  const [filterDupsOnly, setFilterDupsOnly] = useState(false)

  // ── Collection series (fetched from collection_series table) ──────────────
  const [collectionSeriesMap, setCollectionSeriesMap] = useState<Map<number, CollectionSeriesEntry>>(new Map())
  const [collectionSeriesOptions, setCollectionSeriesOptions] = useState<{ label: string; seriesNumber: number }[]>([])

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
        const LABEL_MAP: Record<string, string | null> = { marketplace: "Bought", pack_pull: "Pack", loan_default: "Loan", gift: "Gift", challenge_reward: "Reward", airdrop: "Airdrop", unknown: null }
        const map = new Map<string, { buyPrice: number; acquiredDate: string; fmvAtAcquisition: number | null; acquisitionMethod: string | null; costBasisLabel: string | null }>()
        for (const item of (data.acquisitions ?? [])) {
          const method = item.acquisition_method ?? null
          map.set(item.nft_id, {
            buyPrice: Number(item.buy_price),
            acquiredDate: item.acquired_date,
            fmvAtAcquisition: item.fmv_at_acquisition != null ? Number(item.fmv_at_acquisition) : null,
            acquisitionMethod: method,
            costBasisLabel: method ? (LABEL_MAP[method] ?? null) : null,
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

  // ── Server-paginated moments fetch ──────────────────────────────────────
  type ServerMoment = {
    moment_id: string
    edition_key: string | null
    serial_number: number | null
    fmv_usd: number | null
    confidence: string | null
    low_ask: number | null
    player_name: string | null
    set_name: string | null
    tier: string | null
    series_number: number | null
    circulation_count: number | null
    thumbnail_url: string | null
    team_name: string | null
    acquired_at: string | null
    last_seen_at: string | null
    buy_price: number | null
    acquisition_method: string | null
    acquisition_source: string | null
    acquisition_confidence: string | null
    loan_principal: number | null
    is_locked: boolean
  }

  const ACQUISITION_LABEL_MAP: Record<string, string | null> = { marketplace: "Bought", pack_pull: "Pack", loan_default: "Loan", gift: "Gift", challenge_reward: "Reward", airdrop: "Airdrop", unknown: null }

  function serverMomentToRow(m: ServerMoment): MomentRow {
    // Ensure fmv_usd is a real number (Supabase numeric cols can arrive as strings)
    const fmvNum = m.fmv_usd != null ? Number(m.fmv_usd) : null
    const fmvVal = (fmvNum != null && Number.isFinite(fmvNum) && fmvNum > 0) ? fmvNum : null
    const lowAskNum = m.low_ask != null ? Number(m.low_ask) : null
    const lowAskVal = (lowAskNum != null && Number.isFinite(lowAskNum) && lowAskNum > 0) ? lowAskNum : null

    // Derive cost basis from RPC acquisition fields
    const acqMethod = m.acquisition_method ?? null
    const label = acqMethod ? (ACQUISITION_LABEL_MAP[acqMethod] ?? null) : null
    let basis: number | null = null
    if (acqMethod === "marketplace" && m.buy_price != null) basis = Number(m.buy_price)
    else if (acqMethod === "loan_default" && m.loan_principal != null) basis = Number(m.loan_principal)

    // Map confidence to FMV method label
    const conf = m.confidence?.toUpperCase() ?? null
    const fmvMethodLabel: MomentRow["fmvMethod"] = conf === "HIGH" ? "band" : conf === "MEDIUM" ? "low-ask-only" : conf === "LOW" ? "best-offer-only" : "none"

    // Determine best market from low_ask (Top Shot floor)
    const bestMarketVal: MomentRow["bestMarket"] = lowAskVal ? "Top Shot" : null

    return {
      momentId: m.moment_id,
      playerName: m.player_name ?? "Unknown",
      team: m.team_name ?? undefined,
      league: "NBA",
      setName: m.set_name ?? "Unknown Set",
      editionKey: m.edition_key,
      fmv: fmvVal,
      serialNumber: m.serial_number ?? undefined,
      serial: m.serial_number ?? undefined,
      mintCount: m.circulation_count ?? undefined,
      mintSize: m.circulation_count ?? undefined,
      tier: m.tier ? m.tier.replace(/^MOMENT_TIER_/i, "") : undefined,
      series: m.series_number != null ? String(m.series_number) : undefined,
      thumbnailUrl: m.thumbnail_url,
      acquiredAt: m.acquired_at ?? null,
      marketConfidence: (m.confidence?.toLowerCase() ?? "none") as "high" | "medium" | "low" | "none",
      fmvUsd: fmvVal,
      fmvMethod: fmvMethodLabel,
      lowAsk: lowAskVal,
      topshotAsk: lowAskVal,
      bestMarket: bestMarketVal,
      officialBadges: [],
      specialSerialTraits: [],
      isLocked: m.is_locked === true,
      bestAsk: lowAskVal,
      bestOffer: null,
      lastPurchasePrice: null,
      parallel: null,
      subedition: null,
      flowId: m.moment_id,
      acquisitionMethod: acqMethod,
      acquisitionSource: m.acquisition_source ?? null,
      acquisitionConfidence: m.acquisition_confidence ?? null,
      costBasis: basis,
      costBasisLabel: label,
    }
  }

  // Map SortKey to server sortBy param
  function sortKeyToServerSort(key: SortKey, dir: "asc" | "desc"): string {
    switch (key) {
      case "fmv": return dir === "asc" ? "fmv_asc" : "fmv_desc"
      case "serial": return "serial_asc"
      case "acquired": return "recent"
      case "paid": return dir === "asc" ? "paid_asc" : "paid_desc"
      default: return dir === "asc" ? "fmv_asc" : "fmv_desc"
    }
  }

  async function fetchPaginatedMoments(wallet: string, page: number, sort: string, append: boolean) {
    const params = new URLSearchParams({
      wallet,
      page: String(page),
      limit: "50",
      sortBy: sort,
      collection: collectionSlug,
    })
    // Apply active filters to server query
    if (playerFilter !== "all") params.set("player", playerFilter)
    if (seriesFilter !== "all") {
      // Convert display label back to series number using dynamic collection_series data
      const match = collectionSeriesOptions.find(function(s) { return s.label === seriesFilter })
      if (match) {
        params.set("series", String(match.seriesNumber))
      } else {
        // Fallback for Top Shot hardcoded labels
        const seriesLabelToNum: Record<string, string> = {
          "Series 1": "0", "Series 2": "2", "Summer 2021": "3",
          "Series 3": "4", "Series 4": "5", "Series 2023-24": "6",
          "Series 2024-25": "7", "Series 2025-26": "8",
        }
        const sn = seriesLabelToNum[seriesFilter]
        if (sn) params.set("series", sn)
      }
    }
    if (rarityFilter !== "all") params.set("tier", rarityFilter)

    const res = await fetch("/api/collection-moments?" + params.toString())
    if (!res.ok) {
      const json = await res.json().catch(function() { return {} })
      throw new Error(json.error || "Failed to load moments")
    }
    const json = await res.json()
    const moments: ServerMoment[] = json.moments ?? []
    const momentRows = moments.map(serverMomentToRow)

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

  async function maybePatchProfileStats(query: string, resultRows: MomentRow[], resultSummary: WalletSearchResponse["summary"], resolvedAddress?: string | null) {
    const key = getOwnerKey()
    if (!key) return
    try {
      const res = await fetch("/api/profile/saved-wallets?ownerKey=" + encodeURIComponent(key))
      if (!res.ok) return
      const d = await res.json()
      const wallets: any[] = d.wallets ?? []
      const q = query.toLowerCase().trim()
      const ra = resolvedAddress ? resolvedAddress.toLowerCase() : null
      const matched = wallets.find(function(w) {
        const addr = (w.wallet_addr ?? "").toLowerCase()
        const user = (w.username ?? "").toLowerCase()
        return addr === q || user === q || (ra != null && addr === ra)
      })
      if (!matched) return
      let totalFmv = walletTotalFmv ?? 0
      if (!totalFmv) {
        for (const row of resultRows) {
          if (typeof row.fmv === "number") totalFmv += row.fmv
        }
      }
      const momentCount = resultSummary?.totalMoments ?? resultRows.length
      const TIER_PRIORITY = ["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"]
      let cachedTopTier: string | null = null
      for (const t of TIER_PRIORITY) {
        if (resultRows.some(function(r) { return (r.tier ?? "").toUpperCase() === t })) {
          cachedTopTier = t
          break
        }
      }
      await fetch("/api/profile/saved-wallets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey: key,
          walletAddr: matched.wallet_addr,
          cachedFmv: totalFmv,
          cachedMomentCount: momentCount,
          cachedTopTier: cachedTopTier,
        }),
      })
    } catch {}
  }

  const runSearch = useCallback(async function(query: string) {
    if (!query.trim()) return
    const trimmed = query.trim()
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
    setExpandedRows({})
    setHasSearched(false)
    setSealedPackCount(null)
    setWalletTotalFmv(null)
    setWalletSummary(null)
    setAcquisitionStats(null)
    setPacksByTitle({})
    setRecentSales([]);
    setPaginatedPage(1)
    setPaginatedTotal(0)
    setPaginatedTotalPages(0)
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
      const sort = sortKeyToServerSort(sortKey, sortDirection)
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
            pnl: Number(json.pnl) || 0,
          })
          if (typeof json.wallet_fmv === "number" && json.wallet_fmv > 0) {
            setWalletTotalFmv(json.wallet_fmv)
          }
          // Fire-and-forget lock backfill if we haven't caught up yet.
          const lockedCount = Number(json.locked_count) || 0
          if (lockedCount < 500) {
            fetch("/api/cache-refresh?wallet=" + encodeURIComponent(trimmed) + "&refreshLocked=1").catch(function() {})
          }
        })
        .catch(function() {})
        .finally(function() { setWalletSummaryLoading(false) })

      // Secondary: call wallet-search for summary stats only (total FMV, locked/unlocked counts)
      // This runs in parallel as a background fetch — does NOT block the moment display.
      // Skipped for UFC: wallet-search is driven by Top Shot GQL and has no UFC path.
      if (trimmed && collectionSlug !== "ufc") {
        fetch("/api/wallet-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: trimmed, offset: 0, limit: 50, collection: collectionSlug }),
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
                  moments: liveRows.map(function(r) {
                    return { momentId: r.momentId, editionKey: r.editionKey, fmv: r.fmv, serial: r.serialNumber ?? r.serial }
                  }),
                }),
              }).catch(function() {})
            }
            maybePatchProfileStats(trimmed, liveRows, json.summary, (json as any).resolvedAddress ?? null).catch(function() {})
          })
          .catch(function() {})
      }

      // Fire-and-forget: enrich FMV/asks via Flowty for editions missing data
      fetch("/api/wallet-enrich-flowty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: trimmed }),
      }).catch(function() {})
      // Fire-and-forget: fetch sets data for "close to completing" callout
      fetch("/api/sets?wallet=" + encodeURIComponent(trimmed) + "&skipAsks=1")
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(d) { if (d) setSetsData(d) })
        .catch(function() {})
      // Fire-and-forget: load sealed pack count + titles for this wallet
      fetch("/api/wallet-packs?wallet=" + encodeURIComponent(trimmed))
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
  }, [router, collectionSlug, sortKey, sortDirection, playerFilter, seriesFilter, rarityFilter])

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
          if (playerFilter !== "all") params.set("player", playerFilter)
          if (seriesFilter !== "all") {
            const match = collectionSeriesOptions.find(function(s) { return s.label === seriesFilter })
            if (match) {
              params.set("series", String(match.seriesNumber))
            } else {
              const seriesLabelToNum: Record<string, string> = {
                "Series 1": "0", "Series 2": "2", "Summer 2021": "3",
                "Series 3": "4", "Series 4": "5", "Series 2023-24": "6",
                "Series 2024-25": "7", "Series 2025-26": "8",
              }
              const sn = seriesLabelToNum[seriesFilter]
              if (sn) params.set("series", sn)
            }
          }
          if (rarityFilter !== "all") params.set("tier", rarityFilter)
          const res = await fetch("/api/collection-moments?" + params.toString())
          if (!res.ok) break
          const json = await res.json()
          const moments: ServerMoment[] = json.moments ?? []
          if (moments.length === 0) break
          const momentRows = moments.map(serverMomentToRow)
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
      setLoadingMore(false)
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

  function toggleSort(next: SortKey) {
    let newDir: "asc" | "desc"
    if (sortKey === next) {
      newDir = sortDirection === "asc" ? "desc" : "asc"
      setSortDirection(newDir)
    } else {
      newDir = "desc"
      setSortKey(next)
      setSortDirection(newDir)
    }
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

  // ── Task 14: Detect duplicate editions ──────────────────────────────────
  const duplicateEditions = useMemo(function() {
    const countMap = new Map<string, number>()
    for (const row of rows) {
      const key = (row.setName ?? "") + "||" + (row.playerName ?? "") + "||" + getParallel(row)
      countMap.set(key, (countMap.get(key) ?? 0) + 1)
    }
    const dupKeys = new Set<string>()
    countMap.forEach(function(count, key) { if (count > 1) dupKeys.add(key) })
    return dupKeys
  }, [rows])

  const filteredRows = useMemo(function() {
    const q = searchWithin.trim().toLowerCase()
    const filtered = rows.filter(function(r) {
      if (playerFilter !== "all" && r.playerName !== playerFilter) return false
      if (setFilter !== "all" && normalizeSetName(r.setName) !== setFilter) return false
      if (seriesFilter !== "all" && seriesFilterLabel(r.series, collectionSeriesMap) !== seriesFilter) return false
      if (rarityFilter !== "all" && r.tier !== rarityFilter) return false
      if (lockedFilter === "locked" && !getLocked(r)) return false
      if (lockedFilter === "unlocked" && getLocked(r)) return false
      if (badgeFilter && !r.badgeInfo?.badge_score) return false
      if (filterBadges && !(r.officialBadges?.length || (r as any).badgeScore > 0)) return false
      if (filterHasOffer && !(typeof r.bestOffer === "number" && r.bestOffer > 0)) return false
      if (filterListed && r.lowAsk == null) return false
      // Task 14: filter to duplicates only
      if (filterDupsOnly) {
        const key = (r.setName ?? "") + "||" + (r.playerName ?? "") + "||" + getParallel(r)
        if (!duplicateEditions.has(key)) return false
      }
      if (q) {
        const haystack = [r.playerName, r.team ?? "", r.league ?? "", r.series ?? "", r.setName, getParallel(r), r.tier ?? "", ...(r.officialBadges ?? []), ...(r.badgeInfo?.badge_titles ?? []), ...getTraits(r)].join(" ").toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    // Only apply client-side sort for non-server-sortable columns.
    // Server-sortable columns (fmv, serial, acquired) are already sorted by the API.
    const serverSortableKeys: SortKey[] = ["fmv", "serial", "acquired", "paid"]
    if (!serverSortableKeys.includes(sortKey)) {
      filtered.sort(function(a, b) {
        let result = 0
        switch (sortKey) {
          case "player":    result = compareText(a.playerName, b.playerName); break
          case "series":    result = compareText(a.series, b.series); break
          case "set":       result = compareText(a.setName, b.setName); break
          case "parallel":  result = compareText(getParallel(a), getParallel(b)); break
          case "rarity":    result = compareText(a.tier, b.tier); break
          case "bestOffer": result = compareNumber(a.bestOffer, b.bestOffer); break
          case "badge":     result = compareNumber(a.badgeInfo?.badge_score, b.badgeInfo?.badge_score); break
          case "held":
            result = compareNumber(
              a.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(a))?.owned,
              b.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(b))?.owned
            ); break
        }
        return sortDirection === "asc" ? result : -result
      })
    }
    return filtered
  }, [rows, searchWithin, playerFilter, setFilter, seriesFilter, rarityFilter, lockedFilter, badgeFilter, filterBadges, filterHasOffer, filterListed, filterDupsOnly, duplicateEditions, sortKey, sortDirection, batchEditionStats, collectionSeriesMap])

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



  const nearCompleteSets = useMemo(function() {
    if (!setsData?.sets) return []
    return setsData.sets
      .filter(function(s: any) { return s.missingCount >= 1 && s.missingCount <= 3 && s.completionPct >= 50 })
      .sort(function(a: any, b: any) { return a.missingCount - b.missingCount })
      .slice(0, 3)
  }, [setsData])

  // Restore dismissed state from sessionStorage
  useEffect(function() {
    try {
      if (sessionStorage.getItem("rpc_dup_dismissed") === "true") setDupDismissed(true)
    } catch {}
  }, [])


  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-zinc-100 overflow-x-hidden">
      <Suspense fallback={null}>
        <AutoSearchReader onSearch={runSearch} collectionSlug={collectionSlug} />
      </Suspense>

      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

        {/* Profile key indicator */}
        {ownerKey && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            Signed in as <span className="font-semibold text-white">{/^0x[a-fA-F0-9]{16}$/.test(ownerKey) ? ownerKey.slice(0, 6) + "\u2026" + ownerKey.slice(-4) : ownerKey}</span>
            <span className="ml-1 text-zinc-600">· Loading wallet will update your profile stats</span>
          </div>
        )}

        {/* Search bar */}
        <div className="mb-5 flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={function(e) { setInput(e.target.value) }}
            onKeyDown={function(e) { if (e.key === "Enter" && !loading && input.trim()) handleSearch() }}
            placeholder={ownerKey ? "Enter Top Shot username or wallet address (or press Enter to load your wallet)" : "Enter Top Shot username or wallet address"}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none placeholder:text-zinc-500 sm:max-w-lg"
            style={{ ["--accent" as string]: accent }}
            onFocus={function(e) { e.currentTarget.style.borderColor = accent }}
            onBlur={function(e) { e.currentTarget.style.borderColor = "" }}
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
              className="rounded-lg px-5 py-2 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {loading ? "Loading..." : "Search"}
            </button>
            {rows.length > 0 && input.trim() && (
              <button
                onClick={function() {
                  const shareUrl = "https://rip-packs-city.vercel.app/share/" + encodeURIComponent(input.trim())
                  navigator.clipboard.writeText(shareUrl)
                  setCopied(true)
                  setTimeout(function() { setCopied(false) }, 2000)
                }}
                title="Copy shareable collection card link"
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 transition"
              >
                {copied ? "Link copied!" : "Share"}
              </button>
            )}
          </div>
        </div>

        {/* Portfolio summary */}
        {hasSearched && rows.length > 0 && (
          <div className="mb-5 space-y-3">
            <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">

              {/* Wallet FMV — authoritative total from get_wallet_summary() when available */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <span>Wallet FMV</span>
                  {walletSummaryLoading && <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600 animate-pulse" />}
                  <ExplainButton context={`Wallet ${connectedWallet || ownerKey || input.trim()} on ${collectionSlug}`} question="How is my total portfolio FMV calculated?" />
                </div>
                <div className="text-xl font-black text-white">
                  {(function() {
                    const fmvVal = walletSummary ? walletSummary.wallet_fmv : (walletTotalFmv !== null ? walletTotalFmv : totals.totalFmv)
                    if (fmvVal > 0) return formatCurrency(fmvVal)
                    return "N/A"
                  })()}
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {(paginatedTotal || totals.totalCount) + " moments"}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <span>Unlocked FMV</span>
                  {walletSummaryLoading && <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600 animate-pulse" />}
                </div>
                {(function() {
                  const unlockedFmv = walletSummary ? walletSummary.unlocked_fmv : totals.unlockedFmv
                  const unlockedCount = walletSummary ? walletSummary.unlocked_count : totals.unlockedCount
                  return (
                    <>
                      <div className="text-xl font-black text-white">{unlockedFmv > 0 ? formatCurrency(unlockedFmv) : "N/A"}</div>
                      <div className="mt-1 text-[11px] text-zinc-500">{unlockedCount} unlocked</div>
                    </>
                  )
                })()}
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <span>Locked FMV</span>
                  {walletSummaryLoading && <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600 animate-pulse" />}
                </div>
                {(function() {
                  const lockedFmv = walletSummary ? walletSummary.locked_fmv : totals.lockedFmv
                  const lockedCount = walletSummary ? walletSummary.locked_count : totals.lockedCount
                  const fmvLabel = walletSummary
                    ? (lockedFmv > 0 ? formatCurrency(lockedFmv) : "$0")
                    : (lockedFmv > 0 ? formatCurrency(lockedFmv) : "N/A")
                  return (
                    <>
                      <div className="text-xl font-black text-white">{fmvLabel}</div>
                      <div className="mt-1 text-[11px] text-zinc-500">{lockedCount} locked</div>
                    </>
                  )
                })()}
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Best Offer Total</div>
                <div className="text-xl font-black text-white">{totals.totalBestOffer > 0 ? formatCurrency(totals.totalBestOffer) : "N/A"}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{totals.totalFmv > 0 && totals.totalBestOffer > 0 ? "Spread gap: " + formatCurrency(totals.spreadGap) : ""}</div>
              </div>
            </div>

            {acquisitionStats && acquisitionStats.total_count > 0 && (
              <div className="grid grid-cols-3 gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">From Packs</span>
                  <span className="text-lg font-black" style={{ color: "rgb(20,184,166)" }}>{acquisitionStats.pack_pull_count.toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-l border-zinc-800 pl-3">
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">From Market</span>
                  <span className="text-lg font-black text-zinc-300">{acquisitionStats.marketplace_count.toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-l border-zinc-800 pl-3">
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">Rewards</span>
                  <span className="text-lg font-black" style={{ color: "rgb(245,158,11)" }}>{acquisitionStats.challenge_reward_count.toLocaleString()}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cost basis / P&L summary */}
        {hasSearched && (walletSummary?.cost_basis ? walletSummary.cost_basis > 0 : (costBasis.size > 0 || rows.some(function(r) { return r.costBasis != null }))) && (function() {
          let totalCost: number
          let totalFmv: number
          let totalPl: number
          let count = 0
          if (walletSummary && walletSummary.cost_basis > 0) {
            totalCost = walletSummary.cost_basis
            totalFmv = walletSummary.wallet_fmv
            totalPl = walletSummary.pnl
            for (const row of rows) {
              const cb = costBasis.get(row.flowId ?? "")
              const rowBasis = cb ? cb.buyPrice : (row.costBasis ?? 0)
              if (rowBasis > 0) count++
            }
          } else {
            totalCost = 0
            totalFmv = 0
            for (const row of rows) {
              const cb = costBasis.get(row.flowId ?? "")
              const rowBasis = cb ? cb.buyPrice : (row.costBasis ?? 0)
              if (rowBasis > 0 && row.fmv && row.fmv > 0) {
                totalCost += rowBasis
                totalFmv += row.fmv
                count++
              }
            }
            totalPl = totalFmv - totalCost
          }
          if (totalCost === 0) return null
          const plPct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0
          const plColor = totalPl >= 0 ? "text-emerald-400" : "text-red-400"
          return (
            <div className="flex flex-wrap gap-6 items-center mb-4 p-3 rounded-lg border border-zinc-800 bg-zinc-950 text-sm font-mono">
              <div><span className="text-zinc-500">Cost Basis:</span> <span className="text-white">${totalCost.toFixed(2)}</span></div>
              <div><span className="text-zinc-500">Current FMV:</span> <span className="text-white">${totalFmv.toFixed(2)}</span></div>
              <div><span className="text-zinc-500">P&amp;L:</span> <span className={plColor}>{totalPl >= 0 ? "+" : ""}{totalPl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(0)}%)</span></div>
              {walletSummary && walletSummary.cost_basis > 0
                ? <div className="text-zinc-600 text-xs">wallet-wide totals</div>
                : <div className="text-zinc-600 text-xs">{count} moments with cost data</div>}
            </div>
          )
        })()}

        {/* Close to Completing callout */}
        {nearCompleteSets.length > 0 && hasSearched && (
          <div style={{ borderLeft: "3px solid #22c55e", background: "#09090b", borderRadius: 6, padding: "10px 14px", marginBottom: 12 }}>
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
            {collectionSeriesOptions.length > 0
              ? collectionSeriesOptions.map(function(s) { return <option key={s.seriesNumber} value={s.label}>{s.label}</option> })
              : Object.entries(SERIES_FILTER_LABEL_FALLBACK).map(function([num, label]) { return <option key={num} value={label}>{label}</option> })
            }
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
            ["paid", "Paid"],
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
          {/* Task 6: CSV Export */}
          {filteredRows.length > 0 && (
            <button
              onClick={function() {
                const PRO_ALLOWLIST = ["0xbd94cade097e50ac"]
                const wallet = connectedWallet || ownerKey || input.trim()
                if (!PRO_ALLOWLIST.includes(wallet.toLowerCase())) {
                  alert("Export is a Pro feature. Contact trevor@rippackscity.com for early access.")
                  return
                }
                const headers = ["Player","Set","Series","Tier","Parallel","Serial","Circulation","FMV","Low Ask","Best Offer","Badges","Acquired"]
                const csvRows = filteredRows.map(function(r) {
                  return [
                    r.playerName ?? "",
                    normalizeSetName(r.setName) ?? "",
                    seriesDisplayLabel(r.series, collectionSeriesMap),
                    r.tier ?? "",
                    getParallel(r),
                    String(getSerial(r) ?? ""),
                    String(getMint(r) ?? ""),
                    r.fmv != null ? r.fmv.toFixed(2) : "",
                    r.lowAsk != null ? r.lowAsk.toFixed(2) : "",
                    r.bestOffer != null ? r.bestOffer.toFixed(2) : "",
                    (r.badgeInfo?.badge_titles ?? []).join("; "),
                    formatAcquiredAt(r.acquiredAt),
                  ].map(function(cell) { return '"' + String(cell).replace(/"/g, '""') + '"' }).join(",")
                })
                const csvString = headers.join(",") + "\n" + csvRows.join("\n")
                const dateStr = new Date().toISOString().slice(0, 10)
                const filename = "rpc-collection-" + (wallet || "unknown") + "-" + dateStr + ".csv"
                const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = filename
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-900"
            >
              Export CSV
            </button>
          )}
          {filteredRows.length > 0 && (
            <a
              href={"/api/portfolio-export?wallet=" + encodeURIComponent(connectedWallet || ownerKey || input.trim()) + "&collection=" + encodeURIComponent(collectionSlug)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-900 inline-flex items-center gap-1 font-mono"
              title="Download all moments as CSV"
            >
              ⬇ Full CSV
            </a>
          )}
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

        {/* Main table / mobile cards */}
        {isMobile ? (
          <div className="flex flex-col gap-2">
            {filteredRows.map(function(row) {
              const expanded = !!expandedRows[row.momentId]
              const fmv = fmvDisplay(row)
              const mIsThreeStar = !!row.badgeInfo?.is_three_star_rookie
              const supaBadgesMraw = (row.badgeInfo?.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) })
              const supaBadges = mIsThreeStar ? supaBadgesMraw.filter(function(t) { return !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) }) : supaBadgesMraw
              const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
              const editionCounts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
              const cbMap = costBasis.get(row.flowId ?? "")
              const cb = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, acquiredDate: row.acquiredAt ?? "", fmvAtAcquisition: null, acquisitionMethod: row.acquisitionMethod ?? null, costBasisLabel: row.costBasisLabel ?? null } : undefined)
              const tierColorMap: Record<string, string> = { COMMON: "#9ca3af", UNCOMMON: "#14b8a6", FANDOM: "#60a5fa", RARE: "#38bdf8", LEGENDARY: "#fbbf24", ULTIMATE: "#c084fc" }
              const tierBg: Record<string, string> = { COMMON: "bg-zinc-800", UNCOMMON: "bg-teal-950", FANDOM: "bg-blue-950", RARE: "bg-sky-950", LEGENDARY: "bg-yellow-950", ULTIMATE: "bg-purple-950" }
              const tierKey = (row.tier ?? "").toUpperCase()
              return (
                <div key={row.momentId} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 flex flex-col gap-1.5 cursor-pointer" onClick={function() { toggleExpanded(row.momentId) }}>
                  {/* Row 1: Player + Tier + Chevron */}
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-white text-sm truncate mr-2">{row.playerName}</span>
                    <div className="flex items-center gap-1.5">
                      {row.tier && (
                        <span className={"rounded px-1.5 py-0.5 text-[10px] font-bold shrink-0 " + (tierBg[tierKey] ?? "bg-zinc-800")} style={{ color: tierColorMap[tierKey] ?? "#9ca3af" }}>
                          {row.tier}
                        </span>
                      )}
                      <a
                        href={"/profile?pin=" + row.momentId}
                        onClick={function(e) { e.stopPropagation(); }}
                        title="Pin to Trophy Case"
                        className="shrink-0 rounded hover:bg-zinc-900"
                        style={{ fontSize: 11, padding: "2px 6px", color: "#F59E0B", opacity: 0.5, transition: "opacity 0.15s", textDecoration: "none", lineHeight: 1 }}
                        onMouseEnter={function(e) { e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={function(e) { e.currentTarget.style.opacity = "0.5"; }}
                      >📌</a>
                      <span className="text-zinc-500 text-xs shrink-0">{expanded ? "▾" : "›"}</span>
                    </div>
                  </div>
                  {/* Row 2: Set + Series */}
                  <div className="text-xs text-zinc-400">
                    {normalizeSetName(row.setName)} &middot; {seriesIntToSeason(row.series, collectionSeriesMap) || "—"}
                  </div>
                  {/* Row 3: Serial, Badges */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono text-white">#{getSerial(row) ?? "-"}<span className="text-zinc-500">/{getMint(row) ?? "-"}</span></span>
                      {getLocked(row) && <span title="Locked" style={{ opacity: 0.6, fontSize: 11 }} aria-label="Locked">🔒</span>}
                      <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} />
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-center">
                      {supaBadges.map(function(title) { return <BadgeIcon key={"m-" + title} title={title} /> })}
                    </div>
                  </div>
                  {/* Row 4: FMV, Low Ask, Cost/P&L */}
                  <div className="flex items-center justify-between gap-2">
                    <span className={"text-sm font-mono " + (fmv.muted ? "text-zinc-500" : "text-green-400")}>{fmv.text}</span>
                    {row.lowAsk != null && (
                      <span className="text-xs text-zinc-400">Ask ${row.lowAsk.toFixed(2)}</span>
                    )}
                    {cb ? (function() {
                      const label = cb.costBasisLabel
                      if (label === "Pack") return <span className="inline-block rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600">PACK</span>
                      if (label === "Gift") return <span className="inline-block rounded border border-blue-900 bg-blue-900 px-1.5 py-0.5 font-mono text-[10px] text-blue-400">GIFT</span>
                      if (label === "Reward") return <span className="inline-block rounded border border-purple-900 bg-purple-900 px-1.5 py-0.5 font-mono text-[10px] text-purple-400">REWARD</span>
                      if (label === "Airdrop") return <span className="inline-block rounded border border-green-900 bg-green-900 px-1.5 py-0.5 font-mono text-[10px] text-green-400">AIRDROP</span>
                      const basis = label === "Loan" ? cb.buyPrice : cb.buyPrice
                      if (basis > 0 && row.fmv) {
                        const pl = row.fmv - basis
                        const plPct = basis > 0 ? (pl / basis) * 100 : 0
                        const color = pl >= 0 ? "text-emerald-400" : "text-red-400"
                        return (
                          <div className="text-right">
                            <div className="text-xs font-mono text-zinc-400">{label === "Loan" ? <span className="text-amber-400">Loan </span> : null}${basis.toFixed(2)}</div>
                            <div className={"text-[10px] font-mono " + color}>{pl >= 0 ? "+" : ""}{pl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(0)}%)</div>
                          </div>
                        )
                      }
                      return null
                    })() : null}
                  </div>
                  {/* Expanded content */}
                  {expanded && (
                    <div className="mt-2 pt-2 border-t border-zinc-800">
                      <div className="grid gap-3 grid-cols-1">
                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Market</div>
                          <div className="space-y-1 text-sm">
                            <div>Low Ask: {formatCurrency(row.lowAsk ?? getBestAsk(row))}</div>
                            <div>Best Offer: {formatCurrency(row.bestOffer ?? row.editionBestOffer)}</div>
                            <div>FMV: {fmv.text} <ExplainButton context={`${row.playerName ?? ""} — ${row.setName ?? ""} (${row.editionKey ?? ""}) FMV ${fmv.text}`} question="How is this FMV calculated?" /></div>
                            <div>Confidence: {confidenceLabel(row.marketConfidence).label} <ExplainButton context={`${row.playerName ?? ""} — confidence ${confidenceLabel(row.marketConfidence).label}`} question="What does this confidence level mean?" /></div>
                            <div>Held: {editionCounts.owned} / Locked: {editionCounts.locked}</div>
                          </div>
                        </div>
                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Links</div>
                          <div className="space-y-2">
                            <a href={"https://nbatopshot.com/moment/" + row.momentId} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">View on Top Shot</a>
                            <a href={"https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/" + row.momentId} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs text-white hover:bg-zinc-900">View on Flowty</a>
                          </div>
                        </div>
                        <EditionRecentSales editionKey={row.editionKey ?? null} mintCount={getMint(row)} />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {summary && summary.remainingMoments > 0 && isMobile && (
              <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-500">
                Showing {rows.length} of {summary.totalMoments} moments — open on desktop for full collection
              </div>
            )}
          </div>
        ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950">
         <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead className="bg-zinc-900">
              <tr className="border-b border-zinc-800 text-left">
                <th className="p-3">Player</th>
                <th className="p-3 hidden sm:table-cell">Set</th>
                <th className="p-3 hidden sm:table-cell text-left">Series</th>
                <th className="p-3 hidden md:table-cell">Parallel</th>
                <th className="p-3 hidden md:table-cell">Rarity</th>
                <th className="p-3 hidden sm:table-cell">Serial / Mint</th>
                <th className="p-3 hidden lg:table-cell">Held / Locked</th>
                <th className="p-3 hidden xl:table-cell">Packs</th>
                <th className="p-3 whitespace-nowrap">FMV</th>
                <th className="p-3 hidden xl:table-cell">Paid</th>
                <th className="p-3 hidden xl:table-cell">P&amp;L</th>
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
                const isThreeStar = !!row.badgeInfo?.is_three_star_rookie
                const supaBadgesRaw = (row.badgeInfo?.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) })
                const supaBadges = isThreeStar ? supaBadgesRaw.filter(function(t) { return !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) }) : supaBadgesRaw
                const officialBadgesRaw = row.officialBadges ?? []
                const officialBadges = officialBadgesRaw
                  .map(function(b) { return BADGE_TYPE_TO_TITLE[b] ?? null })
                  .filter(function(t: string | null): t is string { return t !== null && BADGE_PILL_TITLES.has(t) })
                  .filter(function(t: string) { return !isThreeStar || !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) })
                const fmv = fmvDisplay(row)
                const conf = confidenceLabel(row.marketConfidence)
                const isLocked = getLocked(row)

                return (
                  <Fragment key={row.momentId}>
                    <tr onClick={function(e) { const t = e.target as HTMLElement; if (t.closest("a,button,input,svg,video")) return; setSelectedMoment(row) }} className={"group border-b border-zinc-800 align-top cursor-pointer " + (row.tier?.toUpperCase() === "LEGENDARY" ? " rpc-holo-legendary" : row.tier?.toUpperCase() === "ULTIMATE" ? " rpc-holo-ultimate" : row.tier?.toUpperCase() === "RARE" ? " rpc-holo-rare" : "")}>
                      <td className="p-3 min-w-[160px]">
                        <div className="flex items-center gap-2">
                          {(() => {
                            const thumbUrl = getThumbnailUrl(row, collectionSlug)
                            const tierColorForPrev = ({ COMMON: "#9ca3af", UNCOMMON: "#14b8a6", FANDOM: "#60a5fa", RARE: "#38bdf8", LEGENDARY: "#fbbf24", ULTIMATE: "#c084fc" } as Record<string, string>)[(row.tier ?? "").toUpperCase()] ?? "#9ca3af"
                            return (
                              <div className="relative shrink-0" style={{ width: 48, height: 64 }}>
                                {thumbUrl ? (
                                  <ThumbnailPreview thumbUrl={thumbUrl} playerName={row.playerName} tierColor={tierColorForPrev}>
                                    <img
                                      src={thumbUrl}
                                      alt={row.playerName}
                                      width={48}
                                      height={64}
                                      loading="lazy"
                                      className="rounded object-cover bg-zinc-900 cursor-pointer"
                                      style={{ width: 48, height: 64 }}
                                      onClick={function(e) { e.stopPropagation(); setSelectedMoment(row) }}
                                      onError={function(e) { (e.target as HTMLImageElement).style.display = "none" }}
                                    />
                                  </ThumbnailPreview>
                                ) : (
                                  <div className="rounded bg-zinc-900" style={{ width: 48, height: 64 }} />
                                )}
                                {isLocked && (
                                  <div className="absolute inset-0 rounded bg-zinc-900/60 flex items-center justify-center">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                          <div>
                            <div className="font-semibold text-white text-sm">
                              <span>{row.playerName}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1 items-center">
                              {officialBadges.map(function(title) { return <BadgeIcon key={"official-" + title} title={title} /> })}
                              {supaBadges.map(function(title) { return <BadgeIcon key={"supa-" + title} title={title} /> })}
                              {row.badgeInfo?.is_three_star_rookie && row.badgeInfo?.has_rookie_mint && (
                                <BadgeIcon title="Three-Star Rookie" />
                              )}
                            </div>
                            {row.acquisitionMethod && (() => {
                                const acqConfig: Record<string, { label: string; icon: string; prefix?: string; color: string }> = {
                                  pack_pull: { label: "PACK", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", color: "20,184,166" },
                                  marketplace: { label: "MKT", icon: "", color: "161,161,170" },
                                  challenge_reward: { label: "REWARD", icon: "M12 15l-2 5h4l-2-5zm-4-3a4 4 0 0 1 8 0H8zm-2-2h12l1-2H5l1 2zm3-4h6V3H9v3z", color: "245,158,11" },
                                  gift: { label: "GIFT", icon: "", prefix: "🎁 ", color: "168,85,247" },
                                  loan_default: { label: "LOAN", icon: "", color: "245,158,11" },
                                  airdrop: { label: "AIRDROP", icon: "", color: "52,211,153" },
                                  unknown: { label: "? UNVERIFIED", icon: "", color: "113,113,122" },
                                }
                                const cfg = acqConfig[row.acquisitionMethod!]
                                if (!cfg) return null
                                return (
                                  <div className="mt-1">
                                    <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "rgba(" + cfg.color + ",0.12)", color: "rgba(" + cfg.color + ",0.9)", border: "1px solid rgba(" + cfg.color + ",0.3)" }}>
                                      {cfg.icon && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={cfg.icon}/></svg>}
                                      {cfg.prefix ?? ""}{cfg.label}
                                    </span>
                                  </div>
                                )
                              })()}
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-sm hidden sm:table-cell">{normalizeSetName(row.setName)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden sm:table-cell">{seriesDisplayLabel(row.series, collectionSeriesMap)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{getParallel(row)}</td>
                      <td className="p-3 text-zinc-400 text-sm hidden md:table-cell">{row.tier ?? "—"}</td>
                      <td className="p-3 hidden sm:table-cell">
                        <div className={"inline-flex min-w-[80px] flex-col rounded-lg border px-2 py-1 " + (primaryBadge ? "" : "border-zinc-800 bg-black")} style={primaryBadge ? { borderColor: accent, backgroundColor: accent + "1A" } : undefined}>
                          <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} />
                          <div className={"text-sm font-black flex items-center gap-1 " + (primaryBadge ? "" : "text-white")} style={primaryBadge ? { color: accent } : undefined}>
                            <span>{"#" + (getSerial(row) ?? "-")}</span>
                            {isLocked && (
                              <span title="This moment is locked on Dapper" style={{ opacity: 0.6, fontSize: 11 }} aria-label="Locked">🔒</span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-400">{"/ " + (getMint(row) ?? "-")}</div>
                          {primaryBadge ? <div className="mt-1 rounded bg-white px-1 py-0.5 text-[9px] font-bold text-black">{primaryBadge}</div> : null}
                        </div>
                      </td>
                      <td className="p-3 text-sm hidden lg:table-cell">
                        <div>{editionCounts.owned} / {editionCounts.locked}</div>
                        {isLocked && <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Locked</span>}
                        {row.badgeInfo && row.badgeInfo.circulation_count > 0 && !(row.badgeInfo.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") && (
                          <div className="mt-1 text-[10px] text-zinc-500 font-mono leading-tight" title={"Minted: " + row.badgeInfo.circulation_count + " · Owned: " + row.badgeInfo.owned + " · For Sale: " + (row.badgeInfo.for_sale_by_collectors ?? "?") + " · In Packs: " + row.badgeInfo.hidden_in_packs + " · Burned: " + row.badgeInfo.burned}>
                            <span>{row.badgeInfo.circulation_count.toLocaleString()} minted</span>
                            {row.badgeInfo.burned > 0 && <span className="text-red-400"> · {row.badgeInfo.burned} burned</span>}
                            {row.badgeInfo.hidden_in_packs > 0 && <span> · {row.badgeInfo.hidden_in_packs} in packs</span>}
                          </div>
                        )}
                        {(row.badgeInfo?.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") && (
                          <div className="mt-1 text-[10px] text-purple-400 font-mono">1/1</div>
                        )}
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
                      <td className="p-3 min-w-[90px] whitespace-nowrap">
                        <div className={"font-semibold text-sm " + (fmv.muted ? "text-zinc-500" : "text-white")}>{fmv.text}</div>
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
                      <td className="p-3 text-sm hidden xl:table-cell">
                        {(function() {
                          const cbMap = costBasis.get(row.flowId ?? "")
                          const cb = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, acquiredDate: row.acquiredAt ?? "", fmvAtAcquisition: null, acquisitionMethod: row.acquisitionMethod ?? null, costBasisLabel: row.costBasisLabel ?? null } : undefined)
                          const src = (row.acquisitionSource ?? "").toLowerCase()
                          const TS_SOURCES = new Set(["browser_backfill", "smm_final", "wallet_search", "progressive_classify", "sales_backfill"])
                          let sourcePill: React.ReactNode = null
                          if (src.includes("flowty")) {
                            sourcePill = <span className="ml-1 inline-flex items-center rounded px-1 py-0 font-mono text-[9px] font-semibold" style={{ color: "#14B8A6", border: "1px solid rgba(20,184,166,0.35)", background: "rgba(20,184,166,0.10)" }}>Flowty</span>
                          } else if (src && TS_SOURCES.has(src)) {
                            sourcePill = <span className="ml-1 inline-flex items-center rounded px-1 py-0 font-mono text-[9px] font-semibold text-[color:var(--rpc-red)]" style={{ border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)" }}>TS</span>
                          }
                          if (cb) {
                            const label = cb.costBasisLabel
                            if (label === "Bought" && cb.buyPrice > 0) return <span className="font-mono text-white">${cb.buyPrice.toFixed(2)}{sourcePill}</span>
                            if (label === "Pack") return <span className="inline-block rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600">PACK</span>
                            if (label === "Loan" && cb.buyPrice > 0) return <span className="font-mono"><span className="text-amber-400">Loan</span> <span className="text-white">${cb.buyPrice.toFixed(2)}</span>{sourcePill}</span>
                            if (label === "Gift") return <span className="inline-block rounded border border-blue-900 bg-blue-900 px-1.5 py-0.5 font-mono text-[10px] text-blue-400">GIFT</span>
                            if (label === "Reward") return <span className="inline-block rounded border border-purple-900 bg-purple-900 px-1.5 py-0.5 font-mono text-[10px] text-purple-400">REWARD</span>
                            if (label === "Airdrop") return <span className="inline-block rounded border border-green-900 bg-green-900 px-1.5 py-0.5 font-mono text-[10px] text-green-400">AIRDROP</span>
                            if (cb.buyPrice > 0) return <span className="font-mono text-white">${cb.buyPrice.toFixed(2)}{sourcePill}</span>
                          }
                          if (row.lastPurchasePrice != null && row.lastPurchasePrice > 0) return <span className="font-mono text-zinc-300">{formatCurrency(row.lastPurchasePrice)}{sourcePill}</span>
                          return <span className="text-zinc-700">—</span>
                        })()}
                      </td>
                      <td className="p-3 text-sm hidden xl:table-cell">
                        {(function() {
                          const currentFmv = row.fmv
                          if (!currentFmv) return <span className="text-zinc-600">—</span>
                          const cbMap = costBasis.get(row.flowId ?? "")
                          const cbObj = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, costBasisLabel: row.costBasisLabel ?? null } : undefined)
                          const cbBasis = cbObj ? (cbObj.costBasisLabel === "Bought" ? cbObj.buyPrice : cbObj.costBasisLabel === "Loan" ? cbObj.buyPrice : 0) : 0
                          const basis = cbBasis > 0 ? cbBasis : (row.lastPurchasePrice != null && row.lastPurchasePrice > 0 ? row.lastPurchasePrice : 0)
                          if (!basis || basis <= 0) return <span className="text-zinc-600">—</span>
                          const pl = currentFmv - basis
                          const plPct = basis > 0 ? (pl / basis) * 100 : 0
                          const color = pl >= 0 ? "text-emerald-400" : "text-red-400"
                          return (
                            <div className={"font-mono " + color}>
                              <div>{pl >= 0 ? "+" : ""}{pl.toFixed(2)}</div>
                              <div className="text-[10px]">{pl >= 0 ? "+" : ""}{plPct.toFixed(0)}%</div>
                            </div>
                          )
                        })()}
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
                        ) : row.editionLowAsk != null ? (
                          <span style={{ color: row.fmv && row.editionLowAsk < row.fmv ? "#22c55e" : "#9ca3af" }}>
                            ${row.editionLowAsk.toFixed(2)}
                            <span className="ml-1 text-[10px] text-zinc-500">floor</span>
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
                          const displayEdBestOffer = (typeof row.editionBestOffer === "number" && row.editionBestOffer > 0) ? row.editionBestOffer : null
                          const best = displayOffer && displayEdOffer
                            ? (displayOffer >= displayEdOffer ? { val: displayOffer, label: row.bestOfferType ?? "serial" } : { val: displayEdOffer, label: "edition" })
                            : displayOffer ? { val: displayOffer, label: row.bestOfferType ?? "offer" }
                            : displayEdOffer ? { val: displayEdOffer, label: "edition" }
                            : displayEdBestOffer ? { val: displayEdBestOffer, label: "edition" }
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
                      <td className="p-3 text-zinc-500 text-xs hidden xl:table-cell">
                        <div>{formatAcquiredAt(row.acquiredAt)}</div>
                        {(() => {
                          const acqPillMap: Record<string, { label: string; cls: string }> = {
                            pack_pull:        { label: "PACK",    cls: "bg-green-950 text-green-300 border border-green-800" },
                            marketplace:      { label: "MKT",     cls: "bg-zinc-800 text-zinc-400 border border-zinc-700" },
                            challenge_reward: { label: "REWARD",  cls: "bg-amber-950 text-amber-300 border border-amber-800" },
                            gift:             { label: "🎁 GIFT", cls: "bg-purple-950 text-purple-300 border border-purple-700" },
                            loan_default:     { label: "LOAN",    cls: "bg-orange-950 text-orange-300 border border-orange-800" },
                            airdrop:          { label: "AIRDROP", cls: "bg-emerald-950 text-emerald-300 border border-emerald-800" },
                          }
                          const cfg = row.acquisitionMethod ? acqPillMap[row.acquisitionMethod] : null
                          if (!cfg) return null
                          return <span className={"mt-0.5 inline-block text-[9px] font-bold px-1 py-0.5 rounded " + cfg.cls}>{cfg.label}</span>
                        })()}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5 relative">
                          <button onClick={function() { toggleExpanded(row.momentId) }} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-white hover:bg-zinc-900">
                            {expanded ? "Hide" : "Show"}
                          </button>
                          {/* Task 2: FMV Alert bell */}
                          <button
                            onClick={function(e) { e.stopPropagation(); if (alertOpenMomentId === row.momentId) { setAlertOpenMomentId(null) } else { setAlertOpenMomentId(row.momentId); setAlertTargetPrice(row.fmv ? (Math.round(row.fmv * 0.85 * 100) / 100).toString() : ""); setAlertNotifType("email"); setAlertStatus("idle"); setAlertError("") } }}
                            className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-900"
                            title="Set FMV alert"
                            style={{ color: alertOpenMomentId === row.momentId ? accent : "#a1a1aa" }}
                          >
                            {"\uD83D\uDD14"}
                          </button>
                          {alertOpenMomentId === row.momentId && (
                            <div onClick={function(e) { e.stopPropagation() }} style={{ position: "absolute", top: "100%", right: 0, zIndex: 50, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, padding: 12, width: 240, marginTop: 4 }}>
                              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "#71717a", letterSpacing: "0.1em", marginBottom: 8 }}>SET FMV ALERT</div>
                              <div style={{ marginBottom: 8 }}>
                                <label style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa", display: "block", marginBottom: 4 }}>Target Price ($)</label>
                                <input type="number" min="0" step="0.01" value={alertTargetPrice} onChange={function(e) { setAlertTargetPrice(e.target.value) }} style={{ width: "100%", background: "#09090b", border: "1px solid #3f3f46", borderRadius: 6, padding: "6px 8px", color: "#fff", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
                              </div>
                              <div style={{ marginBottom: 10 }}>
                                <label style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa", display: "block", marginBottom: 4 }}>Notify via</label>
                                <div style={{ display: "flex", gap: 8 }}>
                                  {(["email", "in-app"] as const).map(function(t) {
                                    return <label key={t} style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: alertNotifType === t ? "#fff" : "#71717a", cursor: "pointer" }}><input type="radio" name="alert-notif" checked={alertNotifType === t} onChange={function() { setAlertNotifType(t) }} style={{ accentColor: accent }} />{t === "email" ? "Email" : "In-app"}</label>
                                  })}
                                </div>
                              </div>
                              {alertStatus === "success" && <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#4ade80", marginBottom: 6 }}>Alert set!</div>}
                              {alertStatus === "error" && <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#f87171", marginBottom: 6 }}>{alertError || "Failed"} <a href="mailto:trevor@rippackscity.com?subject=RPC%20Pro%20Early%20Access" style={{ color: accent, textDecoration: "underline" }}>Upgrade to Pro</a></div>}
                              <button
                                disabled={alertStatus === "saving"}
                                onClick={function() {
                                  setAlertStatus("saving")
                                  const ownerWallet = connectedWallet || ownerKey || input.trim()
                                  fetch("/api/alerts", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      owner_key: ownerWallet,
                                      edition_key: row.editionKey || "",
                                      player_name: row.playerName,
                                      set_name: row.setName,
                                      alert_type: "below_price",
                                      threshold: parseFloat(alertTargetPrice) || 0,
                                      channel: alertNotifType === "email" ? "email" : "telegram",
                                    }),
                                  })
                                    .then(function(r) { if (!r.ok) throw new Error("not_pro"); return r.json() })
                                    .then(function() { setAlertStatus("success"); setTimeout(function() { setAlertOpenMomentId(null) }, 1500) })
                                    .catch(function(err) { setAlertStatus("error"); setAlertError(err.message === "not_pro" ? "Upgrade to Pro to set unlimited alerts" : "Failed to set alert") })
                                }}
                                style={{ width: "100%", background: accent, color: "#fff", border: "none", borderRadius: 6, padding: "7px 0", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", opacity: alertStatus === "saving" ? 0.5 : 1 }}
                              >
                                {alertStatus === "saving" ? "Setting..." : "Set Alert"}
                              </button>
                            </div>
                          )}
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
                        <td colSpan={16} className="p-4">
                          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Market</div>
                              <div className="space-y-1 text-sm">
                                <div>Top Shot Ask: {formatCurrency(row.topshotAsk ?? row.editionLowAsk)}</div>
                                <div>Flowty Ask: {formatCurrency(row.flowtyAsk)}</div>
                                <div>Best Ask: {formatCurrency(getBestAsk(row) ?? row.editionLowAsk)}</div>
                                <div>Best Market: {row.bestMarket ?? (row.editionMarketSource ? row.editionMarketSource : "-")}</div>
                                <div>Best Offer: {formatCurrency(row.bestOffer ?? row.editionBestOffer)}</div>
                                <div>FMV: {fmv.text}</div>
                                <div>FMV Method: {row.fmvMethod === "band" ? "WAP (high confidence)" : row.fmvMethod === "low-ask-only" ? "WAP (medium)" : row.fmvMethod === "best-offer-only" ? "Floor/Ask price" : row.fmvMethod === "none" ? "-" : (row.fmvMethod ?? "-")}</div>
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
                                {/* TODO: team_name from UUID-keyed Flowty editions is often wrong. Long-term fix: add team column to wallet_moments_cache and prefer that over editions.team_name */}
                                <div>Team: {row.team ?? "-"}</div>
                                <div>League: {row.league ?? "-"}</div>
                                <div>Parallel: {getParallel(row)}</div>
                                <div>Series: {row.series ?? "-"} ({seriesIntToSeason(row.series, collectionSeriesMap) || "—"})</div>
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
                                    {(row.badgeInfo.badge_titles ?? [])
                                      .filter(function(t) { return BADGE_PILL_TITLES.has(t) })
                                      .filter(function(t) { return !row.badgeInfo?.is_three_star_rookie || !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) })
                                      .map(function(title) { return <BadgeIcon key={title} title={title} /> })}
                                  </div>
                                  <div className="pt-1 text-xs text-zinc-500">
                                    <div>Burn rate: {row.badgeInfo.burn_rate_pct.toFixed(1)}%</div>
                                    <div>Lock rate: {row.badgeInfo.lock_rate_pct.toFixed(1)}%</div>
                                    {(row.badgeInfo.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") ? (
                                      <div className="text-purple-400">1/1 Ultimate</div>
                                    ) : (
                                      <>
                                        <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>
                                        {row.badgeInfo.effective_supply != null && <div>Effective supply: {row.badgeInfo.effective_supply.toLocaleString()}</div>}
                                        {row.badgeInfo.owned > 0 && <div>Owned: {row.badgeInfo.owned.toLocaleString()}</div>}
                                        {row.badgeInfo.for_sale_by_collectors != null && <div>For sale: {row.badgeInfo.for_sale_by_collectors.toLocaleString()}</div>}
                                        {row.badgeInfo.hidden_in_packs > 0 && <div>In packs: {row.badgeInfo.hidden_in_packs.toLocaleString()}</div>}
                                        {row.badgeInfo.burned > 0 && <div>Burned: {row.badgeInfo.burned.toLocaleString()}</div>}
                                      </>
                                    )}
                                    {row.badgeInfo.low_ask != null && <div>Edition ask: {formatCurrency(row.badgeInfo.low_ask)}</div>}
                                  </div>
                                </div>
                              </div>
                            ) : showDebug ? (
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
                            ) : null}
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
        </div>
        )}

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

        {paginatedPage < paginatedTotalPages ? (
          <div className="mt-6 flex flex-col items-center gap-2">
            <button onClick={handleLoadMore} disabled={loadingMore} className="rounded-lg px-4 py-2 font-semibold text-white disabled:opacity-50" style={{ backgroundColor: accent }}>
              {loadingMore ? "Loading..." : "Load More (" + (paginatedTotal - rows.length) + " remaining)"}
            </button>
            <span className="text-xs text-zinc-600">
              Showing {rows.length} of {paginatedTotal} moments
            </span>
          </div>
        ) : hasSearched && paginatedTotal > 0 ? (
          <div className="mt-4 text-center text-xs text-zinc-600">
            All {paginatedTotal} moments loaded
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
      <MomentDetailModal
        moment={selectedMoment ? {
          flowId: selectedMoment.flowId ?? selectedMoment.momentId,
          playerName: selectedMoment.playerName,
          setName: selectedMoment.setName,
          tier: selectedMoment.tier ?? null,
          serialNumber: getSerial(selectedMoment) ?? null,
          mintSize: getMint(selectedMoment) ?? null,
          fmv: selectedMoment.fmv ?? null,
          listingPrice: selectedMoment.lowAsk ?? null,
          marketConfidence: selectedMoment.marketConfidence ?? null,
          badgeTitles: selectedMoment.badgeInfo?.badge_titles ?? [],
          officialBadges: (selectedMoment.officialBadges ?? []).map(function(b) { return BADGE_TYPE_TO_TITLE[b] ?? b }),
          imageUrlPrefix: null,
          buyUrl: selectedMoment.momentId ? "https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/" + selectedMoment.momentId : null,
        } : null}
        onClose={function() { setSelectedMoment(null) }}
      />
    </div>
  )
}