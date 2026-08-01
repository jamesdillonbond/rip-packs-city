// Pure formatting / mapping helpers for the dashboard (app/dashboard/page.tsx),
// which is a "use client" page monolith outside the coverage include. Extracted
// verbatim so the primary ratchet measures them and a regression in what a
// collector reads on their own dashboard — a mis-formatted USD figure, a
// corrupted Solana address, a wrong tier color — reddens CI.
//
// Bodies are byte-identical to the former app/dashboard/page.tsx locals; the
// page imports them from here now. NOTE: fmtUsd/tierColor deliberately keep the
// dashboard's own behavior (they differ subtly from the similarly-named helpers
// in lib/market-format + lib/analytics/format — e.g. this fmtUsd rounds >=1000
// with no cents and returns "$0" for falsy) — do not "unify" them without
// checking each call site.

import { isSolanaAddress } from "@/lib/address"
import { publishedCollections, getCollection } from "@/lib/collections"

export function fmtUsd(n: number): string {
  if (!n) return "$0"
  if (n >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + n.toFixed(2)
}

export function truncateAddress(addr: string): string {
  if (!addr) return ""
  // Solana (base58) addresses have no 0x prefix and must not get one glued on —
  // doing so corrupts the displayed address for a Candy/Solana wallet.
  const clean = addr.startsWith("0x") || isSolanaAddress(addr) ? addr : "0x" + addr
  if (clean.length <= 12) return clean
  return clean.slice(0, 6) + "…" + clean.slice(-4)
}

export function tierColor(tier?: string | null): string {
  switch ((tier || "").toLowerCase()) {
    case "ultimate":
    case "moment_tier_ultimate":
      return "#EC4899"
    case "legendary":
    case "moment_tier_legendary":
      return "#F59E0B"
    case "rare":
    case "moment_tier_rare":
      return "#818CF8"
    case "fandom":
    case "moment_tier_fandom":
      return "#34D399"
    case "common":
    case "moment_tier_common":
      return "#9CA3AF"
    default:
      return "#6B7280"
  }
}

export function tierHoloClass(tier?: string | null): string {
  const t = (tier || "").toLowerCase()
  if (t.includes("ultimate")) return "rpc-holo-ultimate"
  if (t.includes("legendary")) return "rpc-holo-legendary"
  if (t.includes("rare")) return "rpc-holo-rare"
  return ""
}

export function collectionMetaByUuid(uuid: string) {
  for (const c of publishedCollections()) {
    if (c.supabaseCollectionId === uuid) return c
  }
  return null
}

export function collectionMetaBySlug(slug: string) {
  // collection_slug from RPC may use underscores (e.g. "nba_top_shot")
  const normalized = slug.replace(/_/g, "-")
  return getCollection(normalized) ?? null
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired"
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}
