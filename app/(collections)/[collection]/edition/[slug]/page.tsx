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

const SALES_PAGE_SIZE = 30

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

  const [history, sales, packs, specialSerials, highOffer, parallels, insightLinks] = await Promise.all([
    fetchHistory(coll.id, slug, 30),
    fetchSales(coll.id, slug, SALES_PAGE_SIZE, 0),
    fetchPacks(coll.id, slug),
    isPinnacle ? Promise.resolve([] as SpecialSerialRow[]) : fetchSpecialSerials(detail.id),
    fetchHighOffer(detail.id),
    fetchParallels(detail.id),
    collection === "nba-top-shot"
      ? fetchInsightLinks(detail.id, detail.external_id)
      : Promise.resolve(EMPTY_INSIGHT_LINKS),
  ])

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

  const editionTitle = detail.player_name ?? detail.name ?? "Edition"

  // Ask cell (H2/H3): prefer the marketplace low_ask; fall back to the
  // V1-Dapper cross-market ask (populated for ~2.7K All Day editions where
  // badge_editions.low_ask is null). Label is collection-aware.
  const askValue = highOffer?.low_ask ?? fmv?.cross_market_ask ?? null
  const askLabel = ASK_LABEL[collection] ?? "Floor ask"
  // Best-offer cell (H1): only render when there's a real positive offer.
  // edition_offers is Top-Shot-only today, so an em-dash here would be a
  // permanent placeholder on every other collection.
  const hasBestOffer = typeof highOffer?.highest_offer === "number" && highOffer.highest_offer > 0
  // H5: only render pack tiles that resolved a real title. Some All Day dist_ids
  // have no matching pack_distributions row, so get_edition_in_packs returns
  // pack_title=NULL and the card would render a bare "Pack" placeholder.
  const namedPacks = packs.filter(p => typeof p.pack_title === "string" && p.pack_title.trim().length > 0)

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
              // Branded placeholder for artless editions (~54% TS thumbnail coverage)
              // so the empty media box reads as intentional, not broken.
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, height: "100%", background: "linear-gradient(135deg, rgba(224,58,47,0.08), rgba(0,0,0,0.45))" }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.08em", color: "var(--rpc-red)", opacity: 0.55 }}>RPC</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>No preview</div>
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
        />
        {hasBestOffer && (
          <StatCell
            label="Best offer"
            value={fmtUsd(highOffer?.highest_offer ?? null)}
            sub={highOffer?.updated_at ? relTime(highOffer.updated_at) : undefined}
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
            <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {specialSerials.map(r => (
                <div key={`${r.badge_type}-${r.serial_number}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,160px) 1fr 1fr 120px", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4, minWidth: 460 }}>
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
