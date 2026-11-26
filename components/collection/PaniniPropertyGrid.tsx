// components/collection/PaniniPropertyGrid.tsx
//
// "What Panini covers" (2026-11-26): one tile per league, tournament or IP that has a Panini product page,
// under two headings — Leagues and Entertainment. ⛔ The word "property" never renders (Trevor 11-26).
// Pure props; the server wrapper below reads get_panini_property_board(). A failed read renders NOTHING
// (the overview keeps its Products link) — never an empty grid stated as fact. Counts are editions RPC has
// seen; sales are those on record and lag. No FMV tier anywhere.

import Link from "next/link"
import { fmtUsd, fmtCount } from "@/components/entity/_shared"
import {
  PANINI_PROPERTY_HEADINGS,
  fetchPaniniPropertyBoard,
  paniniPropertyHref,
  seasonSpan,
  type PaniniProperty,
} from "@/lib/panini/properties"

export function PaniniPropertyGridView({ collection, properties }: { collection: string; properties: PaniniProperty[] }) {
  if (properties.length === 0) return null
  return (
    <section className="rpc-card" data-testid="panini-property-grid" style={{ padding: "16px 20px" }}>
      <h2 className="rpc-label" style={{ margin: "0 0 4px" }}>What Panini covers</h2>
      <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
        Every league and brand RPC has seen a Panini card from. Sales are those on record; Panini sales reach RPC hours to days late.
      </div>
      {PANINI_PROPERTY_HEADINGS.map(({ key, label }) => {
        const list = properties
          .filter((p) => p.heading === key)
          .sort((a, b) => (b.sales_30d_volume_usd ?? 0) - (a.sales_30d_volume_usd ?? 0) || a.sort_order - b.sort_order)
        if (list.length === 0) return null
        return (
          <div key={key} data-testid={`panini-property-group-${key}`} style={{ marginTop: 10 }}>
            <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 8px" }}>
              {label}
            </h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
              {list.map((p) => {
                const seasons = seasonSpan(p)
                return (
                  <li key={p.slug}>
                    <Link
                      prefetch={false}
                      href={paniniPropertyHref(collection, p.slug)}
                      data-testid={`panini-property-${p.slug}`}
                      className="rpc-tap44"
                      style={{ display: "block", padding: "12px 14px", border: "1px solid var(--rpc-border)", borderRadius: 6, textDecoration: "none", color: "inherit", height: "100%" }}
                    >
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
                        {p.name}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                        {p.category && p.category !== p.name ? `${p.category} · ` : ""}{seasons ?? "—"}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)", marginTop: 8, lineHeight: 1.7 }}>
                        {fmtCount(p.products)} {p.products === 1 ? "product" : "products"} · {fmtCount(p.editions)} cards
                        <br />
                        {fmtCount(p.sales_30d)} sales in 30 days{p.sales_30d_volume_usd ? ` · ${fmtUsd(p.sales_30d_volume_usd)}` : ""}
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

/** Server wrapper: a failed read renders nothing. */
export default async function PaniniPropertyGrid({ collection }: { collection: string }) {
  const res = await fetchPaniniPropertyBoard()
  if (!res.ok) return null
  return <PaniniPropertyGridView collection={collection} properties={res.board.properties} />
}
