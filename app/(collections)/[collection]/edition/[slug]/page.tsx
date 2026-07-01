// app/(collections)/[collection]/edition/[slug]/page.tsx
// Phase 1B. Edition detail page for all 5 published collections.
//
// Data: get_edition_detail + get_edition_recent_sales + get_edition_fmv_history
// + get_edition_in_packs server-side. Special serials read directly from
// special_serial_holders for non-Pinnacle collections.

import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"
import LoadingState from "@/components/ui/LoadingState"
import { getCollectionByUrlSlug, isPinnacleUrlSlug } from "@/lib/collection-slug"
import { editionPageMetadata, editionJsonLd, collectionDisplayName } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import MomentHeroMedia from "@/components/MomentHeroMedia"
import PackThumb from "@/components/packs/PackThumb"
import { slugifyName } from "@/lib/entity-labels"
import { normalizeBadgeKey } from "@/lib/badges/normalize"
import { fetchBadgeArt } from "@/lib/badges/server-art"
import {
  ConfidencePill,
  EM_DASH,
  FmvBasis,
  Section,
  StatCell,
  TierBadge,
  WalletLink,
  fmtCount,
  fmtPercent,
  fmtUsd,
  relTime,
} from "@/components/entity/_shared"
import FmvHistoryChart from "@/components/entity/FmvHistoryChart"
import SalesTablePaginated from "@/components/entity/SalesTablePaginated"
import { MarketplaceStatusBanner } from "@/components/marketplace-status"
import WatchEditionButton from "@/components/alerts/WatchEditionButton"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface EditionDetail {
  id: string
  source: string | null
  collection_id: string
  collection_slug: string
  route_slug: string
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  set_slug: string | null
  tier: string | null
  series_label: string | null
  series_num: number | null
  edition_kind: string | null
  circulation_count: number | null
  badges: string[] | null
  thumbnail_url: string | null
  video_url: string | null
  team_name: string | null
  first_minted_at: string | null
  fmv: {
    fmv_usd: number | null
    floor_price_usd: number | null
    wap_usd: number | null
    confidence: string | null
    computed_at: string | null
    sales_count_30d: number | null
    days_since_sale: number | null
    cross_market_ask?: number | null
    // PIN-FMV-REKEY Wave 2: per-render spread for Pinnacle set-level keys.
    fmv_min?: number | null
    fmv_max?: number | null
    render_count?: number | null
  } | null
  is_serialized?: boolean
  is_chaser?: boolean
  live_ask?: { price: number | null; source: string | null; updated_at: string | null } | null
}

interface SaleRow {
  serial_number: number | null
  price_usd: number | null
  marketplace: string | null
  source: string | null
  buyer_address: string | null
  seller_address: string | null
  nft_id: string | null
  transaction_hash: string | null
  sold_at: string | null
}

interface HistoryRow {
  day: string
  fmv_usd: number | null
  wap_usd: number | null
  floor_usd: number | null
  confidence: string | null
  sales_count_30d: number | null
  computed_at: string | null
}

interface PackRow {
  dist_id: string
  drop_weight: number | null
  slot_name: string | null
  last_refreshed_at: string | null
  pack_title: string | null
  pack_image_url: string | null
  total_minted: number | null
  total_sealed: number | null
  depletion_pct: number | null
}

interface SpecialSerialRow {
  badge_type: string
  serial_number: number
  holder_address: string | null
  last_verified_at: string | null
}

interface HighOffer {
  highest_offer: number | null
  low_ask: number | null
  updated_at: string | null
}

interface ParallelEdition {
  id: string
  external_id: string | null
  set_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  set_id_onchain: number | null
  player_name: string | null
}

// Subedition (parallel) sibling — same setID:playID base, different printing
// (Standard / Hexwave / Jukebox / …). Each is its OWN edition with its own
// circulation + per-parallel FMV. Distinct from ParallelEdition above (which is
// same-play / DIFFERENT-set). Powers the "Parallel Printings" ladder.
interface SubeditionSibling {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  confidence: string | null
  is_self: boolean
}

const SALES_PAGE_SIZE = 30

// The ~6,404 inert UUID-keyed Top Shot fossil editions resolve through
// get_edition_detail but are thin near-duplicates of the canonical int-pair
// editions (NULL on-chain ids, no thumbnail, no FMV) — Google flags them as
// duplicate-canonical. Canonical TS slugs are `setID:playID` (no hyphen); the
// fossils are `<uuid>:<uuid>` (hyphenated). 404 them so the crawler drops the
// cluster cleanly. Scoped to Top Shot ONLY — UFC's canonical ids are uuid-like.
function isTopShotFossilSlug(collection: string, decodedSlug: string): boolean {
  return collection === "nba-top-shot" && decodedSlug.includes("-")
}

// Collection-aware label for the lowest-ask cell. The value source differs per
// collection (Top Shot marketplace ask vs the V1-Dapper cross-market ask), so
// the label must not say "Top Shot ask" on a non-Top-Shot page.
const ASK_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot ask",
  "nfl-all-day": "All Day ask",
  "laliga-golazos": "Golazos ask",
  "disney-pinnacle": "Pinnacle ask",
  "ufc-strike": "UFC ask",
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  from: (t: string) => unknown
}

function rpcClient() {
  return supabaseAdmin as unknown as RpcClient
}

async function fetchDetail(collectionId: string, routeSlug: string): Promise<EditionDetail | null> {
  const { data, error } = await rpcClient().rpc("get_edition_detail", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
  })
  if (error) {
    console.error("[edition] get_edition_detail error", error.message)
    return null
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as EditionDetail) ?? null
  return data as EditionDetail
}

