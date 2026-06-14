// app/moment/[id]/page.tsx
//
// Public, server-rendered edition / moment detail page. Resolves [id] as
// flow nft_id (numeric), moment uuid (serial-specific), or edition uuid
// (aggregate). Backed by the SECDEF RPC public.get_moment_detail, with
// parallel extras: get_edition_high_offer, get_edition_parallels,
// get_edition_badges_unified, and a direct special_serial_holders lookup.
//
// Targets:
//   - Trophy Slab QR codes (already shipping)
//   - Insider Signals card click-through
//   - Fast Break lineup rows (Phase 2 wallet-aware)
//   - SEO: "<player> <set> #<serial>" long-tail queries
//
// Phase 2 (2026-05-26) updates:
//   - Replaced Marketplace column with Buyer + Seller in Recent Activity.
//   - Added Top Shot Best Offer cell (next to Top Shot Ask).
//   - Added Badges row (sourced from get_edition_badges_unified).
//   - Replaced inline serial===1 check with a special-serial pills row
//     keyed by (edition_id, serial_number) when kind='moment'.
//   - Added a Parallels section (same player, same play_id_onchain across
//     different sets) above Similar Editions.
//   - Moved the 6-cell info bar from the footer into the body, between
//     the hero and Recent Activity, with linked Team.

import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveUsernames } from "@/lib/flowty-username"
import { marketplaceMomentUrl, dapperMarketMomentUrl, fromDbSlug } from "@/lib/collections"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import SiteFooter from "@/components/SiteFooter"
import MomentHeroMedia from "@/components/MomentHeroMedia"

// Display label for the native marketplace per URL slug. Only collections with
// a marketplaceMomentUrl template can produce a valid deep link.
const MARKETPLACE_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot",
  "nfl-all-day": "NFL All Day",
  "laliga-golazos": "LaLiga Golazos",
  "disney-pinnacle": "Pinnacle",
}

// Collection-aware label for the lowest-ask cell — the value source is not
// always Top Shot, so "Top Shot ask" must not show on a non-Top-Shot page.
const ASK_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot ask",
  "nfl-all-day": "All Day ask",
  "laliga-golazos": "Golazos ask",
  "disney-pinnacle": "Pinnacle ask",
  "ufc-strike": "UFC ask",
}

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ── RPC payload shapes ─────────────────────────────────────────────────────

type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NO_DATA" | "ASK_ONLY" | "SALES_ONLY" | "STALE" | null

interface MomentResolved {
  kind: "moment" | "edition" | "pinnacle_edition"
  moment_id: string | null
  edition_id: string
  serial_number: number | null
  collection_id: string
  collection_slug: string
  pinnacle_edition_id?: string | null
}

// Wave 2 (PIN-FMV-REKEY): a Pinnacle legacy edition_key maps to MANY renders.
// get_moment_detail returns the render-true set so /moment/<legacy-key> can
// disambiguate to the per-pin /pinnacle/moment/<render_id> pages instead of
// showing one arbitrary character's set-level blend.
interface PinnacleRender {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  total_minted: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
  floor_ask: number | null
  thumbnail_url: string | null
}

interface MomentEdition {
  id: string
  external_id: string | null
  name: string | null
  tier: string | null
  series: number | null
  player_name: string | null
  team_name: string | null
  set_name: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  play_type: string | null
  play_category: string | null
  game_date: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  video_url: string | null
  collection_slug: string | null
}

interface MomentFmv {
  fmv_usd: number | null
  floor_price_usd: number | null
  wap_usd: number | null
  confidence: Confidence
  sales_count_7d: number | null
  sales_count_30d: number | null
  days_since_sale: number | null
  computed_at: string | null
  algo_version: string | null
  top_shot_ask: number | null
  flowty_ask: number | null
  cross_market_ask: number | null
}

interface MomentSerialSpecific {
  serial_number: number | null
  nft_id: string | null
  owner_address: string | null
  is_listed: boolean | null
  list_price: number | null
  listed_at: string | null
  last_sale: {
    price_usd: number | null
    sold_at: string | null
    buyer_address: string | null
    seller_address: string | null
    marketplace: string | null
  } | null
}

interface RecentSale {
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  marketplace: string | null
  buyer_address: string | null
  seller_address: string | null
}

