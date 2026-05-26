// app/(collections)/[collection]/pack/dist/[distId]/page.tsx
//
// Pack DISTRIBUTION (template) detail surface — server-rendered from cached
// EV snapshots (pack_table_rows ← pack_ev_latest ← pack_ev_history) plus
// the pack_drop_pool → editions → fmv join for the top-pulls table.
//
// This route describes a pack TEMPLATE (e.g. "Series 5 Common Pack"), not a
// specific minted pack instance. For an individual on-chain pack NFT (the
// lifecycle / rip view) see /[collection]/pack/[id]/page.tsx, which uses the
// get_pack_lifecycle RPC keyed on the pack NFT id.
//
// Top Shot and All Day reach this route today. PackTable routes its row
// click here via detailHref. Golazos packs surface was removed 2026-05-19
// — see lib/collections.ts pages array.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { PackThumb } from "@/components/packs/PackTable"
// tierChip moved to lib/tier-style.ts so this server component can call it;
// the version exported from PackTable.tsx ('use client') would throw at
// runtime — that's the bug this page was hitting before 2026-05-26.
import { tierChip } from "@/lib/tier-style"
import PackShareButton from "@/components/packs/PackShareButton"

export const revalidate = 600
export const dynamicParams = true

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

interface PackTableRow {
  dist_id: string
  collection_id: string
  collection_name: string
  collection_slug: string
  title: string | null
  image_url: string | null
  nft_type: string | null
  tier: string | null
  pack_type: string | null
  description: string | null
  retail_price_usd: string | number | null
  slots: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  depletion_pct: number | null
  pack_ev: string | number | null
  gross_ev: string | number | null
  ev_pack_price: string | number | null
  value_ratio: string | number | null
  is_positive_ev: boolean | null
  fmv_coverage_pct: number | null
  edition_count: number | null
  total_unopened: number | null
  ev_depletion_pct: number | null
  ev_snapshotted_at: string | null
  ev_margin_pct: string | number | null
  is_rare_single_pack: boolean | null
  // Dual-price model (May 2026) — see /api/pack-ev for derivation rules.
  primary_price: string | number | null
  secondary_ask: string | number | null
  price_source: "primary" | "secondary" | "min" | "none" | null
  primary_available: boolean | null
  secondary_available: boolean | null
}

interface DistFallbackRow {
  metadata: Record<string, unknown> | null
  image_url: string | null
  title: string | null
}

interface DropPoolRow {
  edition_id: string
  drop_weight: string | number | null
}

interface EditionLite {
  id: string
  name: string | null
  tier: string | null
  external_id: string | null
}

interface FmvRow {
  edition_id: string
  fmv_usd: string | number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

async function fetchPackRow(collectionId: string, distId: string): Promise<PackTableRow | null> {
  const { data, error } = await sb
    .from("pack_table_rows")
    .select("*")
    .eq("collection_id", collectionId)
    .eq("dist_id", distId)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_table_rows error", error.message)
    return null
  }
  return (data as PackTableRow | null) ?? null
}

async function fetchDistFallback(collectionId: string, distId: string): Promise<DistFallbackRow | null> {
  const { data, error } = await sb
    .from("pack_distributions")
    .select("metadata, image_url, title")
    .eq("collection_id", collectionId)
    .eq("dist_id", distId)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_distributions error", error.message)
    return null
  }
  return (data as DistFallbackRow | null) ?? null
}

interface TopPull {
  editionId: string
  player: string
  setName: string
  tier: string | null
  dropWeight: number
  probabilityPct: number | null
  fmvUsd: number | null
  editionEv: number | null
  externalId: string | null
}

