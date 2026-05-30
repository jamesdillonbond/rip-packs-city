// app/pinnacle/moment/[id]/page.tsx
//
// Public per-edition Pinnacle detail page. Server-rendered. Sister surface
// to /moment/[id] but scoped to Pinnacle (which lives in its own
// pinnacle_editions + pinnacle_fmv_snapshots tables, separate from the
// shared editions table the Top Shot / AllDay / Golazos / UFC route uses).
//
// Reached from /insights/pinnacle-scarcity per-row links and from the
// /pinnacle sniper page (future).
//
// Resolves [id] as pinnacle_editions.id (the primary key — text). 404s
// gracefully if the edition isn't in the catalog (unresolved stub rows
// from wallet scans return 404 rather than rendering empty fields).

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type PinnacleEdition = {
  id: string
  external_id: string | null
  character_name: string | null
  franchise: string | null
  set_name: string | null
  variant_type: string | null
  edition_type: string | null
  mint_count: number | null
  is_chaser: boolean | null
  thumbnail_url: string | null
  studio: string | null
  materials: string[] | null
  effects: string[] | null
  size: string | null
  color: string | null
  thickness: string | null
  minting_date: string | null
  ask_price: number | null
  ask_source: string | null
  series_year: number | null
}

type LatestFmv = {
  fmv_usd: number | null
  confidence: string | null
  computed_at: string | null
  sales_count_30d: number | null
  days_since_sale: number | null
}