async function fetchSales(collectionId: string, routeSlug: string, limit: number, offset = 0): Promise<SaleRow[]> {
  const { data, error } = await rpcClient().rpc("get_edition_recent_sales", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error("[edition] sales error", error.message); return [] }
  return Array.isArray(data) ? (data as SaleRow[]) : []
}

async function fetchHistory(collectionId: string, routeSlug: string, days: number): Promise<HistoryRow[]> {
  const { data, error } = await rpcClient().rpc("get_edition_fmv_history", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
    p_days: days,
  })
  if (error) { console.error("[edition] history error", error.message); return [] }
  return Array.isArray(data) ? (data as HistoryRow[]) : []
}

async function fetchPacks(collectionId: string, routeSlug: string): Promise<PackRow[]> {
  const { data, error } = await rpcClient().rpc("get_edition_in_packs", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
  })
  if (error) { console.error("[edition] packs error", error.message); return [] }
  return Array.isArray(data) ? (data as PackRow[]) : []
}

// Pack provenance (Top Shot + All Day) — what share of this edition's circulation
// we've observed entering the market via pack opens. Reads the public
// v_topshot_edition_pull_provenance / v_allday_edition_pull_provenance views
// keyed by edition_id. Window-bounded (TS ~Apr 2026 →, AllDay ~Jun 2026 →) and
// undercounts because not every pulled NFT resolves to its edition, so this is a
// directional "pack-distributed" signal, not a precise fraction (copy reflects that).
interface PackProvenanceRow {
  pack_pulls_observed: number | null
  distinct_packs: number | null
  observed_pull_share_pct: number | null
  first_pull_at: string | null
  last_pull_at: string | null
}

async function fetchPackProvenance(editionId: string, isAllDay: boolean): Promise<PackProvenanceRow | null> {
  const view = isAllDay ? "v_allday_edition_pull_provenance" : "v_topshot_edition_pull_provenance"
  const client = rpcClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (client.from(view) as any)
    .select("pack_pulls_observed, distinct_packs, observed_pull_share_pct, first_pull_at, last_pull_at")
    .eq("edition_id", editionId)
    .maybeSingle()
  const { data, error } = await q
  if (error) { console.error("[edition] pack provenance", error.message); return null }
  return (data ?? null) as PackProvenanceRow | null
}

async function fetchSpecialSerials(editionId: string): Promise<SpecialSerialRow[]> {
  const client = rpcClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (client.from("special_serial_holders") as any)
    .select("badge_type, serial_number, holder_address, last_verified_at")
    .eq("edition_id", editionId)
    .order("badge_type", { ascending: true })
    .order("serial_number", { ascending: true })
  const { data, error } = await q
  if (error) { console.error("[edition] special_serials", error.message); return [] }
  return (data ?? []) as SpecialSerialRow[]
}

// Item 3b — the deterministic notable-serial breakdown (tags + last sale) from
// get_edition_special_serials. Complements special_serial_holders (which carries
// the tracked OWNER, omitted from this RPC's v1 due to partial coverage) — the
// page merges the two by serial.
interface NotableSerialRow {
  serial: number
  tag: string
  last_sale_usd: number | null
  last_sold_at: string | null
  // Current holder from wallet_moments_cache where we've indexed that serial
  // (added 2026-06-13 — fills the owner column the empty special_serial_holders
  // table never could).
  holder_address: string | null
  nft_id: string | null
}

async function fetchNotableSerials(editionId: string): Promise<NotableSerialRow[]> {
  const { data, error } = await rpcClient().rpc("get_edition_special_serials", { p_edition_id: editionId })
  if (error) { console.error("[edition] notable_serials", error.message); return [] }
  return Array.isArray(data) ? (data as NotableSerialRow[]) : []
}

// Resolve owner wallet addresses → @username so the Special Serials owner cell
// matches the Recent Sales rows (which resolve usernames client-side). The
// special-serials section is server-rendered, so we read wallet_usernames here.
// (Item 7, 2026-06-22 audit.)
async function fetchOwnerUsernames(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const lowered = Array.from(new Set(addresses.filter(Boolean).map((a) => a.toLowerCase())))
  if (lowered.length === 0) return out
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (rpcClient().from("wallet_usernames") as any)
    .select("wallet_addr, username")
    .in("wallet_addr", lowered)
    .not("username", "is", null)
  if (error) { console.error("[edition] owner_usernames", error.message); return out }
  for (const r of (data ?? []) as Array<{ wallet_addr: string; username: string | null }>) {
    if (r.wallet_addr && r.username) out.set(r.wallet_addr.toLowerCase(), r.username)
  }
  return out
}

async function fetchHighOffer(editionId: string): Promise<HighOffer | null> {
  const { data, error } = await rpcClient().rpc("get_edition_high_offer", { p_edition_id: editionId })
  if (error) { console.error("[edition] high_offer", error.message); return null }
  if (Array.isArray(data) && data.length > 0) return data[0] as HighOffer
  if (data && typeof data === "object") return data as HighOffer
  return null
}

async function fetchParallels(editionId: string): Promise<ParallelEdition[]> {
  const { data, error } = await rpcClient().rpc("get_edition_parallels", { p_edition_id: editionId })
  if (error) { console.error("[edition] parallels", error.message); return [] }
  return Array.isArray(data) ? (data as ParallelEdition[]) : []
}