async function fetchTopPulls(
  collectionId: string,
  distId: string,
  totalUnopened: number | null,
  slots: number | null,
): Promise<TopPull[]> {
  const { data: poolRows, error: poolErr } = await sb
    .from("pack_drop_pool")
    .select("edition_id, drop_weight")
    .eq("dist_id", distId)
    .eq("collection_id", collectionId)
    .gt("drop_weight", 0)
    .order("drop_weight", { ascending: false })
    .limit(50)
  if (poolErr) {
    console.error("[pack-detail] pack_drop_pool error", poolErr.message)
    return []
  }
  const pool = (poolRows ?? []) as DropPoolRow[]
  if (pool.length === 0) return []

  const editionIds = pool.map((r) => r.edition_id)

  // Full-pool weight sum for the probability denominator. `pool` is the top-50
  // by drop_weight, so summing only its rows over-states the probability of
  // each pull (Pack audit B2). Fall back to that partial sum only as a last
  // resort, and surface probability as null when we can't compute the real
  // denominator.
  const [editionsRes, fmvRes, fullPoolWeightRes] = await Promise.all([
    sb.from("editions").select("id, name, tier, external_id").in("id", editionIds),
    sb.rpc("get_fmv_for_editions", {
      p_collection_id: collectionId,
      p_edition_ids: editionIds,
    }),
    sb.rpc("query_sql", {
      query: `
        SELECT COALESCE(SUM(drop_weight), 0)::numeric AS total_weight
        FROM pack_drop_pool
        WHERE dist_id = '${distId.replace(/'/g, "''")}'
          AND collection_id = '${collectionId.replace(/'/g, "''")}'
          AND drop_weight > 0
      `,
    }),
  ])

  if (editionsRes.error) console.error("[pack-detail] editions error", editionsRes.error.message)
  if (fmvRes.error) console.error("[pack-detail] fmv rpc error", fmvRes.error.message)
  if (fullPoolWeightRes.error) console.error("[pack-detail] full pool weight error", fullPoolWeightRes.error.message)

  const editionsById = new Map<string, EditionLite>()
  for (const e of (editionsRes.data ?? []) as EditionLite[]) editionsById.set(e.id, e)

  const fmvById = new Map<string, number>()
  for (const r of (fmvRes.data ?? []) as FmvRow[]) {
    const v = r.fmv_usd == null ? null : Number(r.fmv_usd)
    if (v !== null && Number.isFinite(v) && v > 0) fmvById.set(r.edition_id, v)
  }

  // Probability denominator: prefer cached total_unopened (true contents
  // remaining); otherwise use the full-pool drop_weight sum we just fetched.
  // Never fall back to summing only the top-50 weights — that inflates % (B2).
  const fullPoolWeight = Number(
    (fullPoolWeightRes.data as Array<{ total_weight: number | string }> | null)?.[0]?.total_weight ?? 0,
  )
  const denom = totalUnopened && totalUnopened > 0
    ? totalUnopened
    : fullPoolWeight > 0
      ? fullPoolWeight
      : null

  // Edition EV = the edition's contribution to one pack's gross EV.
  //   EV = FMV × (drop_weight / pool_weight) × slots
  // This reconciles with the cached pack_ev_history Gross EV KPI, which is
  // slots × Σ(per-edition probability × FMV) over the full pool. Pack D3:
  // earlier this column was raw fmv × drop_weight, a third EV methodology
  // that wouldn't sum to Gross EV at any pool size.
  const pulls: TopPull[] = pool.map((r) => {
    const ed = editionsById.get(r.edition_id)
    const dropWeight = Number(r.drop_weight ?? 0)
    const fmv = fmvById.get(r.edition_id) ?? null
    const probPct = denom ? (dropWeight / denom) * 100 : null
    const ev = fmv !== null && denom && denom > 0 && slots && slots > 0
      ? fmv * (dropWeight / denom) * slots
      : null
    const { player, setName } = splitEditionName(ed?.name ?? null)
    return {
      editionId: r.edition_id,
      player,
      setName,
      tier: ed?.tier ?? null,
      dropWeight,
      probabilityPct: probPct,
      fmvUsd: fmv,
      editionEv: ev,
      externalId: ed?.external_id ?? null,
    }
  })

  pulls.sort((a, b) => {
    const ae = a.editionEv == null ? -Infinity : a.editionEv
    const be = b.editionEv == null ? -Infinity : b.editionEv
    if (ae !== be) return be - ae
    return b.dropWeight - a.dropWeight
  })

  return pulls.slice(0, 10)
}

