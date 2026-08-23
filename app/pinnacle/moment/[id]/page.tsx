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
import { Fragment } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { dedupeLabelParts, joinMetaParts, metaField } from "@/lib/format"
import { fmtList } from "@/lib/pinnacle/catalog-format"
import { WalletLink } from "@/components/entity/_shared"
import PinnacleFmvChart from "@/components/pinnacle/PinnacleFmvChart"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import SiteFooter from "@/components/SiteFooter"
import MobileNav from "@/components/MobileNav"
import SupportChatConnected from "@/components/SupportChatConnected"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

import { load, decodeId, type LegacyData } from "@/lib/pinnacle/moment-detail"
import { OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { data, ok } = await load(id)
  // ⚠ A failed read must not let a transient blip de-index a real pin.
  if (!ok) {
    return {
      title: "Pinnacle edition",
      robots: { index: false, follow: true },
    }
  }
  if (!data) return { title: "Pinnacle edition" }

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
  // Read every catalog field through metaField (2026-07-25): pinnacle_catalog
  // carries stray trailing whitespace (`set_name` = "Walt Disney Animation
  // Studios • Disney Genesis "), which used to render as "…Disney Genesis ,
  // Genesis variant" in all three description tags. The hero row was trimmed via
  // dedupeLabelParts the same day; this template was missed.
  const charName = metaField(ed.character_name)
  const setName = metaField(ed.set_name)
  const variant = metaField(ed.variant)
  // joinMetaParts drops absent segments, so a null `variant` can't leave a
  // dangling " · " on the title.
  const title = joinMetaParts([charName ?? "Pinnacle edition", variant], " · ")
  // Absent facts are omitted rather than rendered as em-dashes: "— from —, —
  // variant" is noise in a search snippet. The subject keeps a real fallback so
  // the sentence always reads.
  const facts = joinMetaParts(
    [
      setName ? `from ${setName}` : null,
      variant ? `${variant} variant` : null,
      ed.total_minted != null ? `mint ${ed.total_minted}` : null,
    ],
    ", ",
  )
  const description = joinMetaParts(
    [joinMetaParts([charName ?? "Disney Pinnacle pin", facts], " "), "Disney Pinnacle scarcity, per-pin FMV + live floor."],
    ". ",
  )
  const canonical = `${SITE_URL}/pinnacle/moment/${encodeURIComponent(ed.render_id)}`
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      ...OG_INHERITED,
      title,
      description,
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: ogImage, width: 512, height: 512, alt: charName ?? "Pinnacle pin" }],
    },
    twitter: {
    ...TWITTER_INHERITED, card: "summary_large_image", title, description, images: [ogImage] },
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
  const { data, ok } = await load(id)
  // ⚠ A FAILED read must never become a 404. This is the shareable Pinnacle pin
  // URL — the same surface class as /moment/[id], which got this fix while the
  // Pinnacle sibling did not. `ok && !data` is a real "no such pin" and still
  // 404s. See the PinLoad doc comment.
  if (!ok) return <PinnacleShell><PinUnavailableCard id={decodeId(id)} /></PinnacleShell>
  if (!data) notFound()

  if (data.kind === "legacy") return <PinnacleShell><LegacyDisambiguation data={data} /></PinnacleShell>

  const { ed, sales, holders, variant_avg_mint, scarcity_pct, siblings, fmvHistory, nameByAddr, serialLadder } = data
  const franchise = ed.franchises && ed.franchises.length > 0 ? ed.franchises[0] : null
  // set_name often already embeds the studio/franchise (e.g. "Walt Disney
  // Animation Studios • Disney Genesis"), so joining set · franchise · series
  // printed the studio twice. Dedupe the parts before rendering.
  const metaParts = dedupeLabelParts([ed.set_name, franchise, ed.series_name])
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
    // Same trim rule as generateMetadata — JSON-LD is a machine-read surface, so
    // a trailing space here ends up in rich-result output too.
    name: joinMetaParts([metaField(ed.character_name) ?? "Pinnacle pin", metaField(ed.set_name)], " — "),
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
    <PinnacleShell>
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
            {metaParts.length === 0 ? <span className="rpc-pm-meta">—</span> : null}
            {metaParts.map((part, i) => (
              <Fragment key={part}>
                {i > 0 ? <span className="rpc-pm-meta-sep">·</span> : null}
                <span className="rpc-pm-meta">{part}</span>
              </Fragment>
            ))}
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
          {/* Confidence tier removed 2026-07-11 — keep the factual sales count. */}
          {ed.fmv_sales_count_30d != null ? (
            <div className="rpc-pm-card-sub">{ed.fmv_sales_count_30d} sales/30d</div>
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

      {serialLadder && serialLadder.length > 0 ? (
        <section className="rpc-pm-detail">
          <h2 className="rpc-pm-h2">Serial premium</h2>
          <div className="rpc-pm-ladder-note">
            Low serials on Disney Pinnacle command a premium. Estimated value by serial tier for this
            pin, from Rip Packs City&rsquo;s render-keyed serial-FMV model (overlay on the {fmtUsd(ed.fmv_usd)} render FMV).
          </div>
          <div className="rpc-pm-disambig">
            {serialLadder.map((r) => (
              <div key={r.label} className="rpc-pm-disambig-card" style={{ cursor: "default" }}>
                <div className="rpc-pm-disambig-body">
                  <div className="rpc-pm-disambig-name">{r.label}</div>
                  <div className="rpc-pm-disambig-sub">{r.note}</div>
                  <div className="rpc-pm-disambig-stats">
                    <span className="rpc-pm-disambig-fmv">{fmtUsd(r.estimate)}</span>
                    {r.mult > 1 ? <span>{r.mult.toFixed(r.mult >= 10 ? 0 : 1)}× typical</span> : <span>base</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rpc-pm-ladder-note" style={{ marginTop: 8, opacity: 0.7 }}>
            Estimate only — actual price depends on the specific serial, demand, and listings.
          </div>
        </section>
      ) : null}

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
                  <th>Buyer</th>
                  <th>Seller</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s, i) => (
                  <tr key={i}>
                    <td>{fmtDate(s.sold_at)}</td>
                    <td className="rpc-pm-num">{s.serial_number != null && s.serial_number > 0 ? `#${s.serial_number}` : "—"}</td>
                    <td className="rpc-pm-num">{fmtUsd(s.sale_price_usd)}</td>
                    <td><WalletLink address={s.buyer_address} name={s.buyer_address ? nameByAddr[s.buyer_address.toLowerCase()] : null} /></td>
                    <td><WalletLink address={s.seller_address} name={s.seller_address ? nameByAddr[s.seller_address.toLowerCase()] : null} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {fmvHistory.length > 2 ? (
        <section className="rpc-pm-detail">
          <h2 className="rpc-pm-h2">FMV history</h2>
          <PinnacleFmvChart points={fmvHistory} />
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
    </PinnacleShell>
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

// Global site chrome so this route (outside the (collections) group layout) isn't
// orphaned — matches the sticky header + footer + mobile nav + concierge that
// every collection page gets.
function PinnacleShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <GlobalSiteHeader />
      {children}
      <SiteFooter />
      <SupportChatConnected />
      <MobileNav />
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

/**
 * Shown when the pin READ failed — never when the pin genuinely does not exist
 * (that is still `notFound()`).
 *
 * ⚠ Deliberately NOT a 404. This is the shareable Pinnacle pin URL, so a 404 for
 * a real pin is a hard "this does not exist" served to a collector who just
 * posted the link and to any crawler that follows it. The metadata branch
 * carries `robots: noindex, follow` for the same reason. Mirrors
 * MomentUnavailableCard in app/moment/[id]/page.tsx — the Top Shot sibling that
 * got this fix while this page was left out of the sweep.
 */
function PinUnavailableCard({ id }: { id: string }) {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 28,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rpc-text-primary)",
        }}
      >
        This pin didn&apos;t load
      </h1>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--rpc-text-secondary)" }}>
        The catalog is under heavy load right now. This says nothing about whether the pin
        exists — only that we couldn&apos;t read it. Reload in a moment.
      </p>
      <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
        {id}
      </p>
    </main>
  )
}