// Top Shot subedition (parallel) ladder — siblings sharing setID:playID, each
// with its own circulation + per-parallel FMV. Only TS int-pair(::sub) keys;
// other collections + UUID fossils return []. (Stage B parallel split, 2026-06-20)
async function fetchSubeditionSiblings(externalId: string | null): Promise<SubeditionSibling[]> {
  if (!externalId || !/^\d+:\d+(::\d+)?$/.test(externalId)) return []
  const { data, error } = await rpcClient().rpc("get_edition_subedition_siblings", { p_external_id: externalId })
  if (error) { console.error("[edition] subedition_siblings", error.message); return [] }
  return Array.isArray(data) ? (data as SubeditionSibling[]) : []
}

// "Featured in Insights" membership — Top Shot only. Reads the same public
// boards the /insights surfaces render (security_invoker views, anon SELECT):
// squeeze_pct (topshot_squeeze_board), discount_pct (topshot_deals_vs_fmv,
// keyed on external_id), and the first-mint multiplier
// (topshot_first_mint_trophies). Closes the entity → insights link direction.
interface InsightLinks {
  squeeze_pct: number | null
  deal_pct: number | null
  first_mint_x: number | null
}

const EMPTY_INSIGHT_LINKS: InsightLinks = { squeeze_pct: null, deal_pct: null, first_mint_x: null }

async function fetchInsightLinks(editionId: string, externalId: string | null): Promise<InsightLinks> {
  const client = rpcClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = (table: string, col: string, keyCol: string, keyVal: string): Promise<any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.from(table) as any).select(col).eq(keyCol, keyVal).limit(1)
  try {
    const [sq, dl, fm] = await Promise.all([
      sel("topshot_squeeze_board", "squeeze_pct", "edition_id", editionId),
      externalId
        ? sel("topshot_deals_vs_fmv", "discount_pct", "external_id", externalId)
        : Promise.resolve({ data: null }),
      sel("topshot_first_mint_trophies", "multiplier", "edition_id", editionId),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (res: any) => (Array.isArray(res?.data) ? res.data[0] : null)
    return {
      squeeze_pct: first(sq)?.squeeze_pct ?? null,
      deal_pct: first(dl)?.discount_pct ?? null,
      first_mint_x: first(fm)?.multiplier ?? null,
    }
  } catch (e) {
    console.error("[edition] insight_links", e instanceof Error ? e.message : String(e))
    return EMPTY_INSIGHT_LINKS
  }
}

// Media verified on IPFS — Top Shot only. As of 2026-06-08 Dapper pins every
// Moment's video + artwork to IPFS; the CIDs live in topshot_ipfs_assets
// (anon-readable). Keyed on the on-chain int pair (set_flow_id, play_flow_id)
// with parallel='Base'. Absence is normal (WNBA + very new drops aren't in
// Dapper's bundle yet) — render nothing rather than implying anything is wrong.
interface IpfsAsset {
  video_cid: string | null
  hero_cid: string | null
}

async function fetchIpfsAssets(collection: string, slug: string): Promise<IpfsAsset | null> {
  if (collection !== "nba-top-shot") return null
  // TS edition slug is the int pair "setID:playID" (already decodeURIComponent'd).
  const parts = slug.split(":")
  if (parts.length !== 2) return null
  const setId = Number(parts[0])
  const playId = Number(parts[1])
  if (!Number.isInteger(setId) || !Number.isInteger(playId)) return null
  const client = rpcClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client.from("topshot_ipfs_assets") as any)
    .select("video_cid, hero_cid")
    .eq("set_flow_id", setId)
    .eq("play_flow_id", playId)
    .eq("parallel", "Base")
    .limit(1)
  if (error) { console.error("[edition] ipfs_assets", error.message); return null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (Array.isArray(data) ? data[0] : null) as IpfsAsset | null
  if (!row || (!row.video_cid && !row.hero_cid)) return null
  return row
}

const IPFS_GATEWAY = "https://ipfs.dapperlabs.com/ipfs/"

// First 10 + last 8 chars of the CID, so the link reads as a fingerprint
// without wrapping. base32 CIDv1 strings are ~59 chars.
function truncateCid(cid: string): string {
  return cid.length <= 20 ? cid : `${cid.slice(0, 10)}…${cid.slice(-8)}`
}

function IpfsCidRow({ label, cid }: { label: string; cid: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "6px 0" }}>
      <span className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)", minWidth: 90 }}>{label}</span>
      <a
        href={`${IPFS_GATEWAY}${cid}`}
        target="_blank"
        rel="noopener noreferrer"
        className="rpc-mono"
        style={{ fontSize: 12, color: "var(--rpc-red)", textDecoration: "none", wordBreak: "break-all" }}
      >
        {truncateCid(cid)} →
      </a>
    </div>
  )
}