// editions.name is "Player Name — Set Name" (em-dash). Some rows are NULL.
// Fall back gracefully so the table doesn't render literal "null —" cells.
function splitEditionName(name: string | null): { player: string; setName: string } {
  if (!name) return { player: "Unknown", setName: "" }
  const idx = name.indexOf("—")
  if (idx === -1) return { player: name.trim(), setName: "" }
  return { player: name.slice(0, idx).trim() || "Unknown", setName: name.slice(idx + 1).trim() }
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString()}`
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return `${v.toFixed(1)}%`
}

function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return v.toLocaleString()
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; distId: string }> },
): Promise<Metadata> {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const row = await fetchPackRow(coll.id, distId)
  const fb = row ? null : await fetchDistFallback(coll.id, distId)
  const title = row?.title ?? fb?.title ?? "Pack"
  if (!row && !fb) return {}
  const tierLabel = row?.tier ? String(row.tier).charAt(0).toUpperCase() + String(row.tier).slice(1) : ""
  const metaTitle = `${title}${tierLabel ? ` — ${tierLabel}` : ""} | ${coll.displayName} | Rip Packs City`
  const grossEv = num(row?.gross_ev ?? null)
  const price = num(row?.retail_price_usd ?? null)
  const ratio = num(row?.value_ratio ?? null)
  const descParts = [
    `${title} on ${coll.displayName}.`,
    price !== null ? `Retail ${fmtUsd(price)}.` : null,
    grossEv !== null ? `Gross EV ${fmtUsd(grossEv)}.` : null,
    ratio !== null ? `Value ratio ${ratio.toFixed(2)}x.` : null,
    "Pack EV, top pulls, and depletion based on Rip Packs City's cached snapshot.",
  ].filter(Boolean) as string[]
  const canonical = `${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`
  const ogImage = `${BASE_URL}/api/og/pack?distId=${encodeURIComponent(distId)}&collection=${encodeURIComponent(collection)}`
  return {
    title: metaTitle,
    description: descParts.join(" "),
    alternates: { canonical },
    openGraph: {
      title: metaTitle,
      description: descParts.join(" "),
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title: metaTitle,
      description: descParts.join(" "),
      images: [ogImage],
    },
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PackDetailPage(
  props: { params: Promise<{ collection: string; distId: string }> },
) {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const row = await fetchPackRow(coll.id, distId)
  const fallback = row ? null : await fetchDistFallback(coll.id, distId)
  if (!row && !fallback) notFound()

  // When pack_table_rows misses (newly minted dist the cron hasn't picked up),
  // synthesize a minimal shape from pack_distributions. EV / depletion will
  // render as em-dash but the page still resolves with a hero + buy link.
  const merged: PackTableRow = row ?? {
    dist_id: distId,
    collection_id: coll.id,
    collection_name: coll.displayName,
    collection_slug: collection,
    title: fallback?.title ?? null,
    image_url: fallback?.image_url ?? null,
    nft_type: null,
    tier: typeof fallback?.metadata?.tier === "string" ? (fallback.metadata.tier as string) : null,
    pack_type: typeof fallback?.metadata?.pack_type === "string" ? (fallback.metadata.pack_type as string) : null,
    description: null,
    retail_price_usd:
      typeof fallback?.metadata?.retail_price_usd === "number"
        ? (fallback.metadata.retail_price_usd as number)
        : typeof fallback?.metadata?.retail_price_usd === "string"
          ? (fallback.metadata.retail_price_usd as string)
          : null,
    slots:
      typeof fallback?.metadata?.number_of_pack_slots === "number"
        ? (fallback.metadata.number_of_pack_slots as number)
        : typeof fallback?.metadata?.number_of_pack_slots === "string"
          ? Number(fallback.metadata.number_of_pack_slots)
          : null,
    total_minted: null,
    total_opened: null,
    total_sealed: null,
    depletion_pct: null,
    pack_ev: null,
    gross_ev: null,
    ev_pack_price: null,
    value_ratio: null,
    is_positive_ev: null,
    fmv_coverage_pct: null,
    edition_count: null,
    total_unopened: null,
    ev_depletion_pct: null,
    ev_snapshotted_at: null,
    ev_margin_pct: null,
    is_rare_single_pack: null,
    primary_price: null,
    secondary_ask: null,
    price_source: null,
    primary_available: null,
    secondary_available: null,
  }

  const distMetadata = fallback?.metadata ?? (await fetchDistFallback(coll.id, distId))?.metadata ?? null

  const topPulls = await fetchTopPulls(coll.id, distId, num(merged.total_unopened), merged.slots ?? null)

  // Defensive: pack_table_rows.tier is typed string|null but coerce in case
  // the view ever returns a non-string. Same for title.
  const tier = String(merged.tier ?? "common").toLowerCase()
  const chip = tierChip(tier)
  const tierAccent = chip.color
  const title = String(merged.title ?? "Pack")
  const grossEv = num(merged.gross_ev)
  const packEv = num(merged.pack_ev)
  const valueRatio = num(merged.value_ratio)
  const evMargin = num(merged.ev_margin_pct)
  const fmvCoverage = merged.fmv_coverage_pct
  const depletion = merged.depletion_pct
  const totalUnopened = num(merged.total_unopened)
  const totalSealed = num(merged.total_sealed)
  const totalMinted = num(merged.total_minted)
  const editionCount = num(merged.edition_count)
  const retailPrice = num(merged.retail_price_usd)
  const evPackPrice = num(merged.ev_pack_price)
  const primaryPrice = num(merged.primary_price)
  const secondaryAsk = num(merged.secondary_ask)
  const priceSource = merged.price_source ?? null
  const primaryAvailable = merged.primary_available === true
  const secondaryAvailable = merged.secondary_available === true
  // EV anchor: prefer the dual-price packPrice when the EV cron has filled in
  // the new columns; fall back to the cached ev_pack_price, then retail.
  const livePrice =
    priceSource === "primary" ? primaryPrice
    : priceSource === "secondary" ? secondaryAsk
    : priceSource === "min" ? primaryPrice
    : evPackPrice ?? retailPrice
  const isPositive = merged.is_positive_ev === true
  const snapshottedAt = merged.ev_snapshotted_at
  // Reward / quest packs ship with retail_price_usd = 0 (Pack D1). Value-ratio
  // and EV-margin verdicts divide by retail, so they produce garbage on free
  // packs — gate them off and surface a "Reward pack" badge instead.
  const isRewardPack = retailPrice === 0
  const showPriceVerdict = !isRewardPack && priceSource !== "none"

  // One-line summary above the KPI grid. Names the EV anchor explicitly so
  // the user knows whether the verdict is computed against retail or P2P ask.
  // priceSource = 'none' suppresses the verdict entirely.
  const evAnchorSummary: string | null = (() => {
    if (isRewardPack) return "Reward pack — distributed for free, no price-based verdict."
    if (priceSource === "none") return "Pack not currently available for purchase"
    if (priceSource === "primary" && primaryPrice != null) {
      return `EV computed against [PRIMARY: ${fmtUsd(primaryPrice)}] — primary listing is the cheapest path to acquire this pack right now.`
    }
    if (priceSource === "secondary" && secondaryAsk != null) {
      return `EV computed against [SECONDARY: ${fmtUsd(secondaryAsk)}] — cheapest path to acquire this pack right now.`
    }
    if (priceSource === "min" && primaryPrice != null && secondaryAsk != null) {
      return `Primary (${fmtUsd(primaryPrice)}) and secondary (${fmtUsd(secondaryAsk)}) are within 1% — both are valid EV anchors.`
    }
    return null
  })()

  const packListingUuid = typeof distMetadata?.uuid === "string" ? distMetadata.uuid : null
  // Pack audit S2: suppress the buy CTA when the EV cron has determined the
  // pack isn't currently for sale (price_source = "none"); also gate on the
  // reward-pack flag so we don't tell users to "buy" a free reward pack.
  const buyUrl = collection === "nba-top-shot" && packListingUuid && !isRewardPack && priceSource !== "none"
    ? `https://nbatopshot.com/listings/p2p?packListingId=${packListingUuid}`
    : null
  const buyCtaLabel = priceSource === "primary" || priceSource === "min"
    ? "Buy primary"
    : priceSource === "secondary"
      ? "Buy on secondary market"
      : "Buy on Top Shot"

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)
  const packTypeLabel = String(merged.pack_type ?? "").trim()
  const slotsLabel = merged.slots && merged.slots > 0
    ? `${merged.slots} slot${merged.slots === 1 ? "" : "s"}`
    : (packTypeLabel || "—")

  const cardStyle: React.CSSProperties = {
    background: "rgba(13,13,13,0.92)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: 18,
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,260px) 1fr", gap: 24, alignItems: "start" }}>
          <div
            style={{
              width: 260,
              height: 260,
              borderRadius: 6,
              overflow: "hidden",
              background: "rgba(0,0,0,0.4)",
              border: `1px solid ${tierAccent}33`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <PackThumb url={merged.image_url} tier={tier} title={title} size={260} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  color: "rgba(255,255,255,0.4)",
                  textTransform: "uppercase",
                }}
              >
                {coll.displayName} · Pack #{distId}
              </span>
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontWeight: 900,
                fontSize: 32,
                letterSpacing: "0.04em",
                color: "#fff",
                lineHeight: 1.05,
                textTransform: "uppercase",
              }}
            >
              {title}
            </h1>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  color: chip.color,
                  background: chip.background,
                  border: chip.border,
                }}
              >
                {tierLabel}
              </span>
              {packTypeLabel && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgba(255,255,255,0.7)",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    textTransform: "capitalize",
                  }}
                >
                  {packTypeLabel}
                </span>
              )}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "rgba(255,255,255,0.55)",
                }}
              >
                {slotsLabel}
              </span>
              {isPositive && grossEv !== null && showPriceVerdict && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(110,231,183)",
                    background: "rgba(16,185,129,0.12)",
                    border: "1px solid rgba(16,185,129,0.4)",
                  }}
                >
                  +EV
                </span>
              )}
              {isRewardPack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(125,211,252)",
                    background: "rgba(14,165,233,0.10)",
                    border: "1px solid rgba(14,165,233,0.40)",
                  }}
                  title="Distributed for free (retail price $0)."
                >
                  Reward pack
                </span>
              )}
              {merged.is_rare_single_pack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgb(252,211,77)",
                    background: "rgba(234,179,8,0.10)",
                    border: "1px solid rgba(234,179,8,0.40)",
                  }}
                  title="EV represents one specific ultra-rare moment rather than a probabilistic pull."
                >
                  Single rare edition
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
              {buyUrl ? (
                <a
                  href={buyUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "8px 16px",
                    background: "var(--rpc-red)",
                    color: "#fff",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    textDecoration: "none",
                  }}
                >
                  {buyCtaLabel}
                </a>
              ) : null}
              <PackShareButton url={`${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`} />
              <Link
                href={`/${collection}/packs`}
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  background: "transparent",
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.2)",
                  textDecoration: "none",
                }}
              >
                ← All packs
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── EV anchor summary ────────────────────────────────────────────── */}
      {evAnchorSummary && (
        <section
          style={{
            background: "rgba(13,13,13,0.92)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: "10px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: isRewardPack || priceSource === "none" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.75)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {showPriceVerdict && (
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--rpc-red)",
                flexShrink: 0,
                display: "inline-block",
              }}
            />
          )}
          <span>{evAnchorSummary}</span>
        </section>
      )}

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <DualPriceKpi
          primaryPrice={primaryPrice}
          secondaryAsk={secondaryAsk}
          priceSource={priceSource}
          primaryAvailable={primaryAvailable}
          secondaryAvailable={secondaryAvailable}
          fallbackPrice={livePrice}
          retailPrice={retailPrice}
        />
        <KpiCell
          label="Gross EV"
          value={fmtUsd(grossEv)}
          sub={isRewardPack ? "Reward pack — net vs $0 retail not meaningful" : priceSource === "none" ? "No anchor — verdict suppressed" : packEv !== null ? `Net ${packEv >= 0 ? "+" : ""}${fmtUsd(Math.abs(packEv))}` : undefined}
          color={!showPriceVerdict || packEv === null ? undefined : packEv >= 0 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="Value ratio"
          value={!showPriceVerdict || valueRatio === null ? "—" : `${valueRatio.toFixed(2)}x`}
          sub={isRewardPack ? "Free pack — n/a" : priceSource === "none" || evMargin === null ? undefined : `${fmtPct(evMargin)} margin`}
          color={!showPriceVerdict || valueRatio === null ? undefined : valueRatio >= 1 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="FMV coverage"
          value={fmvCoverage === null ? "—" : `${fmvCoverage}%`}
          sub={editionCount === null ? undefined : `${editionCount} editions`}
        />
        <KpiCell
          label="Depletion"
          value={depletion === null ? "—" : `${depletion}%`}
          sub={merged.ev_depletion_pct === null ? undefined : `Pool ${merged.ev_depletion_pct}%`}
        />
        <KpiCell
          label="Packs remaining"
          value={fmtCount(totalUnopened)}
          sub={totalSealed !== null && totalMinted !== null ? `${fmtCount(totalSealed)}/${fmtCount(totalMinted)} sealed` : undefined}
        />
      </section>

      {/* ── Top pulls ────────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 18,
              letterSpacing: "0.06em",
              color: "#fff",
              textTransform: "uppercase",
            }}
          >
            Top pulls by EV
          </h2>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {topPulls.length === 0 ? "computing pack contents…" : `top ${topPulls.length} of ${editionCount ?? "?"}`}
          </span>
        </div>
        {topPulls.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              border: "1px dashed rgba(255,255,255,0.1)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.4)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            No drop-pool data indexed for this distribution yet. Check back after the next pack-EV cron tick.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <Th>Player</Th>
                  <Th>Set</Th>
                  <Th>Tier</Th>
                  <Th align="right">Drop %</Th>
                  <Th align="right">FMV</Th>
                  <Th align="right">Edition EV</Th>
                </tr>
              </thead>
              <tbody>
                {topPulls.map((p) => (
                  <tr key={p.editionId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <Td>
                      {p.externalId ? (
                        <Link href={`/${collection}/edition/${encodeURIComponent(p.externalId)}`} style={{ color: "#fff", textDecoration: "none" }}>
                          {p.player}
                        </Link>
                      ) : (
                        <span style={{ color: "#fff" }}>{p.player}</span>
                      )}
                    </Td>
                    <Td color="rgba(255,255,255,0.6)">{p.setName || "—"}</Td>
                    <Td color={p.tier ? tierChip(String(p.tier)).color : undefined}>{p.tier ? String(p.tier).charAt(0).toUpperCase() + String(p.tier).slice(1) : "—"}</Td>
                    <Td align="right">{p.probabilityPct === null ? "—" : `${p.probabilityPct.toFixed(2)}%`}</Td>
                    <Td align="right">{fmtUsd(p.fmvUsd)}</Td>
                    <Td align="right" color={p.editionEv !== null && p.editionEv > 0 ? "rgb(110,231,183)" : undefined}>
                      {fmtUsd(p.editionEv)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          Edition EV = FMV × (drop_weight / pool_weight) × slots. Sums to Gross EV over the full pool. Snapshotted{" "}
          {snapshottedAt ? new Date(snapshottedAt).toLocaleString() : "—"}. Methodology: cached pack_ev_history via the
          compute-pack-ev edge function.
        </div>
      </section>
    </div>
  )
}

// ── Tiny presentational helpers ────────────────────────────────────────────

function KpiCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 22,
          letterSpacing: "0.02em",
          color: color ?? "#fff",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function DualPriceKpi({
  primaryPrice,
  secondaryAsk,
  priceSource,
  primaryAvailable,
  secondaryAvailable,
  fallbackPrice,
  retailPrice,
}: {
  primaryPrice: number | null
  secondaryAsk: number | null
  priceSource: "primary" | "secondary" | "min" | "none" | null
  primaryAvailable: boolean
  secondaryAvailable: boolean
  fallbackPrice: number | null
  retailPrice: number | null
}) {
  // Legacy fallback: when the EV cron hasn't populated the new columns,
  // render the single-line "Pack price" KPI as before.
  if (priceSource === null) {
    return (
      <KpiCell
        label="Pack price"
        value={fmtUsd(fallbackPrice)}
        sub={retailPrice !== null && fallbackPrice !== null && retailPrice !== fallbackPrice ? `Retail ${fmtUsd(retailPrice)}` : undefined}
      />
    )
  }

  const primaryLive = primaryAvailable && primaryPrice != null && primaryPrice > 0
  const secondaryLive = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
  const primaryAnchor = priceSource === "primary" || priceSource === "min"
  const secondaryAnchor = priceSource === "secondary" || priceSource === "min"

  const Row = ({
    label,
    value,
    anchor,
    muted,
  }: {
    label: string
    value: string
    anchor: boolean
    muted: boolean
  }) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.25 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          minWidth: 64,
          display: "inline-block",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: anchor ? 800 : 600,
          fontSize: 18,
          letterSpacing: "0.02em",
          fontVariantNumeric: "tabular-nums",
          color: anchor ? "var(--rpc-red)" : muted ? "rgba(255,255,255,0.45)" : "#fff",
        }}
      >
        {value}
      </span>
      {anchor && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--rpc-red)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
      )}
    </div>
  )

  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          marginBottom: 6,
        }}
      >
        Pack price
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Row
          label="Primary"
          value={primaryLive ? fmtUsd(primaryPrice) : "SOLD OUT"}
          anchor={primaryAnchor && primaryLive}
          muted={!primaryLive}
        />
        <Row
          label="Secondary"
          value={secondaryLive ? fmtUsd(secondaryAsk) : "—"}
          anchor={secondaryAnchor && secondaryLive}
          muted={!secondaryLive}
        />
      </div>
    </div>
  )
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 10px",
        fontSize: 9,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.45)",
        fontWeight: 700,
      }}
    >
      {children}
    </th>
  )
}

function Td({ children, align = "left", color }: { children: React.ReactNode; align?: "left" | "right"; color?: string }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "8px 10px",
        color: color ?? "rgba(255,255,255,0.85)",
      }}
    >
      {children}
    </td>
  )
}
