// Pure helpers + constants for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx). Extracted verbatim in
// the Phase 1 structural refactor — behavior-preserving, no logic change.
import { normalizeParallel } from "@/lib/wallet-normalize"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { isAskDerivedFmv } from "@/lib/fmv-basis"
import type { MomentRow, CollectionSeriesEntry, SortKey } from "./types"

export const ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR = new Set(["Rookie Year", "Rookie Premiere", "Rookie Mint"])

// ── Constants ─────────────────────────────────────────────────────────────────

export const BADGE_PILL_TITLES = new Set([
  "Rookie Year", "Rookie Premiere", "Top Shot Debut",
  "Rookie of the Year", "Rookie Mint", "Championship Year",
])

// Fallback Top Shot series maps — used when collection_series data is not yet loaded
export const SERIES_INT_TO_SEASON: Record<number, string> = {
  0: "2019-20", 2: "2020-21", 3: "2021",
  4: "2021-22", 5: "2022-23", 6: "2023-24", 7: "2024-25", 8: "2025-26",
}

export const SERIES_DISPLAY_FALLBACK: Record<number, string> = {
  0: "S1 · 2019-20",
  2: "S2 · 2020-21",
  3: "Sum 21 · 2021",
  4: "S3 · 2021-22",
  5: "S4 · 2022-23",
  6: "23-24 · 2023-24",
  7: "24-25 · 2024-25",
  8: "25-26 · 2025-26",
}

export const SERIES_FILTER_LABEL_FALLBACK: Record<number, string> = {
  0: "Series 1", 2: "Series 2", 3: "Summer 2021",
  4: "Series 3", 5: "Series 4", 6: "Series 2023-24",
  7: "Series 2024-25", 8: "Series 2025-26",
}

export function seriesDisplayLabel(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
  if (!seriesRaw) return "—"
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && seriesMap?.has(n)) {
    const entry = seriesMap.get(n)!
    return entry.season ? entry.display_label + " · " + entry.season : entry.display_label
  }
  if (!Number.isNaN(n) && SERIES_DISPLAY_FALLBACK[n] !== undefined) return SERIES_DISPLAY_FALLBACK[n]
  return seriesRaw
}

export function seriesFilterLabel(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
  if (!seriesRaw) return "—"
  const n = parseInt(seriesRaw, 10)
  if (!Number.isNaN(n) && seriesMap?.has(n)) return seriesMap.get(n)!.display_label
  if (!Number.isNaN(n) && SERIES_FILTER_LABEL_FALLBACK[n] !== undefined) return SERIES_FILTER_LABEL_FALLBACK[n]
  return seriesRaw
}