const INSIGHT_CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  border: "1px solid var(--rpc-red-border, var(--rpc-border))",
  background: "var(--rpc-red-bg, rgba(224,58,47,0.08))",
  borderRadius: 4,
  fontSize: 12,
  letterSpacing: "0.04em",
  color: "var(--rpc-red)",
  textDecoration: "none",
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; slug: string }> }
): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  // Pinnacle edition pages are retired in favor of the render-keyed per-pin
  // surface at /pinnacle/moment/<render_id> (which also disambiguates legacy
  // set-level keys). Funnel all Pinnacle edition URLs there. (Item 2, 2026-06-26.)
  if (isPinnacleUrlSlug(collection)) permanentRedirect(`/pinnacle/moment/${encodeURIComponent(slug)}`)
  if (isTopShotFossilSlug(collection, slug)) return {}
  const detail = await fetchDetail(coll.id, slug)
  if (!detail) return {}
  return editionPageMetadata(detail as unknown as Record<string, unknown>, collection)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function EditionPage(
  props: { params: Promise<{ collection: string; slug: string }> }
) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()
  // Pinnacle edition pages → the render-keyed per-pin page (Item 2, 2026-06-26).
  // The moment page resolves a render_id directly and a legacy set-level key to a
  // disambiguation list, so no Pinnacle edition URL ever shows an arbitrary pin.
  if (isPinnacleUrlSlug(collection)) permanentRedirect(`/pinnacle/moment/${encodeURIComponent(slug)}`)
  if (isTopShotFossilSlug(collection, slug)) notFound()

  const detail = await fetchDetail(coll.id, slug)
  if (!detail) notFound()

  const isPinnacle = isPinnacleUrlSlug(collection)

  // Fast shell — only the cheap single-row / aggregate RPCs the hero + FMV strip
  // need. The heavy bottom sections (recent sales, parallels, packs, special
  // serials + owner-username resolution) stream in below via <Suspense>, so the
  // headline FMV paints after ~1 RPC instead of waiting on the full fan-out. The
  // route loading.tsx ("SCANNING THE MARKETPLACE…") now only covers this shell.
  // (2026-06-23 — decouple FMV display from the slower market fetches.)
  const [history, highOffer, insightLinks, ipfsAssets, badgeArt, subSiblings, repSales] = await Promise.all([
    fetchHistory(coll.id, slug, 30),
    fetchHighOffer(detail.id),
    collection === "nba-top-shot"
      ? fetchInsightLinks(detail.id, detail.external_id)
      : Promise.resolve(EMPTY_INSIGHT_LINKS),
    fetchIpfsAssets(collection, slug),
    // Real badge artwork (SVGs) keyed by normalized title; absent titles fall
    // back to the existing text pill. (2026-06-15)
    fetchBadgeArt(detail.badges ?? [], coll.id),
    // Top Shot subedition (parallel) ladder — Standard + each ::sub printing.
    fetchSubeditionSiblings(detail.external_id),
    // One representative sale → the resilient hero-media nft id (the
    // media/<nftId>/image form that survives the legacy-CDN 404s). The full
    // sales page is fetched in the streamed bottom block.
    fetchSales(coll.id, slug, 1, 0),
  ])

  // The current edition's own parallel printing (Hexwave/Jukebox/… or Standard)
  // and whether a multi-printing ladder exists. Drives the hero chip + module.
  const currentSibling = subSiblings.find((s) => s.is_self) ?? null
  const hasParallelLadder = subSiblings.length >= 2

  const hasInsightLinks =
    insightLinks.squeeze_pct != null ||
    insightLinks.deal_pct != null ||
    insightLinks.first_mint_x != null

  const fmv = detail.fmv
  const fmvAvailable = fmv && fmv.fmv_usd !== null
  const setHref = detail.set_slug ? `/${collection}/set/${encodeURIComponent(detail.set_slug)}` : null
  const playerHref = detail.player_name ? `/${collection}/player/${encodeURIComponent(slugifyName(detail.player_name))}` : null
  const teamHref = detail.team_name ? `/${collection}/team/${encodeURIComponent(slugifyName(detail.team_name))}` : null

  // 24h delta from history (latest day vs day prior).
  let dayDelta: number | null = null
  if (history.length >= 2) {
    const last = history[history.length - 1]?.fmv_usd
    const prev = history[history.length - 2]?.fmv_usd
    if (last !== null && prev !== null && prev !== 0 && last !== undefined && prev !== undefined) {
      dayDelta = ((last - prev) / prev) * 100
    }
  }

  const isAllDay = collection === "nfl-all-day"
  const hasVideo = (collection === "nba-top-shot" || collection === "nfl-all-day") && !!detail.video_url

  // Resilient hero media (Item E, 2026-06-13 audit — parity with the /moment
  // hero). detail.thumbnail_url / video_url are the constructed
  // assets.nbatopshot.com/editions/<set>/<play>/… URLs that 404 on the CDN for
  // many legacy (Series 1-4) Top Shot editions, leaving a blank box. The
  // per-moment media/<nftId>/image form works for any serial of the edition, so
  // we use a representative NFT id (a tracked special-serial holder, else a
  // recent sale) as the primary candidate, then fall back to the stored
  // thumbnail. MomentHeroMedia advances candidates on load error and hides a
  // 404ing video to reveal the image underneath.
  const isTopShotColl = collection === "nba-top-shot"
  const repNftId =
    repSales.find(s => s.nft_id && /^\d+$/.test(s.nft_id))?.nft_id ?? null
  const tsHeroImg =
    isTopShotColl && repNftId
      ? `https://assets.nbatopshot.com/media/${repNftId}/image?width=1080`
      : null
  const heroImageCandidates = [tsHeroImg, detail.thumbnail_url].filter((u): u is string => !!u)

  // Team moments carry no player_name — the subject is the team. Fall back to
  // team_name before the raw edition name so the hero/breadcrumb never read
  // blank or generic. Item 3 (2026-06-11). (play_type isn't in get_edition_detail,
  // so the edition title is the team; the moment page adds "<team> <play>".)
  const editionTitle =
    (detail.player_name && detail.player_name.trim())
      ? detail.player_name
      : (detail.team_name && detail.team_name.trim())
        ? detail.team_name
        : (detail.name ?? "Edition")

  // Ask cell (H2/H3): prefer the marketplace low_ask; fall back to the
  // V1-Dapper cross-market ask (populated for ~2.7K All Day editions where
  // badge_editions.low_ask is null). Label is collection-aware.
  const askValue = highOffer?.low_ask ?? fmv?.cross_market_ask ?? null
  const askLabel = ASK_LABEL[collection] ?? "Floor ask"
  // Best-offer cell (H1): only render when there's a real positive offer.
  // edition_offers is Top-Shot-only today, so an em-dash here would be a
  // permanent placeholder on every other collection.
  const hasBestOffer = typeof highOffer?.highest_offer === "number" && highOffer.highest_offer > 0

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(editionJsonLd(detail as unknown as Record<string, unknown>, collection, highOffer?.low_ask ?? null)) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          ...(setHref && detail.set_name ? [{ name: detail.set_name, href: setHref }] : []),
          { name: editionTitle },
        ]}
      />
      <div style={{ marginBottom: 14 }}>
        <MarketplaceStatusBanner collectionSlug={collection} />
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18 }}>
        <div className="rpc-entity-hero">
          <div style={{ position: "relative", width: "100%", maxWidth: 320, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden" }}>
            <MomentHeroMedia
              imageCandidates={heroImageCandidates}
              videoUrl={hasVideo ? detail.video_url : null}
              alt={editionTitle}
              placeholder={
                // Branded placeholder for artless editions (~54% TS thumbnail
                // coverage) so the empty media box reads as intentional, not broken.
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "linear-gradient(135deg, rgba(224,58,47,0.08), rgba(0,0,0,0.45))" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.08em", color: "var(--rpc-red)", opacity: 0.55 }}>RPC</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>No preview</div>
                </div>
              }
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {playerHref ? (
                <Link href={playerHref} style={{ color: "inherit", textDecoration: "none" }}>{detail.player_name ?? detail.name ?? "Edition"}</Link>
              ) : editionTitle}
            </h1>

            {(detail.set_name || setHref) && (
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, letterSpacing: "0.04em", color: "var(--rpc-text-secondary)" }}>
                {setHref ? (
                  <Link href={setHref} style={{ color: "inherit", textDecoration: "none" }}>{detail.set_name}</Link>
                ) : detail.set_name}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <TierBadge tier={detail.tier} />
              {/* Parallel printing chip (Stage B) — names the subedition this
                  page is, e.g. "Hexwave · /24". Standard shows no chip. */}
              {currentSibling?.subedition_name && (
                <span className="rpc-mono" style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, color: "var(--rpc-red)", background: "var(--rpc-red-bg, rgba(224,58,47,0.08))", border: "1px solid var(--rpc-red-border, var(--rpc-border))" }}>
                  {currentSibling.subedition_name}{currentSibling.circulation_count != null ? ` · /${currentSibling.circulation_count}` : ""}
                </span>
              )}
              {detail.series_label && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>{detail.series_label}</span>
              )}
              {detail.edition_kind && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>{detail.edition_kind}</span>
              )}
              {detail.circulation_count !== null && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  Mint {fmtCount(detail.circulation_count)}
                </span>
              )}
              {detail.team_name && teamHref && (
                <Link href={teamHref} className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-primary)", textDecoration: "none" }}>{detail.team_name}</Link>
              )}
              {isPinnacle && detail.is_chaser && (
                <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "#A855F7", background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.30)" }}>Chaser</span>
              )}
            </div>

            {detail.badges && detail.badges.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {detail.badges.map(b => {
                  const art = badgeArt.get(normalizeBadgeKey(b))
                  if (art) {
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={b} src={art} alt={b} title={b} width={24} height={24} loading="lazy" style={{ width: 24, height: 24, display: "inline-block", verticalAlign: "middle" }} />
                    )
                  }
                  return (
                    <span key={b} className="rpc-mono" style={{ padding: "2px 6px", border: "1px solid var(--rpc-border)", borderRadius: 3, fontSize: 10, color: "var(--rpc-text-secondary)" }}>{b}</span>
                  )
                })}
              </div>
            )}

            {isPinnacle && detail.live_ask && detail.live_ask.price !== null && (
              <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                Live ask: <span style={{ color: "var(--rpc-text-primary)" }}>{fmtUsd(detail.live_ask.price)}</span>
                {detail.live_ask.source ? <> · {detail.live_ask.source}</> : null}
                {detail.live_ask.updated_at ? <> · {relTime(detail.live_ask.updated_at)}</> : null}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── FMV strip ────────────────────────────────────────────────────── */}
      {/* Plain-language valuation answer — crawlable "what is X worth" text,
          featured-snippet eligible; gated to a real FMV. (2026-06-29 SEO) */}
      {fmvAvailable && (
        <p className="rpc-mono" style={{ margin: "12px 2px 2px", fontSize: 13, lineHeight: 1.65, color: "var(--rpc-text-secondary)" }}>
          <strong style={{ color: "var(--rpc-text-primary)", fontWeight: 700 }}>{editionTitle}{detail.set_name ? ` — ${detail.set_name}` : ""}</strong>{" "}
          is worth ~{fmtUsd(fmv?.fmv_usd ?? null)} (FMV) on {collectionDisplayName(collection)}
          {askValue ? <>, with the lowest ask at {fmtUsd(askValue)}</> : fmv?.floor_price_usd ? <>, with a recent-sale low of {fmtUsd(fmv?.floor_price_usd ?? null)}</> : null}
          {fmv?.sales_count_30d ? <> and {fmtCount(fmv?.sales_count_30d ?? null)} sales in the last 30 days</> : null}
          .{" "}
          <Link href="/legal/fmv-methodology" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>How FMV is calculated →</Link>
        </p>
      )}

      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <StatCell
          label="Current FMV"
          value={fmtUsd(fmv?.fmv_usd ?? null)}
          sub={
            <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <ConfidencePill confidence={fmv?.confidence ?? null} />
              <FmvBasis
                confidence={fmv?.confidence ?? null}
                salesCount30d={fmv?.sales_count_30d ?? null}
                ask={askValue}
              />
              {/* PIN-FMV-REKEY Wave 2: this is the most-liquid render; show the
                  per-render spread when the set-level key fans out. */}
              {isPinnacle &&
                (fmv?.render_count ?? 0) > 1 &&
                fmv?.fmv_min != null &&
                fmv?.fmv_max != null &&
                fmv.fmv_min !== fmv.fmv_max && (
                  <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
                    range {fmtUsd(fmv.fmv_min)}–{fmtUsd(fmv.fmv_max)} · {fmv.render_count} renders
                  </span>
                )}
            </span>
          }
        />
        <StatCell
          label="24h Change"
          value={dayDelta === null ? EM_DASH : (
            <span style={{ color: dayDelta >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)" }}>
              {fmtPercent(dayDelta)}
            </span>
          )}
        />
        <StatCell
          label="Floor"
          value={fmtUsd(fmv?.floor_price_usd ?? null)}
        />
        <StatCell
          label={askLabel}
          value={fmtUsd(askValue)}
          // On a parallel printing the floor ask is suppressed (the edition
          // floor is a different printing's listing) — say so rather than leave
          // a bare em-dash. Per-printing listing keying is a follow-up.
          sub={currentSibling?.subedition_name && askValue == null ? "per-printing floor not yet indexed" : undefined}
        />
        {hasBestOffer && (
          <StatCell
            label={currentSibling?.subedition_name ? "Edition offer" : "Best offer"}
            value={fmtUsd(highOffer?.highest_offer ?? null)}
            // An edition-level OffersV2 offer is fillable by ANY printing, so it
            // shows on every parallel page as a real sell target for that moment.
            sub={
              currentSibling?.subedition_name
                ? `fillable by any printing${highOffer?.updated_at ? ` · ${relTime(highOffer.updated_at)}` : ""}`
                : (highOffer?.updated_at ? relTime(highOffer.updated_at) : undefined)
            }
          />
        )}
        <StatCell
          label="30d Sales"
          value={fmtCount(fmv?.sales_count_30d ?? null)}
          sub={fmv?.days_since_sale !== null && fmv?.days_since_sale !== undefined ? `${fmv.days_since_sale}d since last` : undefined}
        />
      </section>

      {!fmvAvailable && (
        <div className="rpc-mono" style={{ marginTop: 8, padding: "8px 12px", color: "var(--rpc-text-muted)", fontSize: 11 }}>
          No recent market activity
        </div>
      )}

      {/* ── Watch this edition (FMV / ask alert) ─────────────────────────── */}
      {/* Pinnacle FMV lives in its own tables the alert dispatcher doesn't read,
          so the watch control is gated to the editions+fmv_snapshots collections. */}
      {!isPinnacle && detail.external_id && (
        <div style={{ marginTop: 14 }}>
          <WatchEditionButton
            editionKey={detail.external_id}
            collectionId={detail.collection_id}
            playerName={detail.player_name}
            setName={detail.set_name}
          />
        </div>
      )}

      {/* ── Parallel Printings (subedition ladder) ──────────────────────── */}
      {/* The headline parallel-conflation feature: Standard + each named
          printing (Jukebox/Hexwave/…) of the SAME setID:playID, each its own
          edition with its own circulation + de-blended per-parallel FMV. */}
      {hasParallelLadder && (
        <Section title="Parallel Printings">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            Same play, different printings — each is its own edition with its own circulation, serials, and market. The Standard is the base; named parallels are scarcer printings that trade at their own price.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            {subSiblings.map((s) => {
              const name = s.subedition_name ?? "Standard"
              return (
                <Link
                  key={s.external_id}
                  href={`/${collection}/edition/${encodeURIComponent(s.external_id)}`}
                  className="rpc-card"
                  style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", border: s.is_self ? "1px solid var(--rpc-red)" : "1px solid var(--rpc-border)" }}
                >
                  <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.3)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                    {s.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.thumbnail_url} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: s.is_self ? "var(--rpc-red)" : "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2 }}>{name}</span>
                    {s.is_self && <span className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-red)" }}>viewing</span>}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-primary)" }}>
                    {s.fmv_usd != null ? fmtUsd(s.fmv_usd) : <span style={{ color: "var(--rpc-text-muted)" }}>no FMV</span>}
                    {s.confidence ? <span style={{ color: "var(--rpc-text-muted)" }}> · {s.confidence}</span> : null}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginTop: 2 }}>
                    {s.circulation_count != null ? `/${fmtCount(s.circulation_count)} mint` : "mint —"}
                  </div>
                </Link>
              )
            })}
          </div>
        </Section>
      )}

      {/* ── Media verified on IPFS (Top Shot) ───────────────────────────── */}
      {ipfsAssets && (
        <Section title="Media Verified on IPFS">
          <p className="rpc-mono" style={{ margin: "-2px 0 14px", fontSize: 12, lineHeight: 1.7, color: "var(--rpc-text-secondary)" }}>
            This Moment&apos;s video and artwork are pinned to the InterPlanetary File System —
            content-addressed, tamper-evident, and retrievable from any IPFS gateway without a
            Top Shot account.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {ipfsAssets.video_cid && <IpfsCidRow label="Video CID" cid={ipfsAssets.video_cid} />}
            {ipfsAssets.hero_cid && <IpfsCidRow label="Artwork CID" cid={ipfsAssets.hero_cid} />}
          </div>
          <div className="rpc-mono" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--rpc-border)", fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
            Verify independently via{" "}
            <a
              href="https://dapperlabs.github.io/dapperlabs-ipfs-reference-app/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--rpc-red)", textDecoration: "none" }}
            >
              Dapper&apos;s IPFS Reference App →
            </a>{" "}
            — any gateway works (ipfs.io, dweb.link).
            <div style={{ marginTop: 6 }}>
              CIDs also verifiable on-chain via{" "}
              <a
                href="https://f.dnz.dev/0b2a3299cc857e29/contract/TopShotIPFSResolver"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--rpc-red)", textDecoration: "none" }}
              >
                TopShotIPFSResolver.getCIDs
              </a>{" "}
              on Flow.
            </div>
          </div>
        </Section>
      )}

      {/* ── Featured in Insights (entity → insights internal links) ──────── */}
      {hasInsightLinks && (
        <Section title="Featured in Insights">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {insightLinks.squeeze_pct != null && (
              <Link href="/insights/squeeze" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                {Math.round(insightLinks.squeeze_pct)}% squeeze →
              </Link>
            )}
            {insightLinks.deal_pct != null && (
              <Link href="/insights/deals" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                {Math.round(insightLinks.deal_pct)}% below FMV →
              </Link>
            )}
            {insightLinks.first_mint_x != null && (
              <Link href="/insights/first-mint" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                #1 sold {Number(insightLinks.first_mint_x).toFixed(1)}× the field →
              </Link>
            )}
          </div>
        </Section>
      )}

      {/* ── FMV history chart ────────────────────────────────────────────── */}
      <Section title="FMV History">
        <FmvHistoryChart collectionUrlSlug={collection} routeSlug={detail.route_slug ?? slug} initial={history} />
      </Section>

      {/* ── Heavy bottom sections stream in (recent sales, parallels, packs,
             special serials + owner-username resolution) so they never hold up
             the hero + FMV strip above. ─────────────────────────────────── */}
      <Suspense fallback={<LoadingState lines={4} />}>
        <EditionBottomSections
          detail={detail}
          collection={collection}
          slug={slug}
          isPinnacle={isPinnacle}
          isAllDay={isAllDay}
        />
      </Suspense>
    </div>
  )
}

