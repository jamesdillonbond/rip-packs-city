// app/(collections)/[collection]/edition/[slug]/page.tsx
// Phase 1B. Edition detail page for all 5 published collections.
//
// Data: get_edition_detail + get_edition_recent_sales + get_edition_fmv_history
// + get_edition_in_packs server-side. Special serials read directly from
// special_serial_holders for non-Pinnacle collections.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug, isPinnacleUrlSlug } from "@/lib/collection-slug"
import { editionPageMetadata, editionJsonLd, collectionDisplayName } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { slugifyName } from "@/lib/entity-labels"
import {
  ConfidencePill,
  EM_DASH,
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

const SALES_PAGE_SIZE = 30

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

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; slug: string }> }
): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
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

  const detail = await fetchDetail(coll.id, slug)
  if (!detail) notFound()

  const isPinnacle = isPinnacleUrlSlug(collection)

  const [history, sales, packs, specialSerials, highOffer, parallels] = await Promise.all([
    fetchHistory(coll.id, slug, 30),
    fetchSales(coll.id, slug, SALES_PAGE_SIZE, 0),
    fetchPacks(coll.id, slug),
    isPinnacle ? Promise.resolve([] as SpecialSerialRow[]) : fetchSpecialSerials(detail.id),
    fetchHighOffer(detail.id),
    fetchParallels(detail.id),
  ])

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

  const editionTitle = detail.player_name ?? detail.name ?? "Edition"

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(editionJsonLd(detail as unknown as Record<string, unknown>, collection)) }}
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
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,320px) 1fr", gap: 24, alignItems: "start" }}>
          <div style={{ position: "relative", width: "100%", maxWidth: 320, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden" }}>
            {hasVideo ? (
              <video
                src={detail.video_url ?? undefined}
                poster={detail.thumbnail_url ?? undefined}
                muted
                loop
                playsInline
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : detail.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={detail.thumbnail_url} alt={detail.player_name ?? detail.name ?? "Edition"} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                No image
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {playerHref ? (
                <Link href={playerHref} style={{ color: "inherit", textDecoration: "none" }}>{detail.player_name ?? detail.name ?? "Edition"}</Link>
              ) : (detail.player_name ?? detail.name ?? "Edition")}
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {detail.badges.map(b => (
                  <span key={b} className="rpc-mono" style={{ padding: "2px 6px", border: "1px solid var(--rpc-border)", borderRadius: 3, fontSize: 10, color: "var(--rpc-text-secondary)" }}>{b}</span>
                ))}
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
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <StatCell
          label="Current FMV"
          value={fmtUsd(fmv?.fmv_usd ?? null)}
          sub={<ConfidencePill confidence={fmv?.confidence ?? null} />}
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
          label="Top Shot ask"
          value={fmtUsd(highOffer?.low_ask ?? null)}
        />
        <StatCell
          label="Best offer"
          value={fmtUsd(highOffer?.highest_offer ?? null)}
          sub={highOffer?.updated_at ? relTime(highOffer.updated_at) : undefined}
        />
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

      {/* ── FMV history chart ────────────────────────────────────────────── */}
      <Section title="FMV History">
        <FmvHistoryChart collectionUrlSlug={collection} routeSlug={detail.route_slug ?? slug} initial={history} />
      </Section>

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

      {/* ── Parallels (same player + same play_id_onchain, different set) ── */}
      {parallels.length > 0 && (
        <Section title="Parallels">
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
      {packs.length > 0 && (
        <Section title="Found in These Packs">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {packs.map(p => (
              <Link
                key={p.dist_id}
                href={`/${collection}/pack/dist/${encodeURIComponent(p.dist_id)}`}
                className="rpc-card"
                style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.3)", borderRadius: 4, overflow: "hidden", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {p.pack_image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.pack_image_url} alt={p.pack_title ?? "Pack"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>Pack</span>
                  )}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
                  {p.pack_title ?? "Pack"}
                </div>
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
                  {p.drop_weight !== null ? `${p.drop_weight} slot${p.drop_weight === 1 ? "" : "s"}` : "weight unknown"}
                  {p.depletion_pct !== null && p.depletion_pct !== undefined ? <> · {Math.round(p.depletion_pct)}% depleted</> : null}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Special serials (non-Pinnacle) ───────────────── */}
      {!isPinnacle && (
        <Section title="Special Serials">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Tracked owners of #1, jersey-match, and perfect-mint serials.
          </div>
          {specialSerials.length === 0 ? (
            <div style={{ padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              Cadence sweep in progress — owner data populating
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {specialSerials.map(r => (
                <div key={`${r.badge_type}-${r.serial_number}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,160px) 1fr 1fr 120px", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4 }}>
                  <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-primary)", letterSpacing: "0.06em", textTransform: "capitalize" }}>{badgeLabel(r.badge_type)}</span>
                  <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>#{r.serial_number}</span>
                  <WalletLink address={r.holder_address} />
                  <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", textAlign: "right" }}>{relTime(r.last_verified_at)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

function badgeLabel(badge_type: string): string {
  switch (badge_type) {
    case "first_serial": return "#1 Serial"
    case "jersey_match": return "Jersey Match"
    case "perfect_mint": return "Perfect Mint"
    default: return badge_type.replace(/_/g, " ")
  }
}