interface SimilarEdition {
  id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

interface MomentDetail {
  ok: boolean
  error?: string
  input?: string
  resolved?: MomentResolved
  edition?: MomentEdition
  fmv?: MomentFmv
  serial_specific?: MomentSerialSpecific | null
  recent_sales?: RecentSale[]
  similar_editions?: SimilarEdition[]
  renders?: PinnacleRender[]
}

// New (Phase 2):
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

interface EditionBadge {
  id: string
  title: string
  source: string
}

interface SpecialSerialRow {
  badge_type: string
  serial_number: number
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

// Next delivers the [id] route segment URL-encoded (e.g. a Pinnacle legacy key
// `STAR-OEV1-SWHM:Digital Display:1` arrives as `...%3ADigital%20Display%3A1`).
// resolve_moment_id matches the decoded colon form (pe.id), so decode at the
// lambda boundary — same footgun fixed on the edition pages (bf3f4f6). No-op for
// numeric nft_ids and uuids.
function decodeMomentId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

async function fetchDetail(id: string): Promise<MomentDetail | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_moment_detail", {
      p_id: id,
    })
    if (error) {
      console.warn(`[moment-page] rpc error id=${id}: ${error.message}`)
      return null
    }
    const payload = data as MomentDetail | null
    if (!payload || payload.ok === false) return payload
    return payload
  } catch (err) {
    console.warn(`[moment-page] fetch threw id=${id}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchHighOffer(editionId: string): Promise<HighOffer | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_edition_high_offer", { p_edition_id: editionId })
    if (error) { console.warn(`[moment-page] high_offer rpc: ${error.message}`); return null }
    if (Array.isArray(data) && data.length > 0) return data[0] as HighOffer
    if (data && typeof data === "object") return data as HighOffer
    return null
  } catch (err) {
    console.warn(`[moment-page] high_offer threw: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// Item 1 (2026-06-11): per-moment "best offer" — the single highest offer this
// exact serial is eligible for, across the edition-grain offer and any
// serial-grain offer targeting its serial. One number, no floor.
interface MomentBestOffer {
  best_offer: number | null
  grain: string | null
  updated_at: string | null
}

async function fetchMomentBestOffer(editionId: string, serial: number): Promise<MomentBestOffer | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_moment_best_offer", {
      p_edition_id: editionId,
      p_serial: serial,
    })
    if (error) { console.warn(`[moment-page] moment_best_offer rpc: ${error.message}`); return null }
    if (Array.isArray(data) && data.length > 0) return data[0] as MomentBestOffer
    if (data && typeof data === "object") return data as MomentBestOffer
    return null
  } catch (err) {
    console.warn(`[moment-page] moment_best_offer threw: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchParallels(editionId: string): Promise<ParallelEdition[]> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_edition_parallels", { p_edition_id: editionId })
    if (error) { console.warn(`[moment-page] parallels rpc: ${error.message}`); return [] }
    return Array.isArray(data) ? (data as ParallelEdition[]) : []
  } catch (err) {
    console.warn(`[moment-page] parallels threw: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function fetchBadges(editionId: string): Promise<EditionBadge[]> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_edition_badges_unified", { p_edition_id: editionId })
    if (error) { console.warn(`[moment-page] badges rpc: ${error.message}`); return [] }
    if (Array.isArray(data)) return data as EditionBadge[]
    return []
  } catch (err) {
    console.warn(`[moment-page] badges threw: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function fetchSpecialSerialsForSerial(editionId: string, serial: number): Promise<SpecialSerialRow[]> {
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("special_serial_holders")
      .select("badge_type, serial_number")
      .eq("edition_id", editionId)
      .eq("serial_number", serial)
    if (error) { console.warn(`[moment-page] special_serials: ${error.message}`); return [] }
    return Array.isArray(data) ? (data as SpecialSerialRow[]) : []
  } catch (err) {
    console.warn(`[moment-page] special_serials threw: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// Edition-wide notable serials (#1, jersey match, perfect serial) with
// last sale and current holder from wallet_moments_cache — the
// get_edition_special_serials RPC (enriched 2026-06-13 with the wmc holder).
// Powers the moment-page "Special serials" section (Item 2). holder_address /
// nft_id are NULL where we haven't indexed that serial's owner.
interface NotableSerialRow {
  serial: number
  tag: string
  last_sale_usd: number | null
  last_sold_at: string | null
  holder_address: string | null
  nft_id: string | null
}

async function fetchEditionNotableSerials(editionId: string): Promise<NotableSerialRow[]> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_edition_special_serials", { p_edition_id: editionId })
    if (error) { console.warn(`[moment-page] notable_serials rpc: ${error.message}`); return [] }
    return Array.isArray(data) ? (data as NotableSerialRow[]) : []
  } catch (err) {
    console.warn(`[moment-page] notable_serials threw: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function notableTagLabel(tag: string): string {
  switch (tag) {
    case "#1": return "Serial #1"
    case "jersey": return "Jersey Match"
    case "last_mint": return "Perfect Serial"
    default: return tag.replace(/_/g, " ")
  }
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + n.toFixed(2)
}

function fmtRelDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const diffMs = Date.now() - ms
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  if (days <= 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months === 1) return "1mo ago"
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

function fmtAbsDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function tierColorVar(tier: string | null | undefined): string {
  const t = (tier ?? "").toUpperCase()
  if (t === "ULTIMATE") return "var(--rpc-ultimate, var(--rpc-red))"
  if (t === "LEGENDARY") return "var(--rpc-legendary, var(--rpc-red))"
  if (t === "RARE") return "var(--rpc-rare, var(--rpc-text-primary))"
  if (t === "FANDOM") return "var(--rpc-fandom, var(--rpc-text-muted))"
  if (t === "COMMON") return "var(--rpc-common, var(--rpc-text-muted))"
  // UFC Strike tier vocabulary (CHALLENGER / CONTENDER / FANDOM).
  if (t === "CHALLENGER") return "var(--tier-challenger, var(--rpc-red))"
  if (t === "CONTENDER") return "var(--tier-contender, var(--rpc-text-muted))"
  return "var(--rpc-text-muted)"
}

// Top Shot encodes series as a raw on-chain UInt32 where 0 = Series 1 — there
// is no on-chain series 1 (see the CLAUDE.md series map). Other collections'
// series encodings are not verified, so they fall back to the raw "Series N".
const SERIES_DISPLAY: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

function seriesDisplay(n: number, collectionSlug: string | null | undefined): string {
  const isTopShot = collectionSlug === "nba_top_shot" || collectionSlug === "nba-top-shot"
  if (isTopShot) return SERIES_DISPLAY[n] ?? `Series ${n}`
  return `Series ${n}`
}

function collectionLabel(slug: string | null | undefined): string {
  switch (slug) {
    case "nba_top_shot": return "NBA TOP SHOT"
    case "nfl_all_day": return "NFL ALL DAY"
    case "laliga_golazos": return "LALIGA GOLAZOS"
    case "ufc_strike": return "UFC STRIKE"
    case "disney_pinnacle": return "DISNEY PINNACLE"
    default: return (slug ?? "").toUpperCase().replace(/_/g, " ")
  }
}

function urlSlugForCollection(dbSlug: string | null | undefined): string | null {
  switch (dbSlug) {
    case "nba_top_shot": return "nba-top-shot"
    case "nfl_all_day": return "nfl-all-day"
    case "laliga_golazos": return "laliga-golazos"
    case "ufc_strike": return "ufc-strike"
    case "disney_pinnacle": return "disney-pinnacle"
    default: return null
  }
}

// Mirror of lib/entity-labels.slugifyName — kept local to avoid pulling in
// that lib's runtime here (per the same convention as OwnerLink below).
function slugifyTeam(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Subject label for a moment. Player moments → player name. Team moments (no
// player_name — WNBA Skyline, Squad Goals, Fit Check, Dynamic Duos, …) → the
// team plus its play type, mirroring Dapper Market ("Portland Fire Reel"). Item
// 3 (2026-06-11). Falls back to the raw edition name, then "Moment", so an inert
// stub never renders blank.
function momentSubject(
  player: string | null | undefined,
  team: string | null | undefined,
  play: string | null | undefined,
  name: string | null | undefined,
): string {
  if (player && player.trim()) return player
  if (team && team.trim()) {
    const p = play && play.trim() && play !== "Unknown" ? ` ${play}` : ""
    return `${team}${p}`
  }
  if (name && name.trim()) return name
  return "Moment"
}

// Maps a raw special_serial_holders.badge_type enum to a display label.
function specialSerialLabel(badge_type: string): string {
  switch (badge_type) {
    case "first_serial": return "#1 Serial"
    case "jersey_match": return "Jersey Match"
    case "perfect_mint": return "Perfect Serial"
    case "last_serial": return "Perfect Serial"
    case "birthdate_serial": return "Birthdate"
    default: return badge_type.replace(/_/g, " ")
  }
}

// ── Metadata (SEO) ─────────────────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)
  const detail = await fetchDetail(id)
  if (!detail || detail.ok === false || !detail.edition) {
    return {
      title: "Moment Not Found — Rip Packs City",
      description: "This moment isn't in our index yet.",
    }
  }
  // Pinnacle render disambiguation (Wave 2): a legacy edition_key maps to many
  // renders — noindex,follow (mirrors /pinnacle/moment/<legacy-key>).
  const pinRenders =
    detail.resolved?.kind === "pinnacle_edition" ? (detail.renders ?? []) : []
  if (pinRenders.length > 1) {
    return {
      title: { absolute: `Pick a pin — ${pinRenders.length} editions | Rip Packs City` },
      description: `${pinRenders.length} distinct Disney Pinnacle renders share this set-level key. Pick the exact character.`,
      robots: { index: false, follow: true },
    }
  }
  const e = detail.edition
  const serial = detail.resolved?.serial_number
  const mint = e.circulation_count ?? 0
  const tier = (e.tier ?? "").toUpperCase()
  const player = momentSubject(e.player_name, e.team_name, e.play_type, e.name)
  const setName = e.set_name ?? ""
  const sales30 = detail.fmv?.sales_count_30d ?? 0
  const serialSuffix = serial ? ` #${serial}/${mint}` : (mint ? ` (${mint} circulation)` : "")
  const title = `${player}${serialSuffix} · ${setName} · ${tier} | Rip Packs City`
  const description = `Live FMV, sale history, and market data for ${player} ${setName}${serialSuffix} on ${collectionLabel(e.collection_slug).toLowerCase().replace(/^\w/, c => c.toUpperCase())}. ${sales30 ? `${sales30} sales in last 30 days. ` : ""}Powered by Rip Packs City.`
  const ogImage = `/api/og/moment/${encodeURIComponent(id)}`
  // Canonical consolidation (SEO, 2026-06-05): /moment/<id> shows the same
  // moment as the richer, better-linked /<collection>/edition/<slug>. Point the
  // canonical at the edition page so the two URLs don't compete for the same
  // query. The edition route slug is the edition's external_id for the standard
  // collections (get_edition_detail resolves on external_id OR id; its own
  // route_slug = COALESCE(external_id, id)), and the edition uuid (pe.id) for
  // Pinnacle. Fall back to the self-canonical if we can't resolve a url slug or
  // route key (never emit a broken canonical).
  const canonicalUrlSlug = e.collection_slug ? fromDbSlug(e.collection_slug) : null
  const isPinnacleColl = e.collection_slug === "disney_pinnacle"
  const editionRouteSlug = isPinnacleColl ? e.id : (e.external_id ?? e.id)
  const canonicalPath =
    canonicalUrlSlug && editionRouteSlug
      ? `/${canonicalUrlSlug}/edition/${encodeURIComponent(editionRouteSlug)}`
      : `/moment/${encodeURIComponent(id)}`
  return {
    // `absolute` skips the site-wide "%s | Rip Packs City" title.template so the
    // document <title> isn't double-suffixed (the title string already carries
    // the brand). OG/Twitter keep the full branded `title` string below.
    title: { absolute: title },
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      images: [ogImage],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function MomentPage(
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)
  const detail = await fetchDetail(id)
  if (!detail || detail.ok === false) {
    notFound()
  }

  // Pinnacle render disambiguation (Wave 2, PIN-FMV-REKEY). One legacy
  // edition_key maps to many renders, so a single set-level page would show one
  // arbitrary character's blended price. Single render → link straight through
  // to its per-pin page; multiple → render a "Pick a pin" list. Empty (numeric
  // legacy id with no render mapping) falls through to the set-level view.
  if (detail.resolved?.kind === "pinnacle_edition") {
    const renders = detail.renders ?? []
    if (renders.length === 1) {
      redirect(`/pinnacle/moment/${encodeURIComponent(renders[0].render_id)}`)
    }
    if (renders.length > 1) {
      return <PinnacleDisambiguation renders={renders} />
    }
  }

  if (!detail.edition) {
    notFound()
  }

  const e = detail.edition
  const f = detail.fmv
  const r = detail.resolved
  const ss = detail.serial_specific
  const recentSales = detail.recent_sales ?? []
  const similar = detail.similar_editions ?? []

  const serial = r?.serial_number ?? ss?.serial_number ?? null
  const mint = e.circulation_count ?? 0
  const tier = (e.tier ?? "").toUpperCase()
  // Item 3: player moment → player; team moment → "<team> <play>"; never blank.
  const subject = momentSubject(e.player_name, e.team_name, e.play_type, e.name)
  const tierColor = tierColorVar(e.tier)
  const collectionSlugUrl = urlSlugForCollection(e.collection_slug)
  const collectionDisplay = collectionLabel(e.collection_slug)

  // Outbound marketplace deep link. marketplaceMomentUrl() builds a
  // SPECIFIC-moment URL (e.g. nbatopshot.com/moment/<nftId>), so it's only
  // valid when we have a concrete on-chain NFT id — i.e. a serial-specific
  // page (kind='moment'). Edition-level pages have no single moment to link
  // to, so we don't fabricate a URL for them. UFC Strike has no template, so
  // marketplaceMomentUrl returns null there and the CTA is omitted.
  const marketplaceNftId = ss?.nft_id ?? (r?.kind === "moment" ? r?.moment_id ?? null : null)
  const marketplaceUrl =
    collectionSlugUrl && marketplaceNftId
      ? marketplaceMomentUrl(collectionSlugUrl, marketplaceNftId)
      : null
  const marketplaceName = collectionSlugUrl ? MARKETPLACE_LABEL[collectionSlugUrl] ?? null : null
  // Second-marketplace (dapper.market) deep link — same serial-specific NFT id.
  // Returns null for non-dapper collections (Pinnacle/UFC) and edition-level
  // pages (no concrete moment id), so the CTA self-hides.
  const dapperUrl =
    collectionSlugUrl && marketplaceNftId
      ? dapperMarketMomentUrl(collectionSlugUrl, marketplaceNftId)
      : null

  // Item 1 (2026-06-13): resilient hero image. The constructed
  // editions.thumbnail_url / video_url 404 on the CDN for many legacy (Series
  // 1-4) Top Shot editions, leaving a blank hero on ~30% of premium moment
  // pages. The per-moment `media/<momentId>/image` form works on all of them
  // (same source the trophy slabs use). Prefer it for Top Shot moment pages,
  // then fall back to the stored edition thumbnail; other collections keep their
  // working stored thumbnail. MomentHeroMedia advances through the candidates on
  // load error and hides a 404ing video to reveal the image underneath.
  const isTopShotColl = e.collection_slug === "nba_top_shot" || e.collection_slug === "nba-top-shot"
  const tsHeroImg =
    isTopShotColl && marketplaceNftId && /^\d+$/.test(marketplaceNftId)
      ? `https://assets.nbatopshot.com/media/${marketplaceNftId}/image?width=1080`
      : null
  const heroImageCandidates = [tsHeroImg, e.thumbnail_url].filter((u): u is string => !!u)

  // Parallel extras — all SECDEF RPCs, independent, fan out in one pass.
  const [highOffer, parallels, badges, specialSerials, momentBestOffer, notableSerials] = await Promise.all([
    fetchHighOffer(e.id),
    fetchParallels(e.id),
    fetchBadges(e.id),
    r?.kind === "moment" && serial != null
      ? fetchSpecialSerialsForSerial(e.id, serial)
      : Promise.resolve([] as SpecialSerialRow[]),
    // Item 1: serial-aware best offer only for a concrete serial (kind='moment').
    // Edition-level pages stay edition-grain (highOffer below).
    r?.kind === "moment" && serial != null
      ? fetchMomentBestOffer(e.id, serial)
      : Promise.resolve(null as MomentBestOffer | null),
    // Item 2 (2026-06-13): edition-wide notable serials + holders for the
    // "Special serials" section.
    fetchEditionNotableSerials(e.id),
  ])

  // Resolve owner/buyer/seller + special-serial holder addresses to Top Shot
  // @handles once, server-side (Item 3, 2026-06-09; extended 2026-06-13 to
  // include notable-serial holders). resolveUsernames reads the broadened
  // analytics_resolve_usernames RPC (wallet_usernames → seeded → saved).
  const ownerNameMap = await resolveUsernames(
    [
      ss?.owner_address ?? null,
      ...recentSales.flatMap((s) => [s.buyer_address, s.seller_address]),
      ...notableSerials.map((n) => n.holder_address),
    ].filter((a): a is string => !!a),
  )
  const nameFor = (addr: string | null | undefined) =>
    addr ? ownerNameMap.get(addr.toLowerCase()) ?? null : null

  // Best-offer cell source: for a concrete serial, show the eligible-max
  // (edition ∪ this-serial); for an edition-level page, the edition-grain value.
  const isSerialMoment = r?.kind === "moment" && serial != null
  const bestOfferAmount = isSerialMoment
    ? (momentBestOffer?.best_offer ?? null)
    : (highOffer?.highest_offer ?? null)
  const bestOfferUpdatedAt = isSerialMoment
    ? (momentBestOffer?.updated_at ?? null)
    : (highOffer?.updated_at ?? null)
  const bestOfferGrain = isSerialMoment ? (momentBestOffer?.grain ?? null) : "edition"
  const hasBestOffer = bestOfferAmount != null && bestOfferAmount > 0

  // Item 3b — deterministic hero badges for the current serial that the
  // special_serial_holders sweep may not have populated (#1 + the perfect
  // serial #N/N). Only #1 / Jersey Match / Perfect Serial count as special
  // serials (Trevor 2026-06-13). Deduped against the labels already shown from
  // special_serial_holders so the hero never doubles up.
  const derivedSerialBadges: string[] = []
  if (r?.kind === "moment" && serial != null) {
    const existingLabels = new Set(specialSerials.map((s) => specialSerialLabel(s.badge_type)))
    const hasPerfect = existingLabels.has("Perfect Serial")
    if (serial === 1 && !existingLabels.has("#1 Serial")) derivedSerialBadges.push("#1 Serial")
    if (mint > 0 && serial === mint && !hasPerfect) derivedSerialBadges.push("Perfect Serial")
  }

  const teamHref =
    collectionSlugUrl && e.team_name
      ? `/${collectionSlugUrl}/team/${encodeURIComponent(slugifyTeam(e.team_name))}`
      : null

  // Schema.org Product JSON-LD — gives crawlers a structured snapshot of the
  // moment as a saleable item with current FMV as the price hint.
  // Availability reflects real listing state: a live ask (serial-specific
  // is_listed=true with a list_price, or an edition-level top_shot_ask) is
  // InStock; otherwise OutOfStock. FMV alone is not a listing (Moment audit B7).
  // A STALE FMV is an unreliable price hint — omit the Offer entirely rather
  // than let Google index a wrong price (a wrong indexed price is worse than
  // none). Non-stale FMV / floor still feeds the Offer as before.
  const priceForSchema =
    f?.confidence === "STALE" ? null : (f?.fmv_usd ?? f?.floor_price_usd ?? null)
  const hasLiveListing =
    (ss?.is_listed === true && (ss.list_price ?? 0) > 0) ||
    (f?.top_shot_ask != null && f.top_shot_ask > 0)
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${subject}${serial ? ` #${serial}/${mint}` : ""} · ${e.set_name ?? ""}`,
    description: `${subject} ${e.set_name ?? ""} on ${collectionDisplay}`,
    image: e.thumbnail_url ?? undefined,
    brand: { "@type": "Brand", name: collectionDisplay },
    sku: r?.moment_id ?? r?.edition_id,
    offers: priceForSchema != null
      ? {
          "@type": "Offer",
          priceCurrency: "USD",
          price: priceForSchema.toFixed(2),
          availability: hasLiveListing
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
        }
      : undefined,
  }

  return (
    <>
    <main
      style={{
        minHeight: "100vh",
        background: "var(--rpc-bg, transparent)",
        padding: "32px 16px 80px",
        maxWidth: 1200,
        margin: "0 auto",
        color: "var(--rpc-text-primary)",
      }}
    >
      {/* ── Header band ────────────────────────────────────────────────── */}
      <nav
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 12px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          marginBottom: 8,
        }}
      >
        <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
          RIP PACKS CITY
        </Link>
        <span style={{ margin: "0 8px" }}>·</span>
        {collectionSlugUrl ? (
          <Link
            href={`/${collectionSlugUrl}/overview`}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            {collectionDisplay}
          </Link>
        ) : (
          <span>{collectionDisplay}</span>
        )}
        <span style={{ margin: "0 8px" }}>·</span>
        <span style={{ color: tierColor }}>{tier || "—"}</span>
        {e.set_name ? (
          <>
            <span style={{ margin: "0 8px" }}>·</span>
            <span>{e.set_name.toUpperCase()}</span>
          </>
        ) : null}
      </nav>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 5vw, 44px)",
          lineHeight: 1.1,
          margin: "0 0 4px",
          letterSpacing: "0.01em",
        }}
      >
        {subject}
        {serial ? (
          <span style={{ color: "var(--rpc-text-muted)", fontWeight: 400 }}>
            {" · #"}{serial}{mint ? `/${mint}` : ""}
          </span>
        ) : null}
      </h1>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm, 13px)",
          color: "var(--rpc-text-muted)",
          marginBottom: 24,
        }}
      >
        {[
          e.series != null ? seriesDisplay(e.series, e.collection_slug) : null,
          e.play_type ?? null,
          fmtAbsDate(e.game_date),
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      {/* ── Hero (image + FMV card) ────────────────────────────────────── */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 24,
          marginBottom: 24,
        }}
        className="rpc-moment-hero"
      >
        <div
          style={{
            border: `2px solid ${tierColor}`,
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--rpc-surface, #0a0a0a)",
            aspectRatio: "1 / 1",
            position: "relative",
          }}
        >
          <MomentHeroMedia
            imageCandidates={heroImageCandidates}
            videoUrl={e.video_url}
            alt={subject}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: 24,
            border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
            borderRadius: 12,
            background: "var(--rpc-surface, rgba(255,255,255,0.02))",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs, 12px)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "var(--rpc-text-muted)",
            }}
          >
            Current FMV
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(40px, 7vw, 64px)",
              lineHeight: 1,
              color: f?.fmv_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
            }}
          >
            {f?.fmv_usd != null ? fmtUsd(f.fmv_usd) : "FMV unavailable"}
          </div>

          {f?.confidence ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--rpc-text-muted)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    f.confidence === "HIGH"
                      ? "var(--rpc-success, var(--rpc-text-primary))"
                      : f.confidence === "MEDIUM"
                        ? "var(--rpc-warning, var(--rpc-text-primary))"
                        : "var(--rpc-text-muted)",
                  display: "inline-block",
                }}
              />
              {f.confidence}
              {f.sales_count_30d ? ` · ${f.sales_count_30d} sales / 30d` : ""}
              {f.sales_count_30d == null && f.sales_count_7d ? ` · ${f.sales_count_7d} sales / 7d` : ""}
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 12,
              marginTop: 8,
            }}
          >
            <StatCell label="Floor" value={fmtUsd(f?.floor_price_usd)} />
            <StatCell label="WAP" value={fmtUsd(f?.wap_usd)} />
            <StatCell
              label={ASK_LABEL[collectionSlugUrl ?? ""] ?? "Floor ask"}
              value={fmtUsd(highOffer?.low_ask ?? f?.top_shot_ask ?? f?.cross_market_ask)}
            />
            {hasBestOffer && (
              <StatCell
                label="Best offer"
                value={
                  <span title={bestOfferUpdatedAt ? fmtAbsDate(bestOfferUpdatedAt) : undefined}>
                    {fmtUsd(bestOfferAmount)}
                    {bestOfferGrain === "serial" ? (
                      <span style={{ color: "var(--rpc-red)" }}> · serial</span>
                    ) : null}
                    {bestOfferUpdatedAt ? (
                      <span style={{ color: "var(--rpc-text-muted)" }}> · {fmtRelDate(bestOfferUpdatedAt)}</span>
                    ) : null}
                  </span>
                }
              />
            )}
          </div>

          {/* Badges row (edition-wide) + special-serial pills (per-NFT only) */}
          {(badges.length > 0 || specialSerials.length > 0 || derivedSerialBadges.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {derivedSerialBadges.map(label => (
                <span
                  key={`ds-${label}`}
                  style={{
                    display: "inline-block",
                    padding: "3px 9px",
                    background: "var(--rpc-red)",
                    color: "var(--rpc-text-primary, #fff)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </span>
              ))}
              {specialSerials.map(s => (
                <span
                  key={`ss-${s.badge_type}-${s.serial_number}`}
                  style={{
                    display: "inline-block",
                    padding: "3px 9px",
                    background: "var(--rpc-red)",
                    color: "var(--rpc-text-primary, #fff)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  {specialSerialLabel(s.badge_type)}
                </span>
              ))}
              {badges.map(b => (
                <span
                  key={`b-${b.id}`}
                  title={b.source ? `Source: ${b.source}` : undefined}
                  style={{
                    display: "inline-block",
                    padding: "3px 9px",
                    border: "1px solid var(--rpc-border, rgba(255,255,255,0.18))",
                    color: "var(--rpc-text-primary)",
                    background: "var(--rpc-surface-raised)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  {b.title}
                </span>
              ))}
            </div>
          )}

          {marketplaceUrl && marketplaceName ? (
            <TrackedOutboundLink
              href={marketplaceUrl}
              payload={{
                surface: "moment",
                destination: `${collectionSlugUrl}_listing`,
                editionKey: e.external_id,
                momentId: marketplaceNftId,
                playerName: e.player_name,
                setName: e.set_name,
                tier: e.tier,
                serial,
                fmv: f?.fmv_usd ?? null,
              }}
              style={{
                marginTop: 4,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "12px 20px",
                background: "var(--rpc-red)",
                // brand-exception: white label on the red CTA button — theme-independent
                color: "#fff",
                borderRadius: 8,
                textDecoration: "none",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              View on {marketplaceName} →
            </TrackedOutboundLink>
          ) : null}

          {dapperUrl ? (
            <TrackedOutboundLink
              href={dapperUrl}
              payload={{
                surface: "moment",
                destination: "dapper_market_listing",
                editionKey: e.external_id,
                momentId: marketplaceNftId,
                playerName: e.player_name,
                setName: e.set_name,
                tier: e.tier,
                serial,
                fmv: f?.fmv_usd ?? null,
              }}
              style={{
                marginTop: 4,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "12px 20px",
                background: "transparent",
                color: "var(--rpc-red)",
                border: "1px solid var(--rpc-red)",
                borderRadius: 8,
                textDecoration: "none",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              View on Dapper ↗
            </TrackedOutboundLink>
          ) : null}
        </div>
      </section>

      {/* ── Info bar (relocated from footer for visibility) ─────────────── */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 32,
        }}
      >
        <StatCell
          label="Mint count"
          value={
            serial != null && mint
              ? `#${serial} / ${mint.toLocaleString()}`
              : mint ? mint.toLocaleString() : "—"
          }
        />
        <StatCell label="Tier" value={tier || "—"} />
        <StatCell label="Series" value={e.series != null ? seriesDisplay(e.series, e.collection_slug) : "—"} />
        <StatCell
          label="Team"
          value={
            e.team_name
              ? (teamHref
                  ? <Link href={teamHref} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>{e.team_name}</Link>
                  : e.team_name)
              : "—"
          }
        />
        <StatCell label="Play type" value={e.play_type && e.play_type !== "Unknown" ? e.play_type : "—"} />
        <StatCell label="Game date" value={fmtAbsDate(e.game_date) || "—"} />
      </section>

      {/* Serial-specific block (when kind='moment') */}
      {r?.kind === "moment" && ss ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Serial #{serial} state</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
            }}
          >
            <StatCell label="Owner" value={<OwnerLink address={ss.owner_address} name={nameFor(ss.owner_address)} />} />
            <StatCell label="Listed" value={ss.is_listed === true ? "YES" : ss.is_listed === false ? "NO" : "—"} />
            <StatCell label="List price" value={fmtUsd(ss.list_price)} />
            <StatCell
              label="Last sale"
              value={
                ss.last_sale?.price_usd != null
                  ? `${fmtUsd(ss.last_sale.price_usd)} · ${fmtRelDate(ss.last_sale.sold_at)}`
                  : "—"
              }
            />
          </div>
        </section>
      ) : null}

      {/* Special serials (edition-wide notable serials + holders) — Item 2.
          Gated on at least one row carrying a tracked owner or a last sale so
          the section never renders as a hollow list of "—" placeholders. */}
      {notableSerials.length > 0 &&
      notableSerials.some((n) => n.holder_address || n.last_sale_usd != null) ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Special serials</SectionTitle>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs, 11px)",
              color: "var(--rpc-text-muted)",
              marginTop: -4,
              marginBottom: 12,
              letterSpacing: "0.04em",
            }}
          >
            Notable serials — #1, jersey match, and the perfect serial (final mint) — with their last sale and tracked owner where known.
          </div>
          <div
            style={{
              border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
              borderRadius: 8,
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm, 13px)",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.08))", color: "var(--rpc-text-muted)" }}>
                  <Th>Serial</Th>
                  <Th>Type</Th>
                  <Th>Last sale</Th>
                  <Th>Owner</Th>
                </tr>
              </thead>
              <tbody>
                {notableSerials.map((n) => {
                  const isThisSerial = serial != null && n.serial === serial
                  const accent = n.tag === "#1" || n.tag === "jersey"
                  return (
                    <tr
                      key={`${n.tag}-${n.serial}`}
                      style={{
                        borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.04))",
                        background: isThisSerial ? "var(--rpc-red-bg, rgba(224,58,47,0.10))" : undefined,
                      }}
                      title={isThisSerial ? "This serial" : undefined}
                    >
                      <Td>
                        #{n.serial}
                        {isThisSerial ? <span style={{ color: "var(--rpc-red)", marginLeft: 6 }}>●</span> : null}
                      </Td>
                      <Td>
                        <span style={{ color: accent ? "var(--rpc-red)" : "var(--rpc-text-primary)" }}>
                          {notableTagLabel(n.tag)}
                        </span>
                      </Td>
                      <Td>
                        {n.last_sale_usd != null ? (
                          <span title={fmtAbsDate(n.last_sold_at)}>
                            {fmtUsd(n.last_sale_usd)} · {fmtRelDate(n.last_sold_at)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--rpc-text-muted)" }}>never sold</span>
                        )}
                      </Td>
                      <Td>
                        {n.holder_address ? (
                          <OwnerLink address={n.holder_address} name={nameFor(n.holder_address)} />
                        ) : (
                          <span style={{ color: "var(--rpc-text-muted)" }}>—</span>
                        )}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Recent activity */}
      <section style={{ marginBottom: 32 }}>
        <SectionTitle>Recent activity</SectionTitle>
        {recentSales.length === 0 ? (
          <EmptyRow>No recorded sales yet.</EmptyRow>
        ) : (
          <div
            style={{
              border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
              borderRadius: 8,
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm, 13px)",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.08))", color: "var(--rpc-text-muted)" }}>
                  <Th>Serial</Th>
                  <Th>Price</Th>
                  <Th>When</Th>
                  <Th>Buyer</Th>
                  <Th>Seller</Th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((s, i) => {
                  const isThisSerial = r?.kind === "moment" && serial != null && s.serial_number === serial
                  return (
                  <tr
                    key={`${s.sold_at}-${s.serial_number}-${i}`}
                    style={{
                      borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.04))",
                      background: isThisSerial ? "var(--rpc-red-bg, rgba(224,58,47,0.10))" : undefined,
                    }}
                    title={isThisSerial ? "This serial" : undefined}
                  >
                    <Td>
                      {s.serial_number != null ? `#${s.serial_number}` : "—"}
                      {isThisSerial ? <span style={{ color: "var(--rpc-red)", marginLeft: 6 }}>●</span> : null}
                    </Td>
                    <Td>{fmtUsd(s.price_usd)}</Td>
                    <Td>
                      <span title={fmtAbsDate(s.sold_at)}>{fmtRelDate(s.sold_at)}</span>
                    </Td>
                    <Td><OwnerLink address={s.buyer_address} name={nameFor(s.buyer_address)} /></Td>
                    <Td><OwnerLink address={s.seller_address} name={nameFor(s.seller_address)} /></Td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Parallels (same player + same play_id_onchain, different set) */}
      {parallels.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Parallels</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {parallels.map((p) => (
              <Link
                key={p.id}
                href={`/moment/${p.id}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid var(--rpc-red)",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "var(--rpc-bg, #000)" }}>
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnail_url}
                      alt={p.player_name ?? "parallel"}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : null}
                </div>
                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                    {p.set_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs, 11px)",
                      color: "var(--rpc-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                    }}
                  >
                    {(p.tier ?? "").toUpperCase()}
                    {p.circulation_count != null ? ` · ${p.circulation_count.toLocaleString()} mint` : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Similar editions */}
      {similar.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Similar editions</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {similar.slice(0, 6).map((s) => (
              <Link
                key={s.id}
                href={`/moment/${s.id}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "var(--rpc-bg, #000)" }}>
                  {s.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.thumbnail_url}
                      alt={s.player_name ?? "moment"}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : null}
                </div>
                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                    {s.player_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs, 11px)",
                      color: "var(--rpc-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                    }}
                  >
                    {(s.tier ?? "").toUpperCase()} · {s.set_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm, 13px)",
                      color: s.fmv_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
                    }}
                  >
                    {s.fmv_usd != null ? fmtUsd(s.fmv_usd) : "No sales"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 11px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          textAlign: "center",
        }}
      >
        Powered by Rip Packs City
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd) }}
      />

      <style>{`
        @media (min-width: 768px) {
          .rpc-moment-hero {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </main>
    <SiteFooter />
    </>
  )
}

// Presentational helpers

// Wave 2 (PIN-FMV-REKEY): "Pick a pin" list for a Pinnacle legacy edition_key
// that fans out to multiple renders. Each card links to the render-true per-pin
// page at /pinnacle/moment/<render_id> (the canonical Pinnacle surface).
function PinnacleDisambiguation({ renders }: { renders: PinnacleRender[] }) {
  return (
    <>
      <main
        style={{
          minHeight: "100vh",
          background: "var(--rpc-bg, transparent)",
          padding: "32px 16px 80px",
          maxWidth: 1200,
          margin: "0 auto",
          color: "var(--rpc-text-primary)",
        }}
      >
        <nav
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs, 12px)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--rpc-text-muted)",
            marginBottom: 8,
          }}
        >
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
            RIP PACKS CITY
          </Link>
          <span style={{ margin: "0 8px" }}>·</span>
          <Link href="/disney-pinnacle/overview" style={{ color: "inherit", textDecoration: "none" }}>
            DISNEY PINNACLE
          </Link>
        </nav>

        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(28px, 5vw, 44px)",
            lineHeight: 1.1,
            margin: "0 0 8px",
            letterSpacing: "0.01em",
          }}
        >
          Pick a pin
        </h1>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm, 13px)",
            color: "var(--rpc-text-muted)",
            marginBottom: 24,
          }}
        >
          {renders.length} distinct renders share this set-level key — each is a different character / variant with its own price.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {renders.map((r) => (
            <Link
              key={r.render_id}
              href={`/pinnacle/moment/${encodeURIComponent(r.render_id)}`}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                textDecoration: "none",
                color: "inherit",
                border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                padding: 10,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.thumbnail_url ?? `/api/public/pinnacle-image/${encodeURIComponent(r.render_id)}`}
                alt={r.character_name ?? "Pinnacle pin"}
                width={72}
                height={72}
                style={{ width: 72, height: 72, objectFit: "contain", flexShrink: 0, borderRadius: 4, background: "var(--rpc-bg, #000)" }}
                loading="lazy"
              />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                  {r.character_name ?? r.render_id}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    color: "var(--rpc-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.variant ?? "—"}
                  {r.total_minted != null ? ` · ${r.total_minted.toLocaleString()} mint` : ""}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm, 13px)",
                    color: r.fmv_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
                  }}
                >
                  {r.fmv_usd != null ? fmtUsd(r.fmv_usd) : "—"}
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div
          style={{
            marginTop: 32,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs, 11px)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          <Link href="/insights/pinnacle-scarcity" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>
            ← Pinnacle scarcity board
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs, 12px)",
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: "var(--rpc-text-muted)",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: React.ReactNode }) {
  const titleAttr = typeof value === "string" ? value : undefined
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid var(--rpc-border, rgba(255,255,255,0.06))",
        borderRadius: 8,
        background: "var(--rpc-bg-elev, rgba(255,255,255,0.02))",
        minHeight: 56,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 11px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm, 14px)",
          color: "var(--rpc-text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={titleAttr}
      >
        {value}
      </div>
    </div>
  )
}

function OwnerLink({ address, name }: { address: string | null | undefined; name?: string | null }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>—</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  const trunc = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <Link
      href={`/profile/${lower}`}
      title={name ? `${name} · ${address}` : address}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}
    >
      {name ? `@${name}` : trunc}
    </Link>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 16px",
        border: "1px dashed var(--rpc-border, rgba(255,255,255,0.08))",
        borderRadius: 8,
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm, 13px)",
        color: "var(--rpc-text-muted)",
      }}
    >
      {children}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "10px 12px",
        textAlign: "left",
        fontWeight: 400,
        fontSize: "var(--text-xs, 11px)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </th>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "10px 12px" }}>
      {children}
    </td>
  )
}
