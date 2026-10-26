// components/entity/PaniniProductBody.tsx
//
// The Panini PRODUCT page body (/panini-blockchain/product/<id>-<slug>, 2026-10-25) — the counterpart of
// Top Shot's series page: headline stats, the product's sets, its most valuable editions, its biggest
// recent sales and its packs. Data: lib/panini/product.ts (panini_product_rollup, hourly).
//
// Honesty: every count is editions RPC has SEEN (listing-gated — the coverage note says so), sales are
// ON RECORD and lag 12–160 h, the totals say how many editions they cover, and a failed read renders
// "couldn't load" — never zeros. No FMV confidence tier appears anywhere (standing rule, 2026-10-18).

import Link from "next/link"
import type { CSSProperties } from "react"
import { Section, StatCell, fmtUsd, fmtCount, relTime } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import { PaniniProductPacksSection } from "@/components/entity/PaniniEditionExtras"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { serialLabelOfSku } from "@/lib/panini/product-url"
import type { PaniniProduct, PaniniProductRead } from "@/lib/panini/product"
import type { PaniniProductPack } from "@/lib/panini/edition-extras"

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }
const sub: CSSProperties = { marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }

const editionHref = (collection: string, externalId: string) => `/${collection}/edition/${encodeURIComponent(externalId)}`

