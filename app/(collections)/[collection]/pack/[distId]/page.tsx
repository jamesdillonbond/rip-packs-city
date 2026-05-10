// app/(collections)/[collection]/pack/[distId]/page.tsx
//
// Pack detail surface — server-rendered from cached EV snapshots
// (pack_table_rows ← pack_ev_latest ← pack_ev_history) plus the
// pack_drop_pool → editions → fmv join for the top-pulls table.
//
// All three pack-eligible collections (Top Shot, All Day, Golazos) reach
// this route. PackTable already routes its row click here via detailHref.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { PackThumb, tierChip } from "@/components/packs/PackTable"
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

  const [editionsRes, fmvRes] = await Promise.all([
    sb.from("editions").select("id, name, tier, external_id").in("id", editionIds),
    sb.rpc("get_fmv_for_editions", {
      p_collection_id: collectionId,
      p_edition_ids: editionIds,
    }),
  ])

  if (editionsRes.error) console.error("[pack-detail] editions error", editionsRes.error.message)
  if (fmvRes.error) console.error("[pack-detail] fmv rpc error", fmvRes.error.message)

  const editionsById = new Map<string, EditionLite>()
  for (const e of (editionsRes.data ?? []) as EditionLite[]) editionsById.set(e.id, e)

  const fmvById = new Map<string, number>()
  for (const r of (fmvRes.data ?? []) as FmvRow[]) {
    const v = r.fmv_usd == null ? null : Number(r.fmv_usd)
    if (v !== null && Number.isFinite(v) && v > 0) fmvById.set(r.edition_id, v)
  }

  // Probability denominator: prefer cached total_unopened (true contents
  // remaining); fall back to summing drop_weight when the cron hasn't
  // populated total_unopened yet (newly indexed distributions).
  const totalWeight = pool.reduce((sum, r) => sum + Number(r.drop_weight ?? 0), 0)
  const denom = totalUnopened && totalUnopened > 0 ? totalUnopened : totalWeight > 0 ? totalWeight : null

  const pulls: TopPull[] = pool.map((r) => {
    const ed = editionsById.get(r.edition_id)
    const dropWeight = Number(r.drop_weight ?? 0)
    const fmv = fmvById.get(r.edition_id) ?? null
    const ev = fmv === null ? null : fmv * dropWeight
    const probPct = denom ? (dropWeight / denom) * 100 : null
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
  const tierLabel = row?.tier ? row.tier.charAt(0).toUpperCase() + row.tier.slice(1) : ""
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
  const canonical = `${BASE_URL}/${collection}/pack/${encodeURIComponent(distId)}`
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
  }

  const distMetadata = fallback?.metadata ?? (await fetchDistFallback(coll.id, distId))?.metadata ?? null

  const topPulls = await fetchTopPulls(coll.id, distId, num(merged.total_unopened))

  const tier = (merged.tier ?? "common").toLowerCase()
  const chip = tierChip(tier)
  const tierAccent = chip.color
  const title = merged.title ?? "Pack"
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
  const livePrice = evPackPrice ?? retailPrice
  const isPositive = merged.is_positive_ev === true
  const snapshottedAt = merged.ev_snapshotted_at

  const packListingUuid = typeof distMetadata?.uuid === "string" ? distMetadata.uuid : null
  const buyUrl = collection === "nba-top-shot" && packListingUuid
    ? `https://nbatopshot.com/listings/p2p?packListingId=${packListingUuid}`
    : null

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)
  const packTypeLabel = (merged.pack_type ?? "").trim()
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
                  fontFamily: "'Share Tech Mono', monospace",
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
                fontFamily: "'Barlow Condensed', sans-serif",
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
                  fontFamily: "'Share Tech Mono', monospace",
                  fontSize: 11,
                  color: "rgba(255,255,255,0.55)",
                }}
              >
                {slotsLabel}
              </span>
              {isPositive && grossEv !== null && (
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
                    background: "#E03A2F",
                    color: "#fff",
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    textDecoration: "none",
                  }}
                >
                  Buy on Top Shot
                </a>
              ) : null}
              <PackShareButton url={`${BASE_URL}/${collection}/pack/${encodeURIComponent(distId)}`} />
              <Link
                href={`/${collection}/packs`}
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  background: "transparent",
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "'Barlow Condensed', sans-serif",
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

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <KpiCell
          label="Pack price"
          value={fmtUsd(livePrice)}
          sub={evPackPrice !== null && retailPrice !== null && retailPrice !== evPackPrice ? `Retail ${fmtUsd(retailPrice)}` : undefined}
        />
        <KpiCell
          label="Gross EV"
          value={fmtUsd(grossEv)}
          sub={packEv !== null ? `Net ${packEv >= 0 ? "+" : ""}${fmtUsd(Math.abs(packEv))}` : undefined}
          color={packEv === null ? undefined : packEv >= 0 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="Value ratio"
          value={valueRatio === null ? "—" : `${valueRatio.toFixed(2)}x`}
          sub={evMargin === null ? undefined : `${fmtPct(evMargin)} margin`}
          color={valueRatio === null ? undefined : valueRatio >= 1 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
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
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 800,
              fontSize: 18,
              letterSpacing: "0.06em",
              color: "#fff",
              textTransform: "uppercase",
            }}
          >
            Top pulls by EV
          </h2>
          <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
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
              fontFamily: "'Share Tech Mono', monospace",
              fontSize: 11,
            }}
          >
            No drop-pool data indexed for this distribution yet. Check back after the next pack-EV cron tick.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }}>
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
                    <Td color={p.tier ? tierChip(p.tier).color : undefined}>{p.tier ? p.tier.charAt(0).toUpperCase() + p.tier.slice(1) : "—"}</Td>
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
        <div style={{ marginTop: 10, fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          EV = Σ(drop_weight × FMV) over the indexed drop pool. Snapshotted{" "}
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
          fontFamily: "'Share Tech Mono', monospace",
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
          fontFamily: "'Barlow Condensed', sans-serif",
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
            fontFamily: "'Share Tech Mono', monospace",
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
