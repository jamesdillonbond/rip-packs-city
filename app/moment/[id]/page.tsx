// app/moment/[id]/page.tsx
//
// Public, server-rendered edition / moment detail page. Resolves [id] as
// flow nft_id (numeric), moment uuid (serial-specific), or edition uuid
// (aggregate). Backed by the SECDEF RPC public.get_moment_detail.
//
// Targets:
//   - Trophy Slab QR codes (already shipping)
//   - Insider Signals card click-through
//   - Fast Break lineup rows (Phase 2 wallet-aware)
//   - SEO: "<player> <set> #<serial>" long-tail queries
//
// Phase 1 — public, no auth, no owner-only edit features.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ── RPC payload shape (matches public.get_moment_detail) ───────────────────

type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NO_DATA" | "ASK_ONLY" | "SALES_ONLY" | "STALE" | null

interface MomentResolved {
  kind: "moment" | "edition"
  moment_id: string | null
  edition_id: string
  serial_number: number | null
  collection_id: string
  collection_slug: string
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
}

// ── Fetch + formatters ─────────────────────────────────────────────────────

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

// ── Metadata (SEO) ─────────────────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params
  const detail = await fetchDetail(id)
  if (!detail || detail.ok === false || !detail.edition) {
    return {
      title: "Moment Not Found — Rip Packs City",
      description: "This moment isn't in our index yet.",
    }
  }
  const e = detail.edition
  const serial = detail.resolved?.serial_number
  const mint = e.circulation_count ?? 0
  const tier = (e.tier ?? "").toUpperCase()
  const player = e.player_name ?? "Moment"
  const setName = e.set_name ?? ""
  const sales30 = detail.fmv?.sales_count_30d ?? 0
  const serialSuffix = serial ? ` #${serial}/${mint}` : (mint ? ` (${mint} circulation)` : "")
  const title = `${player}${serialSuffix} · ${setName} · ${tier} | Rip Packs City`
  const description = `Live FMV, sale history, and market data for ${player} ${setName}${serialSuffix} on ${collectionLabel(e.collection_slug).toLowerCase().replace(/^\w/, c => c.toUpperCase())}. ${sales30 ? `${sales30} sales in last 30 days. ` : ""}Powered by Rip Packs City.`
  const ogImage = `/api/og/moment/${encodeURIComponent(id)}`
  return {
    title,
    description,
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
  const { id } = await params
  const detail = await fetchDetail(id)
  if (!detail || detail.ok === false || !detail.edition) {
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
  const tierColor = tierColorVar(e.tier)
  const collectionSlugUrl = urlSlugForCollection(e.collection_slug)
  const collectionDisplay = collectionLabel(e.collection_slug)

  // Schema.org Product JSON-LD — gives crawlers a structured snapshot of the
  // moment as a saleable item with current FMV as the price hint.
  const priceForSchema = f?.fmv_usd ?? f?.floor_price_usd ?? null
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${e.player_name ?? "Moment"}${serial ? ` #${serial}/${mint}` : ""} · ${e.set_name ?? ""}`,
    description: `${e.player_name ?? "Moment"} ${e.set_name ?? ""} on ${collectionDisplay}`,
    image: e.thumbnail_url ?? undefined,
    brand: { "@type": "Brand", name: collectionDisplay },
    sku: r?.moment_id ?? r?.edition_id,
    offers: priceForSchema != null
      ? {
          "@type": "Offer",
          priceCurrency: "USD",
          price: priceForSchema.toFixed(2),
          availability: "https://schema.org/InStock",
        }
      : undefined,
  }

  return (
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
        {e.player_name ?? e.name ?? "Moment"}
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
          marginBottom: 32,
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
          {e.video_url ? (
            <video
              src={e.video_url}
              poster={e.thumbnail_url ?? undefined}
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : e.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={e.thumbnail_url}
              alt={e.player_name ?? "Moment"}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--rpc-text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              No media
            </div>
          )}
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
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginTop: 8,
            }}
          >
            <StatCell label="Floor" value={fmtUsd(f?.floor_price_usd)} />
            <StatCell label="WAP" value={fmtUsd(f?.wap_usd)} />
            <StatCell label="Top Shot ask" value={fmtUsd(f?.top_shot_ask)} />
          </div>

          {serial === 1 ? (
            <div
              style={{
                marginTop: 4,
                display: "inline-block",
                padding: "4px 10px",
                background: "var(--rpc-red)",
                color: "var(--rpc-text-primary, #fff)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                width: "fit-content",
              }}
            >
              #1 Serial
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Serial-specific block (when kind='moment') ──────────────────── */}
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
            <StatCell label="Owner" value={ss.owner_address ?? "—"} />
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

      {/* ── Recent activity ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <SectionTitle>Recent activity</SectionTitle>
        {recentSales.length === 0 ? (
          <EmptyRow>No sales in the last 30 days.</EmptyRow>
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
                  <Th>Marketplace</Th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((s, i) => (
                  <tr key={`${s.sold_at}-${s.serial_number}-${i}`} style={{ borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.04))" }}>
                    <Td>{s.serial_number != null ? `#${s.serial_number}` : "—"}</Td>
                    <Td>{fmtUsd(s.price_usd)}</Td>
                    <Td>
                      <span title={fmtAbsDate(s.sold_at)}>{fmtRelDate(s.sold_at)}</span>
                    </Td>
                    <Td>{s.marketplace ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Similar editions ────────────────────────────────────────────── */}
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
                    {s.fmv_usd != null ? fmtUsd(s.fmv_usd) : "—"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Footer band: edition stats grid ─────────────────────────────── */}
      <section
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <StatCell label="Mint count" value={mint ? mint.toLocaleString() : "—"} />
        <StatCell label="Tier" value={tier || "—"} />
        <StatCell label="Series" value={e.series != null ? seriesDisplay(e.series, e.collection_slug) : "—"} />
        <StatCell label="Team" value={e.team_name ?? "—"} />
        <StatCell label="Play type" value={e.play_type ?? "—"} />
        <StatCell label="Game date" value={fmtAbsDate(e.game_date) || "—"} />
      </section>

      <div
        style={{
          marginTop: 32,
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
  )
}

// ── Tiny presentational helpers ────────────────────────────────────────────

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

function StatCell({ label, value }: { label: string; value: string }) {
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
        title={value}
      >
        {value}
      </div>
    </div>
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
