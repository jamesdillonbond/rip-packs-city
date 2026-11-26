// components/collection/CandyPropertyGrid.tsx
//
// "What Candy covers" (2026-11-26): one tile per league or brand Candy has published a collection under,
// beneath two headings — Leagues and Entertainment. ⛔ The word "property" never renders (Trevor 11-26).
// Pure props; the server wrapper reads get_candy_property_board(). A failed read renders NOTHING — never an
// empty grid stated as fact. "Cards" is cards in circulation per the chain; sales are those on record.

import Link from "next/link"
import { fmtUsd, fmtCount } from "@/components/entity/_shared"
import { CANDY_PROPERTY_HEADINGS, candyPropertyHref, candySeasonSpan, fetchCandyPropertyBoard, type CandyProperty } from "@/lib/candy/properties"

export function CandyPropertyGridView({ collection, properties, unplaced = 0 }: { collection: string; properties: CandyProperty[]; unplaced?: number }) {
  const shown = properties.filter((p) => p.collections > 0)
  if (shown.length === 0) return null
  return (
    <section className="rpc-card" data-testid="candy-property-grid" style={{ padding: "16px 20px" }}>
      <h2 className="rpc-label" style={{ margin: "0 0 4px" }}>What Candy covers</h2>
      <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
        Every league and brand Candy has published cards for, from the brand named in each collection&rsquo;s own record. Sales are those on record.
      </div>
      {CANDY_PROPERTY_HEADINGS.map(({ key, label }) => {
        const list = shown
          .filter((p) => p.heading === key)
          .sort((a, b) => (b.sales_90d_volume_usd ?? 0) - (a.sales_90d_volume_usd ?? 0) || a.sort_order - b.sort_order)
        if (list.length === 0) return null
        return (
          <div key={key} data-testid={`candy-property-group-${key}`} style={{ marginTop: 10 }}>
            <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 8px" }}>
              {label}
            </h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
              {list.map((p) => {
                const seasons = candySeasonSpan(p)
                return (
                  <li key={p.slug}>
                    <Link
                      prefetch={false}
                      href={candyPropertyHref(collection, p.slug)}
                      data-testid={`candy-property-${p.slug}`}
                      className="rpc-tap44"
                      style={{ display: "block", padding: "12px 14px", border: "1px solid var(--rpc-border)", borderRadius: 6, textDecoration: "none", color: "inherit", height: "100%" }}
                    >
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
                        {p.name}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                        {[p.category && p.category !== p.name ? p.category : null, seasons].filter(Boolean).join(" · ") || "—"}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)", marginTop: 8, lineHeight: 1.7 }}>
                        {fmtCount(p.collections)} {p.collections === 1 ? "collection" : "collections"} · {fmtCount(p.cards)} cards
                        <br />
                        {p.sales_90d > 0
                          ? `${fmtCount(p.sales_90d)} sales in 90 days${p.sales_90d_volume_usd ? ` · ${fmtUsd(p.sales_90d_volume_usd)}` : ""}`
                          : "no sale on record in 90 days"}
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      {unplaced > 0 ? (
        <div className="rpc-mono" data-testid="candy-property-unplaced" style={{ marginTop: 12, fontSize: 11, color: "var(--rpc-text-muted)" }}>
          {fmtCount(unplaced)} more {unplaced === 1 ? "collection is" : "collections are"} not placed under a brand yet.
        </div>
      ) : null}
    </section>
  )
}

/** Server wrapper: a failed read renders nothing. */
export default async function CandyPropertyGrid({ collection }: { collection: string }) {
  const res = await fetchCandyPropertyBoard()
  if (!res.ok) return null
  return <CandyPropertyGridView collection={collection} properties={res.board.properties} unplaced={res.board.unplacedCollections} />
}
