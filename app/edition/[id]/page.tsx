// Per-edition SEO surface. One indexable URL per `editions.id` row across
// every published collection — the foundation for ~20.5K crawlable pages.
//
// Data: single `get_edition_page_data(p_edition_id uuid)` RPC returning a
// JSONB shape with edition + collection + fmv + recent sales + 30d
// summary. Server-rendered with 60s ISR so sales/FMV updates propagate
// without per-request DB load.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { DB_SLUG_TO_SLUG } from "@/lib/collections"

export const revalidate = 60
export const dynamicParams = true

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app"

interface EditionRow {
  id: string
  external_id: string | null
  name: string | null
  tier: string | null
  series: number | null
  edition_kind: string | null
  circulation_count: number | null
  badges: string[] | null
  thumbnail_url: string | null
  video_url: string | null
  play_type: string | null
  play_category: string | null
  game_date: string | null
  home_team: string | null
  away_team: string | null
  first_minted_at: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  player_id: string | null
  set_id: string | null
}

interface CollectionRow {
  id: string
  slug: string
  name: string
}

interface FmvRow {
  fmv_usd: number | null
  floor_price_usd: number | null
  wap_usd: number | null
  confidence: string | null
  listing_count: number | null
  sales_count_7d: number | null
  sales_count_30d: number | null
  days_since_sale: number | null
  liquidity_rating: number | null
  computed_at: string | null
}

interface SaleRow {
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  marketplace: string | null
  seller_address: string | null
  buyer_address: string | null
  transaction_hash: string | null
}

interface SalesSummary {
  count: number | null
  volume_usd: number | null
  avg_price_usd: number | null
  min_price_usd: number | null
  max_price_usd: number | null
  unique_buyers: number | null
  unique_sellers: number | null
}

interface EditionPageData {
  edition: EditionRow
  collection: CollectionRow
  fmv: FmvRow | null
  recent_sales: SaleRow[]
  sales_30d_summary: SalesSummary | null
}

const TIER_COLORS: Record<string, string> = {
  COMMON: "#9ca3af",
  UNCOMMON: "#14b8a6",
  FANDOM: "#60a5fa",
  RARE: "#38bdf8",
  LEGENDARY: "#fbbf24",
  ULTIMATE: "#c084fc",
}

const TIER_BG: Record<string, string> = {
  COMMON: "rgba(156,163,175,0.10)",
  UNCOMMON: "rgba(20,184,166,0.12)",
  FANDOM: "rgba(96,165,250,0.12)",
  RARE: "rgba(56,189,248,0.12)",
  LEGENDARY: "rgba(251,191,36,0.12)",
  ULTIMATE: "rgba(192,132,252,0.14)",
}

async function loadEdition(id: string): Promise<EditionPageData | null> {
  if (!UUID_RE.test(id)) return null
  try {
    const { data, error } = await (supabaseAdmin.rpc as any)(
      "get_edition_page_data",
      { p_edition_id: id }
    )
    if (error) {
      console.log("[edition/page] rpc_error " + error.message)
      return null
    }
    if (!data) return null
    return data as EditionPageData
  } catch (e: any) {
    console.log("[edition/page] error " + (e?.message || e))
    return null
  }
}