async function load(rawId: string): Promise<{
  ed: PinnacleEdition & { edition_key: string | null }
  fmv: LatestFmv | null
  variant_avg_mint: number | null
  holders_cached: number
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supa = supabaseAdmin as any

  // Next.js 16 / Vercel deliver params.id URL-encoded — `%3A` stays as
  // `%3A`, not decoded back to `:`. 331/479 pinnacle_editions ids contain
  // colons (e.g. "PIXR-LEV1-INOU:Standard:1"), so the encoded literal
  // never matches the DB row. Decode once at the lambda boundary before
  // any lookup.
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    id = rawId
  }

  // Single round-trip via SECDEF RPC — takes p_id as a JSON body
  // parameter and returns ed + fmv + variant_avg_mint + holders_cached
  // as one jsonb blob. Returns NULL when no edition row matches.
  const { data: blob } = await supa.rpc("get_pinnacle_moment_detail", { p_id: id })
  if (!blob || !blob.ed) return null

  return {
    ed: blob.ed as PinnacleEdition & { edition_key: string | null },
    fmv: (blob.fmv ?? null) as LatestFmv | null,
    variant_avg_mint:
      blob.variant_avg_mint != null ? Number(blob.variant_avg_mint) : null,
    holders_cached: Number(blob.holders_cached ?? 0),
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
  const { ed } = data
  const title = `${ed.character_name ?? "Pinnacle edition"} · ${ed.variant_type ?? ""} | Rip Packs City`
  const description = `${ed.character_name ?? "—"} from ${ed.set_name ?? "—"}, ${ed.variant_type ?? "—"} variant, mint ${ed.mint_count ?? "—"}. Disney Pinnacle scarcity + latest FMV.`
  return {
    title,
    description,
    alternates: { canonical: `${SITE_URL}/pinnacle/moment/${id}` },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/pinnacle/moment/${id}`,
      siteName: "Rip Packs City",
      type: "website",
    },
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
  const { ed, fmv, variant_avg_mint, holders_cached } = data

  const scarcityPct =
    variant_avg_mint && ed.mint_count
      ? Math.round((1 - Number(ed.mint_count) / Number(variant_avg_mint)) * 1000) / 10
      : null

  return (
    <main style={pageStyle}>
      <style>{CSS}</style>

      <section className="rpc-pm-hero">
        <div className="rpc-pm-eyebrow">DISNEY PINNACLE</div>
        <h1 className="rpc-pm-h1">{ed.character_name ?? "—"}</h1>
        <div className="rpc-pm-meta-row">
          <span className="rpc-pm-meta">{ed.set_name ?? "—"}</span>
          {ed.franchise ? <span className="rpc-pm-meta-sep">·</span> : null}
          {ed.franchise ? <span className="rpc-pm-meta">{ed.franchise}</span> : null}
          {ed.studio ? <span className="rpc-pm-meta-sep">·</span> : null}
          {ed.studio ? <span className="rpc-pm-meta">{ed.studio}</span> : null}
          {ed.is_chaser ? <span className="rpc-pm-chaser">CHASER</span> : null}
        </div>
      </section>

      <section className="rpc-pm-grid">
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Variant</div>
          <div className="rpc-pm-card-val">{ed.variant_type ?? "—"}</div>
          {ed.edition_type ? <div className="rpc-pm-card-sub">{ed.edition_type}</div> : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Mint count</div>
          <div className="rpc-pm-card-val">{fmtInt(ed.mint_count)}</div>
          {variant_avg_mint != null ? (
            <div className="rpc-pm-card-sub">variant avg {fmtInt(Math.round(variant_avg_mint))}</div>
          ) : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Scarcity vs variant</div>
          <div className="rpc-pm-card-val">{scarcityPct != null ? `${scarcityPct.toFixed(1)}%` : "—"}</div>
          {scarcityPct != null ? (
            <div className="rpc-pm-card-sub">{scarcityPct >= 0 ? "rarer than average" : "more common"}</div>
          ) : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Latest FMV</div>
          <div className="rpc-pm-card-val">{fmtUsd(fmv?.fmv_usd ?? null)}</div>
          {fmv?.confidence ? (
            <div className="rpc-pm-card-sub">
              {fmv.confidence}
              {fmv.sales_count_30d != null ? ` · ${fmv.sales_count_30d} sales/30d` : ""}
            </div>
          ) : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Ask</div>
          <div className="rpc-pm-card-val">{fmtUsd(ed.ask_price)}</div>
          {ed.ask_source ? <div className="rpc-pm-card-sub">{ed.ask_source}</div> : null}
        </div>
        <div className="rpc-pm-card">
          <div className="rpc-pm-card-label">Tracked holders</div>
          <div className="rpc-pm-card-val">{fmtInt(holders_cached)}</div>
          <div className="rpc-pm-card-sub">in RPC wallet cache</div>
        </div>
      </section>

      <section className="rpc-pm-detail">
        <h2 className="rpc-pm-h2">Edition details</h2>
        <div className="rpc-pm-pairs">
          <Detail label="Series year" value={ed.series_year ? String(ed.series_year) : "—"} />
          <Detail label="Materials" value={ed.materials ? ed.materials.join(", ") : "—"} />
          <Detail label="Effects" value={ed.effects ? ed.effects.join(", ") : "—"} />
          <Detail label="Size" value={ed.size ?? "—"} />
          <Detail label="Color" value={ed.color ?? "—"} />
          <Detail label="Thickness" value={ed.thickness ?? "—"} />
          <Detail label="Minting date" value={fmtDate(ed.minting_date)} />
          <Detail label="FMV computed" value={fmtDate(fmv?.computed_at ?? null)} />
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
.rpc-pm-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-pm-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-pm-h2 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 14px; }
.rpc-pm-meta-row { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-pm-meta { color: var(--rpc-text-secondary); }
.rpc-pm-meta-sep { color: var(--rpc-text-ghost); }
.rpc-pm-chaser { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; padding: 3px 8px; background: var(--rpc-red-bg); color: var(--rpc-red); border: 1px solid var(--rpc-red-border); border-radius: 2px; margin-left: 4px; }

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

.rpc-pm-footer { max-width: 1180px; margin: 0 auto; }
.rpc-pm-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; }
.rpc-pm-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-pm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-pm-pairs { grid-template-columns: 1fr; }
}
`