export function seriesIntToSeason(seriesRaw: string | undefined | null, seriesMap?: Map<number, CollectionSeriesEntry>): string {
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

export function formatAcquiredAt(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function compareText(a?: string | null, b?: string | null) { return (a ?? "").localeCompare(b ?? "") }
export function compareNumber(a?: number | null, b?: number | null) { return (a ?? -Infinity) - (b ?? -Infinity) }
export function getParallel(row: MomentRow) { return normalizeParallel(row.parallel ?? row.subedition ?? "") }
export function getSerial(row: MomentRow) { return row.serialNumber ?? row.serial ?? null }
export function getMint(row: MomentRow) { return row.mintCount ?? row.mintSize ?? null }
export function getTraits(row: MomentRow) { return row.specialSerialTraits ?? row.traits ?? [] }
export function getLocked(row: MomentRow) { return Boolean(row.isLocked ?? row.locked) }

// Map the sort UI state (SortKey + direction) to the server's `sortBy` param.
// Only fmv/serial/acquired/paid are server-sortable; every other key is sorted
// client-side, so this only needs those four (with an fmv fallback). A wrong
// mapping here silently sorts the wallet grid the wrong way.
export function sortKeyToServerSort(key: SortKey, dir: "asc" | "desc"): string {
  switch (key) {
    case "fmv": return dir === "asc" ? "fmv_asc" : "fmv_desc"
    case "serial": return "serial_asc"
    case "acquired": return "recent"
    case "paid": return dir === "asc" ? "paid_asc" : "paid_desc"
    default: return dir === "asc" ? "fmv_asc" : "fmv_desc"
  }
}

// The dedupe key a moment groups under for the "duplicates only" filter:
// set + player + parallel printing. Kept next to getParallel so the filter and
// the count use exactly the same key.
export function duplicateGroupKey(row: MomentRow): string {
  return (row.setName ?? "") + "||" + (row.playerName ?? "") + "||" + getParallel(row)
}

// The set of duplicateGroupKeys that appear more than once in the wallet — drives
// the "duplicates only" toggle. Pure over the row list.
export function computeDuplicateEditionKeys(rows: MomentRow[]): Set<string> {
  const countMap = new Map<string, number>()
  for (const row of rows) {
    const key = duplicateGroupKey(row)
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }
  const dupKeys = new Set<string>()
  countMap.forEach((count, key) => { if (count > 1) dupKeys.add(key) })
  return dupKeys
}

export function proxyTopShotThumb(url: string): string {
  // Rewrite direct Top Shot CDN URLs through our proxy to bypass hotlink blocks.
  const m = url.match(/^https:\/\/assets\.nbatopshot\.com\/media\/([a-zA-Z0-9_-]+)(?:\/image)?(?:\?.*width=(\d+))?/)
  if (!m) return url
  const flowId = m[1]
  const width = m[2] ? parseInt(m[2], 10) : 180
  return `/api/moment-thumbnail?flowId=${encodeURIComponent(flowId)}&width=${width}`
}

export function getThumbnailUrl(row: MomentRow, collectionSlug?: string): string | null {
  // UFC moments store slow ipfs.io URLs on the edition — route them through the
  // edge-cached same-origin proxy so they paint reliably (P3).
  if (collectionSlug === "ufc") return proxyIpfsUrl(row.thumbnailUrl) ?? null
  // ⚠ `/api/moment-thumbnail` is `assets.nbatopshot.com/media/<flowId>` — a TOP
  // SHOT resource keyed on a TOP SHOT moment id. Measured 2026-09-06 on the
  // founder's wallet, real Chromium: on /laliga-golazos/collection 45 of 47
  // tiles 404'd through it (Golazos ids are not Top Shot ids), and on
  // /nfl-all-day/collection every tile loaded — WRONG: All Day moment 1652251
  // rendered Top Shot moment 1652251's art, an id collision across two
  // collections that no 404 could ever surface. Any collection that is not Top
  // Shot renders its own edition art; only Top Shot goes through the proxy.
  if (collectionSlug && collectionSlug !== "nba-top-shot") {
    if (!row.thumbnailUrl) return null
    return proxyIpfsUrl(row.thumbnailUrl) ?? row.thumbnailUrl
  }
  // Always route through the proxy — the CDN returns non-error responses for
  // hotlink blocks, so <img onError> fallbacks never fire.
  if (row.momentId) {
    return `/api/moment-thumbnail?flowId=${encodeURIComponent(row.momentId)}&width=180`
  }
  if (row.thumbnailUrl) return proxyTopShotThumb(row.thumbnailUrl)
  return null
}

export function getBestAsk(row: MomentRow) {
  const values = [row.lowAsk, row.bestAsk, row.topshotAsk].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0
  )
  return values.length ? Math.min(...values) : null
}

export function getPrimarySerialBadge(row: MomentRow) {
  const traits = getTraits(row)
  if (traits.includes("#1")) return "#1"
  if (traits.includes("Perfect Mint")) return "Perfect Mint"
  if (traits.includes("Jersey Match")) return "Jersey Match"
  return null
}

export function debugReasonLabel(reason?: string | null) {
  switch (reason) {
    case "OK": return "OK"
    case "NO_LOW_ASK": return "No low ask"
    case "NO_BEST_OFFER": return "No best offer"
    case "NO_MARKET_INPUTS": return "No market inputs"
    case "SPECIAL_SERIAL_NO_BASE": return "No serial base"
    default: return reason ?? "—"
  }
}

export function confidenceLabel(conf?: string | null): { label: string; color: string } {
  switch (conf) {
    case "high":       return { label: "Liquid",   color: "text-emerald-400" }
    case "medium":     return { label: "Trading",  color: "text-yellow-400" }
    case "low":        return { label: "Thin",     color: "text-orange-400" }
    case "stale":      return { label: "Stale",    color: "text-amber-500" }
    case "ask_only":   return { label: "Ask only", color: "text-sky-400" }
    case "sales_only": return { label: "Sales",    color: "text-sky-400" }
    // NO_DATA editions have no recent sales to price against — keep the moment
    // visible (a grail shouldn't vanish) but label it honestly as unpriced.
    case "no_data":    return { label: "Unpriced", color: "text-[color:var(--rpc-text-muted)]" }
    case "none":       return { label: "Illiquid", color: "text-[color:var(--rpc-text-muted)]" }
    default:           return { label: "—",        color: "text-[color:var(--rpc-text-muted)]" }
  }
}

export function fmvDisplay(row: MomentRow): { text: string; muted: boolean; stale: boolean; askDerived: boolean } {
  const fmv = row.fmv ?? (typeof row.fmvUsd === "number" && row.fmvUsd > 0 ? row.fmvUsd : null)
  if (fmv === null || fmv === undefined || fmv === 0) return { text: "—", muted: true, stale: false, askDerived: false }
  const stale = String(row.marketConfidence ?? "").toLowerCase() === "stale"
  // ASK_ONLY = 0.9x a single seller's ask on an edition that never traded; the
  // caller renders the sanctioned plain-words "from asks" marker (lib/fmv-basis).
  const askDerived = isAskDerivedFmv(row.marketConfidence)
  return { text: "$" + fmv.toFixed(2), muted: stale, stale, askDerived }
}