function fmtUsd(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  return fmtUsd(n)
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  if (ms < 0) return "just now"
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon}mo ago`
  const yr = Math.floor(mon / 12)
  return `${yr}y ago`
}

function frontendSlug(dbSlug: string): string {
  return DB_SLUG_TO_SLUG[dbSlug] ?? dbSlug.replace(/_/g, "-")
}

function describeEditionLabel(e: EditionRow): string {
  if (e.name) return e.name
  if (e.player_name) {
    const tier = e.tier ? ` ${e.tier.toLowerCase()}` : ""
    return `${e.player_name}${tier}`
  }
  return "Edition"
}

// Best-effort player display when editions.player_name is null but the
// player name is folded into edition.name (e.g. "Kevin Porter Jr. — Holo
// Icon"). Splits on em-dash / hyphen / colon.
function inferPlayerFromName(e: EditionRow): string | null {
  if (e.player_name) return e.player_name
  if (!e.name) return null
  const head = e.name.split(/[—–:|]|\s-\s/)[0]?.trim()
  return head && head.length > 0 ? head : null
}

// Suppress dollar headlines when the snapshot is ask-derived (LOW confidence
// + zero recent trades). Read by metadata, JSON-LD, and FmvCard so all three
// surfaces gate consistently — public pages must never present an inflated
// 1-of-1 ask as authoritative pricing.
function isInflatedAskOnly(fmv: FmvRow | null): boolean {
  return (
    fmv != null &&
    fmv.fmv_usd != null &&
    (fmv.confidence ?? "").toUpperCase() === "LOW" &&
    (fmv.sales_count_30d ?? 0) === 0 &&
    (fmv.sales_count_7d ?? 0) === 0
  )
}

// 522 residual editions have NULL player_name and either a NULL name or a
// set-only name (e.g. "NFL Draft"). Render the collection-scoped fallback so
// we surface 4 distinct h1 strings instead of 522 identical "Unknown player"
// — honest about what we know.
function heroPlayerDisplay(
  edition: EditionRow,
  collection: CollectionRow
): string {
  if (edition.player_name) return edition.player_name
  if (edition.name && edition.name.includes("—")) {
    const head = edition.name.split("—")[0]?.trim()
    if (head) return head
  }
  return `${collection.name} Edition`
}

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params
  if (!UUID_RE.test(id)) {
    return { title: "Edition not found — Rip Packs City" }
  }
  const data = await loadEdition(id)
  if (!data) {
    return { title: "Edition not found — Rip Packs City" }
  }

  const { edition, collection, fmv, sales_30d_summary } = data
  const player = inferPlayerFromName(edition)
  const editionLabel = describeEditionLabel(edition)
  const tier = edition.tier ?? ""
  // Root metadata template in lib/seo.ts auto-appends " | Rip Packs City"
  // when title is a string — don't repeat it here.
  const titleParts: string[] = []
  if (player && !editionLabel.includes(player)) titleParts.push(player)
  titleParts.push(editionLabel)
  if (tier) titleParts.push(tier)
  const title = titleParts.join(" ").replace(/\s+/g, " ").trim()

  const kind = edition.edition_kind ?? null
  const kindLabel = kind === "LE" ? "Limited Edition" : kind
  const circ = edition.circulation_count ?? null
  const sales30d = sales_30d_summary?.count ?? 0
  const fmvUsd = fmv?.fmv_usd ?? null
  const inflated = isInflatedAskOnly(fmv)

  let description: string
  if (inflated) {
    // Ask-only inflated edition — never surface the dollar figure to crawlers
    // or social previews. Compose from durable metadata only.
    const kindStr = kindLabel ?? "Moment"
    const tierStr = tier ? tier.toLowerCase() : ""
    const subject = [kindStr, tierStr].filter(Boolean).join(" ")
    const circStr =
      circ != null ? `, ${circ.toLocaleString()} minted` : ""
    description = `${subject} moment from ${collection.name}${circStr}.`
      .replace(/\s+/g, " ")
      .trim()
  } else {
    const lead = [kindLabel, player ?? collection.name]
      .filter(Boolean)
      .join(" ")
    const descParts: string[] = [lead]
    if (circ != null) descParts.push(`${circ.toLocaleString()} circulation`)
    if (fmvUsd != null) descParts.push(`FMV ${fmtUsd(fmvUsd)}`)
    if (sales30d > 0)
      descParts.push(`${sales30d} sale${sales30d === 1 ? "" : "s"} 30d`)
    descParts.push(`live ${collection.name} pricing on Rip Packs City`)
    description = descParts.join(" · ")
  }
  if (description.length > 160) description = description.slice(0, 157) + "…"

  const canonical = `${BASE_URL}/edition/${edition.id}`
  const ogImage = edition.thumbnail_url ?? `/api/og/collection/${frontendSlug(collection.slug)}`

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "article",
      url: canonical,
      siteName: "Rip Packs City",
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  }
}

function ProductJsonLd({ data }: { data: EditionPageData }) {
  const { edition, collection, fmv } = data
  const url = `${BASE_URL}/edition/${edition.id}`
  const obj: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": url,
    url,
    name: describeEditionLabel(edition),
    sku: edition.external_id ?? edition.id,
    brand: { "@type": "Brand", name: collection.name },
    category: collection.name,
  }
  if (edition.thumbnail_url) obj.image = edition.thumbnail_url
  if (edition.player_name) obj.description = `${edition.player_name} — ${collection.name}`

  // Omit offers entirely on ask-only inflated rows. Schema.org Product
  // without offers is valid ("product exists, no current sale data") and
  // honest. Substituting OutOfStock to preserve the price would be misleading.
  if (fmv && fmv.fmv_usd != null && !isInflatedAskOnly(fmv)) {
    const listingCount = fmv.listing_count ?? 0
    obj.offers = {
      "@type": "Offer",
      price: Number(fmv.fmv_usd.toFixed(2)),
      priceCurrency: "USD",
      url,
      availability:
        listingCount > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
    }
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(obj) }}
    />
  )
}

function HeroBlock({ data }: { data: EditionPageData }) {
  const { edition, collection } = data
  const tierKey = (edition.tier ?? "").toUpperCase()
  const tierColor = TIER_COLORS[tierKey] ?? "#9ca3af"
  const tierBg = TIER_BG[tierKey] ?? "rgba(255,255,255,0.06)"
  const slug = frontendSlug(collection.slug)
  const editionLabel = describeEditionLabel(edition)
  const player = heroPlayerDisplay(edition, collection)

  return (
    <header style={{ marginBottom: 32 }}>
      <nav
        aria-label="Breadcrumb"
        style={{
          fontSize: 12,
          color: "#6b7280",
          letterSpacing: "0.04em",
          marginBottom: 16,
          fontFamily: "monospace",
        }}
      >
        <Link href="/" style={{ color: "#6b7280", textDecoration: "none" }}>
          Home
        </Link>
        <span style={{ margin: "0 6px", color: "#374151" }}>›</span>
        <Link
          href={`/${slug}`}
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          {collection.name}
        </Link>
        <span style={{ margin: "0 6px", color: "#374151" }}>›</span>
        <span style={{ color: "#9ca3af" }}>{editionLabel}</span>
      </nav>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 360px) 1fr",
          gap: 32,
          alignItems: "start",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "1 / 1",
            background: "#111",
            border: `1px solid ${tierColor}33`,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {edition.video_url ? (
            <video
              src={edition.video_url}
              poster={edition.thumbnail_url ?? undefined}
              autoPlay
              muted
              loop
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : edition.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={edition.thumbnail_url}
              alt={`${player} — ${editionLabel}`}
              loading="eager"
              decoding="async"
              sizes="(max-width: 768px) 100vw, 360px"
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
                color: "#374151",
                fontSize: 64,
              }}
            >
              ?
            </div>
          )}
        </div>

        <div>
          <div
            style={{
              fontSize: 12,
              color: "#9ca3af",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            {collection.name} · Series {edition.series ?? "—"}
          </div>
          <h1
            style={{
              fontSize: 36,
              fontWeight: 900,
              color: "#fff",
              margin: 0,
              lineHeight: 1.15,
              fontFamily: "'Barlow Condensed', sans-serif",
              letterSpacing: "0.01em",
            }}
          >
            {player}
          </h1>
          <div
            style={{
              fontSize: 18,
              color: "#d1d5db",
              marginTop: 6,
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            {editionLabel}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 16,
            }}
          >
            {edition.tier && (
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: tierColor,
                  background: tierBg,
                  border: `1px solid ${tierColor}33`,
                }}
              >
                {edition.tier}
              </span>
            )}
            {edition.edition_kind && (
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#9ca3af",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  letterSpacing: "0.06em",
                }}
              >
                {edition.edition_kind}
              </span>
            )}
            {edition.circulation_count != null && (
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#e5e7eb",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  letterSpacing: "0.06em",
                }}
              >
                {edition.circulation_count.toLocaleString()} CIRC
              </span>
            )}
            {edition.team_name && (
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#9ca3af",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                {edition.team_name}
              </span>
            )}
            {edition.play_type && (
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#9ca3af",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                {edition.play_type}
              </span>
            )}
            {Array.isArray(edition.badges) &&
              edition.badges.map((b) => (
                <span
                  key={b}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#fbbf24",
                    background: "rgba(251,191,36,0.10)",
                    border: "1px solid rgba(251,191,36,0.25)",
                    letterSpacing: "0.06em",
                  }}
                >
                  {b}
                </span>
              ))}
          </div>

          {(edition.game_date || edition.home_team || edition.away_team) && (
            <div
              style={{
                marginTop: 16,
                fontSize: 13,
                color: "#9ca3af",
                fontFamily: "monospace",
              }}
            >
              {edition.game_date ?? ""}
              {edition.home_team || edition.away_team
                ? ` · ${edition.away_team ?? ""} @ ${edition.home_team ?? ""}`
                : ""}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function FmvCard({ fmv }: { fmv: FmvRow | null }) {
  const inflated = isInflatedAskOnly(fmv)

  if (!fmv || fmv.fmv_usd == null || inflated) {
    const subtext = inflated
      ? "No recent sales data — check back when this edition trades again."
      : "Insufficient sales history to compute a confidence-rated FMV."
    const headline = inflated ? "FMV pending" : "FMV coming soon"
    return (
      <section
        aria-label="Fair market value"
        style={{
          marginBottom: 32,
          padding: 24,
          border: "1px solid #1f2937",
          borderRadius: 12,
          background: "linear-gradient(180deg, #0f1115 0%, #0a0a0a 100%)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.12em",
            color: "#6b7280",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Fair Market Value
        </div>
        <div style={{ fontSize: 24, color: "#9ca3af" }}>{headline}</div>
        <div
          style={{
            fontSize: 12,
            color: "#6b7280",
            marginTop: 8,
            fontFamily: "monospace",
          }}
        >
          {subtext}
        </div>
      </section>
    )
  }

  const liquidity = fmv.liquidity_rating ?? 0
  const dots = [1, 2, 3, 4, 5].map((i) => (
    <span
      key={i}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: i <= liquidity ? "#10b981" : "rgba(255,255,255,0.10)",
        marginRight: 4,
      }}
    />
  ))

  const conf = (fmv.confidence ?? "").toUpperCase()
  const confColor =
    conf === "HIGH" ? "#10b981" : conf === "MEDIUM" ? "#fbbf24" : "#9ca3af"

  const stat = (label: string, value: string, color = "#e5e7eb") => (
    <div>
      <div
        style={{
          fontSize: 10,
          color: "#6b7280",
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, color, fontWeight: 700, fontFamily: "monospace" }}>
        {value}
      </div>
    </div>
  )

  return (
    <section
      aria-label="Fair market value"
      style={{
        marginBottom: 32,
        padding: 24,
        border: "1px solid #1f2937",
        borderRadius: 12,
        background: "linear-gradient(180deg, #0f1115 0%, #0a0a0a 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              letterSpacing: "0.12em",
              color: "#6b7280",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Fair Market Value
          </div>
          <div
            style={{
              fontSize: 48,
              fontWeight: 900,
              color: "#E03A2F",
              fontFamily: "'Barlow Condensed', sans-serif",
              letterSpacing: "0.01em",
              lineHeight: 1,
            }}
          >
            {fmtUsd(fmv.fmv_usd)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 10,
              color: "#6b7280",
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Confidence
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: confColor,
              letterSpacing: "0.06em",
              fontFamily: "monospace",
            }}
          >
            {conf || "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6b7280",
              marginTop: 4,
              fontFamily: "monospace",
            }}
          >
            updated {fmtRelative(fmv.computed_at)}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 16,
          paddingTop: 20,
          borderTop: "1px solid #1f2937",
        }}
      >
        {stat("Floor", fmtUsd(fmv.floor_price_usd))}
        {stat("WAP", fmtUsd(fmv.wap_usd))}
        {stat("Listings", fmv.listing_count?.toLocaleString() ?? "—")}
        {stat("Sales 7d", fmv.sales_count_7d?.toLocaleString() ?? "—")}
        {stat("Sales 30d", fmv.sales_count_30d?.toLocaleString() ?? "—")}
        <div>
          <div
            style={{
              fontSize: 10,
              color: "#6b7280",
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Liquidity
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>{dots}</div>
        </div>
      </div>
    </section>
  )
}

function MarketplaceBadge({ marketplace }: { marketplace: string | null }) {
  const m = (marketplace ?? "").toLowerCase()
  const label = m || "—"
  const color =
    m === "topshot" ? "#E03A2F" : m === "flowty" ? "#3b82f6" : "#9ca3af"
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        color,
        background: `${color}22`,
        border: `1px solid ${color}44`,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontFamily: "monospace",
      }}
    >
      {label}
    </span>
  )
}

function RecentSalesTable({ sales }: { sales: SaleRow[] }) {
  if (!sales || sales.length === 0) {
    return (
      <section style={{ marginBottom: 32 }}>
        <h2
          style={{
            fontSize: 14,
            letterSpacing: "0.12em",
            color: "#6b7280",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Recent Sales
        </h2>
        <div
          style={{
            padding: 24,
            border: "1px solid #1f2937",
            borderRadius: 12,
            color: "#6b7280",
            fontSize: 14,
          }}
        >
          No sales recorded yet.
        </div>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 14,
          letterSpacing: "0.12em",
          color: "#6b7280",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        Recent Sales ({sales.length})
      </h2>
      <div
        style={{
          border: "1px solid #1f2937",
          borderRadius: 12,
          overflow: "hidden",
          background: "#0a0a0a",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "70px 1fr 1fr 100px 110px",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid #1f2937",
            fontSize: 10,
            color: "#6b7280",
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            fontFamily: "monospace",
          }}
        >
          <div>Serial</div>
          <div>Price</div>
          <div>Sold</div>
          <div>Source</div>
          <div style={{ textAlign: "right" }}>Tx</div>
        </div>
        {sales.map((s, i) => (
          <div
            key={`${s.transaction_hash ?? i}-${s.serial_number ?? i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "70px 1fr 1fr 100px 110px",
              gap: 12,
              padding: "12px 16px",
              borderBottom:
                i < sales.length - 1 ? "1px solid #111827" : "none",
              fontSize: 13,
              alignItems: "center",
              fontFamily: "monospace",
            }}
          >
            <div style={{ color: "#9ca3af" }}>
              {s.serial_number != null ? `#${s.serial_number}` : "—"}
            </div>
            <div style={{ color: "#fff", fontWeight: 700 }}>
              {fmtUsd(s.price_usd)}
            </div>
            <div style={{ color: "#9ca3af" }} title={s.sold_at ?? undefined}>
              {fmtRelative(s.sold_at)}
            </div>
            <div>
              <MarketplaceBadge marketplace={s.marketplace} />
            </div>
            <div style={{ textAlign: "right" }}>
              {s.transaction_hash ? (
                <a
                  href={`https://www.flowscan.io/tx/${s.transaction_hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#60a5fa",
                    textDecoration: "none",
                    fontSize: 11,
                    letterSpacing: "0.04em",
                  }}
                >
                  {s.transaction_hash.slice(0, 8)}↗
                </a>
              ) : (
                <span style={{ color: "#374151" }}>—</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function SummaryBlock({ summary }: { summary: SalesSummary | null }) {
  if (!summary || (summary.count ?? 0) === 0) return null
  const stat = (label: string, value: string) => (
    <div
      style={{
        padding: 16,
        border: "1px solid #1f2937",
        borderRadius: 8,
        background: "#0a0a0a",
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "#6b7280",
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          color: "#fff",
          fontWeight: 700,
          fontFamily: "monospace",
        }}
      >
        {value}
      </div>
    </div>
  )

  return (
    <section style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 14,
          letterSpacing: "0.12em",
          color: "#6b7280",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        30-Day Activity
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
        }}
      >
        {stat("Volume", fmtCompact(summary.volume_usd))}
        {stat("Sales", (summary.count ?? 0).toLocaleString())}
        {stat("Avg", fmtUsd(summary.avg_price_usd))}
        {stat("Min", fmtUsd(summary.min_price_usd))}
        {stat("Max", fmtUsd(summary.max_price_usd))}
        {stat("Buyers", (summary.unique_buyers ?? 0).toLocaleString())}
        {stat("Sellers", (summary.unique_sellers ?? 0).toLocaleString())}
      </div>
    </section>
  )
}

function CrossRefs({ edition }: { edition: EditionRow }) {
  const links: { href: string; label: string; sub: string }[] = []
  if (edition.player_id) {
    links.push({
      href: `/player/${edition.player_id}`,
      label: edition.player_name ?? "View player",
      sub: "All editions for this player",
    })
  }
  if (edition.set_id) {
    links.push({
      href: `/set/${edition.set_id}`,
      label: edition.set_name ?? "View set",
      sub: "Set completion + bottlenecks",
    })
  }
  if (links.length === 0) return null
  return (
    <section style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 14,
          letterSpacing: "0.12em",
          color: "#6b7280",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        Related
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            style={{
              padding: 16,
              border: "1px solid #1f2937",
              borderRadius: 8,
              background: "#0a0a0a",
              textDecoration: "none",
              color: "#fff",
              display: "block",
              transition: "border-color 0.15s",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              {l.label} ↗
            </div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{l.sub}</div>
          </Link>
        ))}
      </div>
    </section>
  )
}

export default async function EditionPage(
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()
  const data = await loadEdition(id)
  if (!data) notFound()

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: "32px 20px 80px",
      }}
    >
      <ProductJsonLd data={data} />
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <HeroBlock data={data} />
        <FmvCard fmv={data.fmv} />
        <RecentSalesTable sales={data.recent_sales ?? []} />
        <SummaryBlock summary={data.sales_30d_summary} />
        <CrossRefs edition={data.edition} />
      </div>
    </div>
  )
}
