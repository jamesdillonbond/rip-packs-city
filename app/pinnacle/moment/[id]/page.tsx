// app/pinnacle/moment/[id]/page.tsx
//
// Public per-PIN Pinnacle detail page. Server-rendered. Sister surface to
// /moment/[id] but scoped to Pinnacle (its own pinnacle_catalog, separate from
// the shared editions table the Top Shot / AllDay / Golazos / UFC route uses).
//
// Wave 1b (PIN-FMV-REKEY) re-keyed this onto the render spine:
//   [id] = render_id (e.g. OEV1-SWHM-KYLO-S5)  → the per-pin detail page,
//      reading pinnacle_catalog (identity + per-render fmv_* + floor_ask + art)
//      + pinnacle_sales (history, by render_id) + wmc (tracked holders).
//   [id] = legacy edition_key (e.g. STAR-OEV1-SWHM:Digital Display:1, contains
//      ':') → a DISAMBIGUATION page listing every render that shared that
//      set-level key (old links + any stray references stay honest instead of
//      silently showing one arbitrary character's price).
//
// Reached from /insights/pinnacle-scarcity row links (now render-keyed) and the
// sitemap. 404s gracefully when neither a render nor a legacy key matches.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

// render_id never contains ':'; the legacy set-level key (royalty:variant:printing)
// always does. That's the discriminator between the two URL shapes.
function isLegacyKey(id: string): boolean {
  return id.includes(":")
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

type CatalogRow = {
  render_id: string
  edition_id: string | null
  character_name: string | null
  set_name: string | null
  franchises: string[] | null
  variant: string | null
  parallel_type: string | null
  printing: number | null
  total_minted: number | null
  edition_type: string | null
  limited_edition: boolean | null
  series_name: string | null
  is_chaser: boolean | null
  color: string | null
  effects: string | null
  materials: string | null
  size: string | null
  thickness: string | null
  thumbnail_url: string | null
  fmv_usd: number | null
  fmv_wap_usd: number | null
  fmv_confidence: string | null
  fmv_sales_count_30d: number | null
  fmv_days_since_sale: number | null
  fmv_computed_at: string | null
  floor_ask: number | null
}

type SaleRow = {
  sale_price_usd: number | null
  sold_at: string | null
  serial_number: number | null
}

// A sibling printing of the SAME pin (same shape_render_id) — a different variant
// (Standard / Golden / Digital Display / …) or printing. Each is its own render
// with its own circulation + per-render FMV, and links to its own render page.
type SiblingRow = {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  printing: number | null
  total_minted: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  fmv_confidence: string | null
  floor_ask: number | null
  is_self: boolean
}

type RenderData = {
  kind: "render"
  ed: CatalogRow
  sales: SaleRow[]
  holders: number
  variant_avg_mint: number | null
  scarcity_pct: number | null
  siblings: SiblingRow[]
}

type LegacyRender = {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  total_minted: number | null
  fmv_usd: number | null
  thumbnail_url: string | null
}

type LegacyData = { kind: "legacy"; key: string; renders: LegacyRender[] }

const CATALOG_COLS =
  "render_id, edition_id, character_name, set_name, franchises, variant, parallel_type, printing, total_minted, edition_type, limited_edition, series_name, is_chaser, color, effects, materials, size, thickness, thumbnail_url, fmv_usd, fmv_wap_usd, fmv_confidence, fmv_sales_count_30d, fmv_days_since_sale, fmv_computed_at, floor_ask"

// A render_id (OEV1-WINN-GOPH-S3) is the canonical key, but the page is also
// reached with two other legitimate numeric id shapes that must resolve, not
// 404: the catalog edition_id (3-digit, e.g. 2156 — links from older catalog
// references) and the on-chain moment NFT id (~15-digit, e.g. 111050675472028 —
// links from a held pin / wallet surface). Both map 1:1 to a render_id, so we
// redirect them onto the canonical render before loading. wmc has 100% render_id
// coverage for Pinnacle, so any held pin resolves.
async function resolveNumericToRenderId(supa: any, id: string): Promise<string | null> {
  if (!/^\d+$/.test(id)) return null
  // edition_id is the smaller (3-digit) space; check it first.
  const { data: byEdition } = await supa
    .from("pinnacle_catalog")
    .select("render_id")
    .eq("edition_id", id)
    .maybeSingle()
  if (byEdition?.render_id) return byEdition.render_id as string
  // Otherwise treat it as an on-chain moment NFT id.
  const { data: byMoment } = await supa
    .from("wallet_moments_cache")
    .select("render_id")
    .eq("collection_id", PINNACLE_COLLECTION_ID)
    .eq("moment_id", id)
    .not("render_id", "is", null)
    .limit(1)
    .maybeSingle()
  return (byMoment?.render_id as string) ?? null
}

async function load(rawId: string): Promise<RenderData | LegacyData | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supa = supabaseAdmin as any
  const id = decodeId(rawId)

  if (isLegacyKey(id)) {
    const { data } = await supa
      .from("pinnacle_catalog")
      .select("render_id, character_name, set_name, variant, total_minted, fmv_usd, thumbnail_url")
      .eq("legacy_edition_key", id)
      .order("fmv_usd", { ascending: false, nullsFirst: false })
    const renders = (data ?? []) as LegacyRender[]
    if (renders.length === 0) return null
    return { kind: "legacy", key: id, renders }
  }

  let { data: ed } = await supa
    .from("pinnacle_catalog")
    .select(CATALOG_COLS)
    .eq("render_id", id)
    .maybeSingle()
  // Numeric id (edition_id or moment NFT id) → redirect onto its render_id.
  if (!ed) {
    const resolved = await resolveNumericToRenderId(supa, id)
    if (resolved) {
      ;({ data: ed } = await supa
        .from("pinnacle_catalog")
        .select(CATALOG_COLS)
        .eq("render_id", resolved)
        .maybeSingle())
    }
  }
  if (!ed) return null
  // Canonical render_id — may differ from the incoming id when it arrived as a
  // numeric edition_id / moment NFT id and was redirected above.
  const renderId = ed.render_id as string

  // Sales history (per render) + tracked holders + variant scarcity. The
  // scarcity board already computes the per-variant average, so reuse it
  // rather than re-aggregating the catalog (and tripping the 1000-row cap on
  // big variant families).
  const [salesRes, holdersRes, boardRes, siblingsRes] = await Promise.all([
    supa
      .from("pinnacle_sales")
      .select("sale_price_usd, sold_at, serial_number")
      .eq("render_id", renderId)
      .order("sold_at", { ascending: false, nullsFirst: false })
      .limit(25),
    supa
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .eq("render_id", renderId),
    supa
      .from("pinnacle_scarcity_board")
      .select("variant_avg_mint, scarcity_vs_variant_pct")
      .eq("render_id", renderId)
      .maybeSingle(),
    // Other printings of THIS pin (same shape_render_id) — the parallel ladder.
    supa.rpc("get_pinnacle_variant_siblings", { p_render_id: renderId }),
  ])

  const siblings = Array.isArray(siblingsRes.data) ? (siblingsRes.data as SiblingRow[]) : []

  return {
    kind: "render",
    ed: ed as CatalogRow,
    sales: (salesRes.data ?? []) as SaleRow[],
    holders: Number(holdersRes.count ?? 0),
    variant_avg_mint: boardRes.data?.variant_avg_mint != null ? Number(boardRes.data.variant_avg_mint) : null,
    scarcity_pct: boardRes.data?.scarcity_vs_variant_pct != null ? Number(boardRes.data.scarcity_vs_variant_pct) : null,
    siblings,
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const data = await load(id)
  if (!data) return { title: "Pinnacle edition — Rip Packs City" }

  if (data.kind === "legacy") {
    const title = `${data.renders.length} editions on ${data.key}`
    const canonical = `${SITE_URL}/pinnacle/moment/${encodeURIComponent(id)}`
    return {
      title,
      description: `${data.renders.length} distinct Disney Pinnacle renders share the legacy key ${data.key}. Pick the exact character.`,
      alternates: { canonical },
      robots: { index: false, follow: true },
    }
  }

  const { ed } = data
  const ogImage = `${SITE_URL}/api/public/pinnacle-image/${encodeURIComponent(ed.render_id)}`
  const title = `${ed.character_name ?? "Pinnacle edition"} · ${ed.variant ?? ""}`
  const description = `${ed.character_name ?? "—"} from ${ed.set_name ?? "—"}, ${ed.variant ?? "—"} variant, mint ${ed.total_minted ?? "—"}. Disney Pinnacle scarcity, per-pin FMV + live floor.`
  const canonical = `${SITE_URL}/pinnacle/moment/${encodeURIComponent(ed.render_id)}`
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: ogImage, width: 512, height: 512, alt: ed.character_name ?? "Pinnacle pin" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

// materials/effects come back as jsonb/text arrays (e.g. '["GOLD"]',
// '["LED GLITCH"]'). Render them as plain joined text rather than raw JSON.
function fmtList(v: string | string[] | null | undefined): string {
  if (v == null) return "—"
  let arr: unknown = v
  if (typeof v === "string") {
    const s = v.trim()
    if (s === "") return "—"
    if (s.startsWith("[")) {
      try { arr = JSON.parse(s) } catch { return s }
    } else {
      return s
    }
  }
  if (Array.isArray(arr)) {
    const cleaned = arr.map((x) => String(x).trim()).filter(Boolean)
    return cleaned.length ? cleaned.join(", ") : "—"
  }
  return String(arr)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" })
  } catch {
    return "—"
  }
}

export default async function PinnacleMomentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await load(id)
  if (!data) notFound()

  if (data.kind === "legacy") return <LegacyDisambiguation data={data} />

  const { ed, sales, holders, variant_avg_mint, scarcity_pct, siblings } = data
  const franchise = ed.franchises && ed.franchises.length > 0 ? ed.franchises[0] : null
  // Parallel ladder: every printing of THIS pin (same shape_render_id). Only
  // shown when there's more than one (the pin actually has parallels).
  const ladder = siblings.length >= 2 ? siblings : []

  // FMV-vs-floor signal: when FMV runs well above the live floor (>1.3x) on a
  // thin pin, the floor is often the better "what it's worth right now" number.
  const fmv = ed.fmv_usd != null ? Number(ed.fmv_usd) : null
  const floor = ed.floor_ask != null ? Number(ed.floor_ask) : null
  const fmvOverFloor = fmv != null && floor != null && floor > 0 && fmv > 1.3 * floor

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${ed.character_name ?? "Pinnacle pin"}${ed.set_name ? ` — ${ed.set_name}` : ""}`,
    image: `${SITE_URL}/api/public/pinnacle-image/${ed.render_id}`,
    brand: { "@type": "Brand", name: "Disney Pinnacle" },
    ...(fmv != null
      ? {
          offers: {
            "@type": "Offer",
            price: (floor ?? fmv).toFixed(2),
            priceCurrency: "USD",
            availability: floor != null ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          },
        }
      : {}),
  }

  return (
    <main style={pageStyle}>
      <style>{CSS}</style>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <section className="rpc-pm-hero rpc-pm-hero-flex">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="rpc-pm-art"
          src={`/api/public/pinnacle-image/${encodeURIComponent(ed.render_id)}`}
          alt={ed.character_name ?? "Pinnacle pin"}
          width={180}
          height={180}
        />
        <div className="rpc-pm-hero-body">
          <div className="rpc-pm-eyebrow">DISNEY PINNACLE</div>
          <h1 className="rpc-pm-h1">{ed.character_name ?? "—"}</h1>
          <div className="rpc-pm-meta-row">
            <span className="rpc-pm-meta">{ed.set_name ?? "—"}</span>
            {franchise ? <span className="rpc-pm-meta-sep">·</span> : null}
            {franchise ? <span className="rpc-pm-meta">{franchise}</span> : null}
            {ed.series_name ? <span className="rpc-pm-meta-sep">·</span> : null}
            {ed.series_name ? <span className="rpc-pm-meta">{ed.series_name}</span> : null}
            {ed.is_chaser ? <span className="rpc-pm-chaser">CHASER</span> : null}
          </div>
        </div>
      </section>

      {fmvOverFloor ? (
        <section className="rpc-pm-callout">
          FMV ({fmtUsd(fmv)}) runs above the live floor ({fmtUsd(floor)}) on this thin pin —
          the floor is likely the better &ldquo;what it&rsquo;s worth right now&rdquo; signal.
        </section>
      ) : null}

      <section className="rpc-pm-grid">
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Variant</div>
          <div className="rpc-pm-card-val">{ed.variant ?? "—"}</div>
          {ed.edition_type ? <div className="rpc-pm-card-sub">{ed.edition_type}</div> : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Mint count</div>
          <div className="rpc-pm-card-val">{fmtInt(ed.total_minted)}</div>
          {variant_avg_mint != null ? (
            <div className="rpc-pm-card-sub">variant avg {fmtInt(Math.round(variant_avg_mint))}</div>
          ) : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Scarcity vs variant</div>
          {scarcity_pct == null ? (
            <div className="rpc-pm-card-val">—</div>
          ) : scarcity_pct >= 0 ? (
            <>
              <div className="rpc-pm-card-val">{scarcity_pct.toFixed(0)}%</div>
              <div className="rpc-pm-card-sub">rarer than variant avg</div>
            </>
          ) : (
            // "more common" is unbounded as a % (a pin minted 6.6x the variant
            // average reads as -559.2%), so express it as a clean multiple.
            <>
              <div className="rpc-pm-card-val">
                {(ed.total_minted && variant_avg_mint
                  ? ed.total_minted / variant_avg_mint
                  : 1 - scarcity_pct / 100
                ).toFixed(1)}×
              </div>
              <div className="rpc-pm-card-sub">more common than variant avg</div>
            </>
          )}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Latest FMV</div>
          <div className="rpc-pm-card-val">{fmtUsd(fmv)}</div>
          {ed.fmv_confidence ? (
            <div className="rpc-pm-card-sub">
              {ed.fmv_confidence}
              {ed.fmv_sales_count_30d != null ? ` · ${ed.fmv_sales_count_30d} sales/30d` : ""}
            </div>
          ) : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Floor ask</div>
          <div className="rpc-pm-card-val">{fmtUsd(floor)}</div>
          <div className="rpc-pm-card-sub">live lowest listing</div>
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Tracked holders</div>
          <div className="rpc-pm-card-val">{fmtInt(holders)}</div>
          <div className="rpc-pm-card-sub">in RPC wallet cache</div>
        </div>
      </section>

      {sales.length > 0 ? (
        <section className="rpc-pm-detail">
          <h2 className="rpc-pm-h2">Recent sales</h2>
          <div className="rpc-pm-sales">
            <table className="rpc-pm-sales-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="rpc-pm-num">Serial</th>
                  <th className="rpc-pm-num">Price</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s, i) => (
                  <tr key={i}>
                    <td>{fmtDate(s.sold_at)}</td>
                    <td className="rpc-pm-num">{s.serial_number != null ? `#${s.serial_number}` : "—"}</td>
                    <td className="rpc-pm-num">{fmtUsd(s.sale_price_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {ladder.length > 0 ? (
        <section className="rpc-pm-detail">
          <h2 className="rpc-pm-h2">Other printings of this pin</h2>
          <div className="rpc-pm-ladder-note">
            {ed.character_name ?? "This pin"} appears in {ladder.length} printings — each
            a distinct render with its own mint count and market. Per-render FMV below.
          </div>
          <div className="rpc-pm-disambig">
            {ladder.map((r) => (
              <Link
                key={r.render_id}
                href={`/pinnacle/moment/${encodeURIComponent(r.render_id)}`}
                className={`rpc-pm-disambig-card${r.is_self ? " rpc-pm-disambig-self" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="rpc-pm-disambig-art"
                  src={`/api/public/pinnacle-image/${encodeURIComponent(r.render_id)}`}
                  alt={r.variant ?? r.render_id}
                  width={72}
                  height={72}
                  loading="lazy"
                />
                <div className="rpc-pm-disambig-body">
                  <div className="rpc-pm-disambig-name">
                    {r.variant ?? "Standard"}
                    {r.is_self ? <span className="rpc-pm-disambig-viewing"> · viewing</span> : null}
                  </div>
                  <div className="rpc-pm-disambig-sub">
                    {r.printing != null && r.printing > 1 ? `Printing ${r.printing} · ` : ""}
                    mint {fmtInt(r.total_minted)}
                  </div>
                  <div className="rpc-pm-disambig-stats">
                    <span className="rpc-pm-disambig-fmv">{fmtUsd(r.fmv_usd)}</span>
                    {r.fmv_confidence ? <span>{r.fmv_confidence}</span> : null}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rpc-pm-detail">
        <h2 className="rpc-pm-h2">Edition details</h2>
        <div className="rpc-pm-pairs">
          <Detail label="Series" value={ed.series_name ?? "—"} />
          <Detail label="Printing" value={ed.printing != null ? String(ed.printing) : "—"} />
          <Detail label="Materials" value={fmtList(ed.materials)} />
          <Detail label="Effects" value={fmtList(ed.effects)} />
          <Detail label="Size" value={ed.size ?? "—"} />
          <Detail label="Color" value={ed.color ?? "—"} />
          <Detail label="Thickness" value={ed.thickness ?? "—"} />
          <Detail label="FMV computed" value={fmtDate(ed.fmv_computed_at)} />
        </div>
      </section>

      <section className="rpc-pm-footer">
        <Link href="/insights/pinnacle-scarcity" className="rpc-pm-back">
          ← Back to Pinnacle scarcity board
        </Link>
      </section>
    </main>
  )
}

function LegacyDisambiguation({ data }: { data: LegacyData }) {
  return (
    <main style={pageStyle}>
      <style>{CSS}</style>
      <section className="rpc-pm-hero">
        <div className="rpc-pm-eyebrow">DISNEY PINNACLE</div>
        <h1 className="rpc-pm-h1">Pick a pin</h1>
        <div className="rpc-pm-meta-row">
          <span className="rpc-pm-meta">
            {data.renders.length} distinct renders share the set-level key{" "}
            <code className="rpc-pm-code">{data.key}</code>
          </span>
        </div>
      </section>

      <section className="rpc-pm-disambig">
        {data.renders.map((r) => (
          <Link
            key={r.render_id}
            href={`/pinnacle/moment/${encodeURIComponent(r.render_id)}`}
            className="rpc-pm-disambig-card"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="rpc-pm-disambig-art"
              src={`/api/public/pinnacle-image/${encodeURIComponent(r.render_id)}`}
              alt={r.character_name ?? "Pinnacle pin"}
              width={96}
              height={96}
            />
            <div className="rpc-pm-disambig-body">
              <div className="rpc-pm-disambig-name">{r.character_name ?? r.render_id}</div>
              <div className="rpc-pm-disambig-sub">
                {r.set_name ?? "—"}
                {r.variant ? ` · ${r.variant}` : ""}
              </div>
              <div className="rpc-pm-disambig-stats">
                <span>mint {fmtInt(r.total_minted)}</span>
                <span className="rpc-pm-disambig-fmv">{fmtUsd(r.fmv_usd)}</span>
              </div>
            </div>
          </Link>
        ))}
      </section>

      <section className="rpc-pm-footer">
        <Link href="/insights/pinnacle-scarcity" className="rpc-pm-back">
          ← Back to Pinnacle scarcity board
        </Link>
      </section>
    </main>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rpc-pm-pair">
      <div className="rpc-pm-pair-label">{label}</div>
      <div className="rpc-pm-pair-val">{value}</div>
    </div>
  )
}

const pageStyle = {
  minHeight: "100vh",
  background: "var(--rpc-black)",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-body)",
  padding: "32px 20px 80px",
} as const

const CSS = `
.rpc-pm-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pm-hero-flex { display: flex; gap: 22px; align-items: center; }
.rpc-pm-art { width: 180px; height: 180px; object-fit: contain; border-radius: 6px; background: var(--rpc-surface-raised); border: 1px solid var(--rpc-border-subtle); flex-shrink: 0; }
.rpc-pm-hero-body { min-width: 0; }
.rpc-pm-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-pm-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(34px, 5vw, 56px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-pm-h2 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 14px; }
.rpc-pm-meta-row { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-pm-meta { color: var(--rpc-text-secondary); }
.rpc-pm-meta-sep { color: var(--rpc-text-ghost); }
.rpc-pm-code { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-primary); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 2px; text-transform: none; letter-spacing: 0; }
.rpc-pm-chaser { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; padding: 3px 8px; background: var(--rpc-red-bg); color: var(--rpc-red); border: 1px solid var(--rpc-red-border); border-radius: 2px; margin-left: 4px; }

.rpc-pm-callout { max-width: 1180px; margin: 0 auto 18px; padding: 12px 14px; background: var(--rpc-red-bg); border-left: 3px solid var(--rpc-red); border-radius: 2px; font-size: 13px; line-height: 1.55; color: var(--rpc-text-secondary); }

.rpc-pm-grid { max-width: 1180px; margin: 0 auto 32px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.rpc-pm-card { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 16px 18px; border-radius: 2px; }
.rpc-pm-card-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-pm-card-val { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-pm-card-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; color: var(--rpc-text-muted); margin-top: 4px; text-transform: uppercase; }

.rpc-pm-detail { max-width: 1180px; margin: 0 auto 28px; }
.rpc-pm-pairs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 24px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); padding: 18px 22px; border-radius: 2px; }
.rpc-pm-pair { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pm-pair:last-child, .rpc-pm-pair:nth-last-child(2) { border-bottom: none; }
.rpc-pm-pair-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-pm-pair-val { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-primary); text-align: right; }

.rpc-pm-sales { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; overflow-x: auto; }
.rpc-pm-sales-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rpc-pm-sales-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-pm-sales-table td { padding: 9px 14px; border-bottom: 1px solid var(--rpc-border-subtle); font-family: var(--font-mono); color: var(--rpc-text-primary); }
.rpc-pm-sales-table tr:last-child td { border-bottom: none; }
.rpc-pm-num { text-align: right; }

.rpc-pm-disambig { max-width: 1180px; margin: 0 auto 28px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.rpc-pm-disambig-card { display: flex; gap: 14px; align-items: center; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 12px 14px; border-radius: 2px; text-decoration: none; color: inherit; transition: border-color 100ms; }
.rpc-pm-disambig-card:hover { border-color: var(--rpc-red); }
.rpc-pm-disambig-self { border-color: var(--rpc-red); background: var(--rpc-red-bg); }
.rpc-pm-disambig-viewing { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-red); text-transform: uppercase; }
.rpc-pm-ladder-note { font-family: var(--font-mono); font-size: 12px; line-height: 1.55; color: var(--rpc-text-muted); margin-bottom: 14px; }
.rpc-pm-disambig-art { width: 72px; height: 72px; object-fit: contain; border-radius: 4px; background: var(--rpc-surface); flex-shrink: 0; }
.rpc-pm-disambig-body { min-width: 0; }
.rpc-pm-disambig-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); }
.rpc-pm-disambig-sub { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin: 2px 0 6px; }
.rpc-pm-disambig-stats { display: flex; gap: 12px; font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-secondary); }
.rpc-pm-disambig-fmv { color: var(--rpc-red); font-weight: 700; }

.rpc-pm-footer { max-width: 1180px; margin: 0 auto; }
.rpc-pm-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; }
.rpc-pm-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-pm-hero-flex { flex-direction: column; align-items: flex-start; }
  .rpc-pm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-pm-pairs { grid-template-columns: 1fr; }
}
`