// Heavy bottom sections — fetched + rendered behind a <Suspense> boundary so the
// hero + FMV strip above paint as soon as get_edition_detail resolves, instead
// of waiting on the full RPC fan-out + the sequential owner-username resolution.
async function EditionBottomSections({
  detail,
  collection,
  slug,
  isPinnacle,
  isAllDay,
}: {
  detail: EditionDetail
  collection: string
  slug: string
  isPinnacle: boolean
  isAllDay: boolean
}) {
  const isTopShot = collection === "nba-top-shot"
  const [sales, parallels, packs, specialSerials, notableSerials, packProvenance] = await Promise.all([
    fetchSales(detail.collection_id, slug, SALES_PAGE_SIZE, 0),
    fetchParallels(detail.id),
    fetchPacks(detail.collection_id, slug),
    isPinnacle ? Promise.resolve([] as SpecialSerialRow[]) : fetchSpecialSerials(detail.id),
    isPinnacle ? Promise.resolve([] as NotableSerialRow[]) : fetchNotableSerials(detail.id),
    isTopShot || isAllDay ? fetchPackProvenance(detail.id, isAllDay) : Promise.resolve(null),
  ])

  // Merge the deterministic notable serials (tag + last sale) with the tracked
  // owners (special_serial_holders) by serial — gives one board with tag, last
  // sale, and owner-if-known.
  const ownerBySerial = new Map<number, string>()
  for (const s of specialSerials) {
    if (s.holder_address) ownerBySerial.set(s.serial_number, s.holder_address)
  }
  // special_serial_holders is empty platform-wide, so fall back to the holder
  // get_edition_special_serials now resolves from wallet_moments_cache.
  for (const n of notableSerials) {
    if (n.holder_address && !ownerBySerial.has(n.serial)) ownerBySerial.set(n.serial, n.holder_address)
  }
  const sortedNotable = [...notableSerials].sort((a, b) => {
    const pr = (t: string) => (t === "#1" ? 0 : t === "jersey" ? 1 : t === "last_mint" ? 2 : 3)
    const d = pr(a.tag) - pr(b.tag)
    return d !== 0 ? d : a.serial - b.serial
  })
  // @username for the special-serial owner cells (Item 7) — same resolution the
  // Recent Sales rows use, so the #1 owner reads "@JJLSmith" not a raw 0x….
  const ownerNames = await fetchOwnerUsernames([...ownerBySerial.values()])

  // H5: only render pack tiles that resolved a real title. Some All Day dist_ids
  // have no matching pack_distributions row, so get_edition_in_packs returns
  // pack_title=NULL and the card would render a bare "Pack" placeholder.
  const namedPacks = packs.filter(p => typeof p.pack_title === "string" && p.pack_title.trim().length > 0)

  return (
    <>
      {/* ── Recent sales ─────────────────────────────────────────────────── */}
      <Section title="Recent Sales">
        <SalesTablePaginated
          collectionUrlSlug={collection}
          routeSlug={detail.route_slug ?? slug}
          initial={sales}
          initialOffset={sales.length}
          pageSize={SALES_PAGE_SIZE}
          isAllDay={isAllDay}
        />
      </Section>

      {/* ── Same play in OTHER sets (distinct from the subedition ladder
             above, which is the same set's parallel printings) ──────────── */}
      {parallels.length > 0 && (
        <Section title="Same Play · Other Sets">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {parallels.map(p => (
              <Link
                key={p.id}
                href={`/moment/${p.id}`}
                className="rpc-card"
                style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", border: "1px solid var(--rpc-red)" }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.3)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail_url} alt={p.set_name ?? "parallel"} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                  ) : null}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
                  {p.set_name ?? "—"}
                </div>
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
                  {(p.tier ?? "").toUpperCase()}
                  {p.circulation_count != null ? ` · ${fmtCount(p.circulation_count)} mint` : ""}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Found in packs ───────────────────────────────────────────────── */}
      {namedPacks.length > 0 && (
        <Section title="Found in These Packs">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {namedPacks.map(p => (
              <Link
                key={p.dist_id}
                href={`/${collection}/pack/dist/${encodeURIComponent(p.dist_id)}`}
                className="rpc-card"
                style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
              >
                <PackThumb src={p.pack_image_url} alt={p.pack_title ?? "Pack"} />
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
                  {p.pack_title ?? "Pack"}
                </div>
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
                  {/* drop_weight 0 = no longer pullable from this pool. Show
                      "exhausted" instead of a broken-looking "0 slots". Only
                      surface depletion when it's actually > 0. */}
                  {p.drop_weight === 0
                    ? "exhausted"
                    : p.drop_weight !== null
                    ? `${p.drop_weight} slot${p.drop_weight === 1 ? "" : "s"}`
                    : "weight unknown"}
                  {p.depletion_pct ? <> · {Math.round(p.depletion_pct)}% depleted</> : null}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Pack provenance (Top Shot + All Day) ─────────────────────────── */}
      {(isTopShot || isAllDay) && packProvenance && (packProvenance.pack_pulls_observed ?? 0) > 0 && (
        <Section title="Pack Provenance">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            How much of this edition we&rsquo;ve seen enter the market straight from pack opens.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <StatCell
              label="Pack pulls observed"
              value={fmtCount(packProvenance.pack_pulls_observed)}
              sub={packProvenance.distinct_packs != null ? `across ${fmtCount(packProvenance.distinct_packs)} packs` : undefined}
            />
            <StatCell
              label="Pack-distributed share"
              value={packProvenance.observed_pull_share_pct != null ? `~${fmtPercent(packProvenance.observed_pull_share_pct)}` : "—"}
              sub="of circulation, observed (lower bound)"
            />
            <StatCell
              label="First seen pulled"
              value={packProvenance.first_pull_at ? relTime(packProvenance.first_pull_at) : "—"}
              sub={packProvenance.last_pull_at ? `latest ${relTime(packProvenance.last_pull_at)}` : undefined}
            />
          </div>
          <div className="rpc-mono" style={{ marginTop: 10, fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
            Observed since ~{isAllDay ? "Jun" : "Apr"} 2026 and undercounted (not every pulled moment resolves to its edition), so treat
            this as a directional pack-distribution signal — it underestimates older editions.
          </div>
        </Section>
      )}

      {/* ── Special serials (non-Pinnacle) ───────────────── */}
      {!isPinnacle && (
        <Section title="Special Serials">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Notable serials — #1, jersey match, and the perfect serial (final mint) — with their last sale and tracked owner where known.
          </div>
          {sortedNotable.length === 0 ? (
            <div style={{ padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              No notable serials for this edition yet.
            </div>
          ) : (
            <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sortedNotable.map(r => {
                const owner = ownerBySerial.get(r.serial) ?? null
                const accent = r.tag === "#1" || r.tag === "jersey"
                return (
                  <div key={`${r.tag}-${r.serial}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,140px) 70px 1fr 140px", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4, minWidth: 460 }}>
                    <span
                      className="rpc-mono"
                      style={{
                        justifySelf: "start",
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        color: accent ? "var(--rpc-red)" : "var(--rpc-text-secondary)",
                        background: accent ? "var(--rpc-red-bg, rgba(224,58,47,0.08))" : "rgba(255,255,255,0.04)",
                        border: `1px solid ${accent ? "var(--rpc-red-border, var(--rpc-border))" : "var(--rpc-border)"}`,
                      }}
                    >
                      <SpecialSerialGlyph tag={r.tag} size={11} />
                      {notableTagLabel(r.tag)}
                    </span>
                    <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>#{r.serial}</span>
                    <span className="rpc-mono" style={{ fontSize: 11, color: r.last_sale_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)" }}>
                      {r.last_sale_usd != null ? `${fmtUsd(r.last_sale_usd)} · ${relTime(r.last_sold_at)}` : "never sold"}
                    </span>
                    {owner ? <WalletLink address={owner} name={ownerNames.get(owner.toLowerCase()) ?? null} /> : <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", textAlign: "right" }}>owner —</span>}
                  </div>
                )
              })}
            </div>
          )}
          {collection === "nba-top-shot" && detail.player_name ? (
            <div style={{ marginTop: 10 }}>
              <Link
                href={`/special-serial-owners?player=${encodeURIComponent(detail.player_name)}`}
                className="rpc-mono"
                style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--rpc-red)", textDecoration: "none" }}
              >
                See who holds {detail.player_name}&rsquo;s special serials →
              </Link>
            </div>
          ) : null}
        </Section>
      )}
    </>
  )
}

function notableTagLabel(tag: string): string {
  switch (tag) {
    case "#1": return "Serial #1"
    case "jersey": return "Jersey Match"
    case "last_mint": return "Perfect Serial"
    default: return tag.replace(/_/g, " ")
  }
}