export function PaniniProductUnavailable({ collection }: { collection: string }) {
  return (
    <section data-testid="panini-product-unavailable" style={{ padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
        Couldn&rsquo;t load this product
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, margin: "12px auto 0", lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time. This is a problem on our side &mdash; it does not mean the product is gone. Reloading often works.
      </p>
      <Link href={`/${collection}/sets`} className="rpc-mono" style={{ display: "inline-block", marginTop: 16, color: "var(--rpc-red-text)" }}>
        Browse sets →
      </Link>
    </section>
  )
}

export default function PaniniProductBody({
  collection,
  collectionLabel,
  product: p,
  packs,
}: {
  collection: string
  collectionLabel: string
  product: PaniniProduct
  packs: { packs: PaniniProductPack[] | null; productName: string | null }
}) {
  const unpriced = p.editions - p.priced_editions
  return (
    <div data-testid="panini-product">
      <Breadcrumbs items={[{ name: collectionLabel, href: `/${collection}/overview` }, { name: "Products", href: `/${collection}/product` }, { name: p.name }]} />

      <header style={{ marginTop: 8 }}>
        <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
          Panini product{p.sport ? ` · ${p.sport}` : ""}
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(24px, 5vw, 40px)", letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "4px 0 6px" }}>
          {p.name}
        </h1>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {fmtCount(p.editions)} editions seen · {fmtCount(p.players)} players · {fmtCount(p.sets)} sets
          {p.computed_at ? ` · updated ${relTime(p.computed_at)}` : ""}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
        <StatCell
          label="FMV total"
          value={fmtUsd(p.fmv_total_usd)}
          sub={unpriced > 0 ? `${fmtCount(p.priced_editions)} priced · ${fmtCount(unpriced)} unpriced` : `${fmtCount(p.priced_editions)} editions priced`}
        />
        <StatCell label="Listed now" value={fmtCount(p.listed_editions)} sub="editions with an ask re-read in 7 days" />
        <StatCell label="Cheapest ask" value={fmtUsd(p.cheapest_ask_usd)} sub="lowest confirmed ask, any edition" />
        <StatCell
          label="Sales · 30 days"
          value={fmtCount(p.sales_30d)}
          sub={
            p.sales_30d > 0
              ? `on record · ${fmtUsd(p.sales_30d_volume_usd)} · median ${fmtUsd(p.sales_30d_median_usd)}`
              : "none on record yet"
          }
        />
      </div>
      <div className="rpc-mono" data-testid="panini-product-sales-lag" style={{ marginTop: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>
        Panini sales reach RPC hours to days after they happen, so the newest days are not complete.
        {p.newest_sale_at ? ` Newest sale on record: ${relTime(p.newest_sale_at)}.` : ""}
      </div>

      <div style={{ marginTop: 14 }}>
        <PaniniCoverageNote coverage={null} />
      </div>

      <Section title="Sets">
        <div className="rpc-mono" style={sub}>Each set in this product, largest first.</div>
        {p.sets_list.length === 0 ? (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>RPC hasn&apos;t grouped this product&apos;s editions into sets yet.</div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Sets in this product")}>
            <table data-testid="panini-product-sets" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Set</th>
                  <th scope="col" style={head}>Editions</th>
                  <th scope="col" style={head}>Listed</th>
                  <th scope="col" style={head}>Cheapest ask</th>
                  <th scope="col" style={head}>FMV total</th>
                </tr>
              </thead>
              <tbody>
                {p.sets_list.map((s) => (
                  <tr key={s.slug}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      <Link href={`/${collection}/set/${encodeURIComponent(s.slug)}`} style={{ color: "inherit" }}>{s.name ?? s.slug}</Link>
                    </td>
                    <td style={cell}>{fmtCount(s.editions)}</td>
                    <td style={cell}>{fmtCount(s.listed)}</td>
                    <td style={cell}>{fmtUsd(s.cheapest_ask_usd)}</td>
                    <td style={cell}>{fmtUsd(s.fmv_total_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Most Valuable Editions">
        <div className="rpc-mono" style={sub}>Highest FMV among the editions RPC has priced.</div>
        {p.top_editions.length === 0 ? (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>No edition of this product is priced yet.</div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Most valuable editions")}>
            <table data-testid="panini-product-top-editions" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Card</th>
                  <th scope="col" style={head}>Parallel</th>
                  <th scope="col" style={head}>FMV</th>
                  <th scope="col" style={head}>Ask</th>
                </tr>
              </thead>
              <tbody>
                {p.top_editions.map((e) => (
                  <tr key={e.external_id}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      <Link href={editionHref(collection, e.external_id)} style={{ color: "inherit" }}>{e.player_name ?? e.external_id}</Link>
                    </td>
                    <td style={cell}>{[e.parallel, e.mint_cap ? `/${e.mint_cap}` : null].filter(Boolean).join(" ") || "—"}</td>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>{fmtUsd(e.fmv_usd)}</td>
                    <td style={cell}>{e.low_ask_usd != null ? fmtUsd(e.low_ask_usd) : "not listed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Top Sales · 90 Days">
        <div className="rpc-mono" style={sub}>The biggest sales on record in the last 90 days.</div>
        {p.top_sales_90d.length === 0 ? (
          <div className="rpc-mono" data-testid="panini-product-no-sales" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
            No sale of this product is on record for the last 90 days.
          </div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Top sales in 90 days")}>
            <table data-testid="panini-product-top-sales" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Card</th>
                  <th scope="col" style={head}>Serial</th>
                  <th scope="col" style={head}>Sold for</th>
                  <th scope="col" style={head}>When</th>
                </tr>
              </thead>
              <tbody>
                {p.top_sales_90d.map((s, i) => (
                  <tr key={`${s.sku}-${s.sold_at}-${i}`}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      <Link href={editionHref(collection, s.external_id)} style={{ color: "inherit" }}>
                        {s.player_name ?? s.external_id}
                        {s.parallel ? ` · ${s.parallel}` : ""}
                      </Link>
                    </td>
                    <td style={cell}>{serialLabelOfSku(s.sku) ?? "—"}</td>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>{fmtUsd(s.amount_usd)}</td>
                    <td style={cell}>{relTime(s.sold_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <PaniniProductPacksSection
        collection={collection}
        mode="product"
        packs={{ packs: packs.packs, productName: packs.productName ?? p.name, stillInPacks: null, fotlExclusive: false, productSetId: p.product_set_id }}
      />
    </div>
  )
}

export type { PaniniProductRead }
