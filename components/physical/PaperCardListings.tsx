// components/physical/PaperCardListings.tsx
//
// "Paper cards on eBay" — active eBay listings for a player (prototype, NOT
// mounted). Stage 0 of the physical-cards route: answers the "<player> buy"
// searches the player pages already rank for, WITHOUT RPC claiming a value.
//
// Rules this module keeps:
//  - Renders nothing unless lib/physical/ebay-listings-server says "ok" with at
//    least one listing. Off, failed or empty → no section (it makes no claim a
//    reader depends on, so silence is honest; see SectionUnavailable for the
//    sections where it is not).
//  - Prices are labelled as ASKING prices. They are never mixed into RPC FMV,
//    sales or any total, and sit in their own section (eBay's display rule:
//    eBay content kept visually separate from non-eBay content).
//  - Affiliate links are disclosed in plain words and carry rel="sponsored".
//
// Mount (when approved) on the multi-collection player HUBS only (2,368
// indexable, 2026-11-22) — not the per-collection player pages — after the
// collection sections:
//   <Suspense fallback={null}><PaperCardListings name={hub.name} slug={hub.slug} /></Suspense>

import { Section, fmtUsd } from "@/components/entity/_shared"
import type { PaperListingsResult } from "@/lib/physical/ebay-listings-server"
import { getPaperListings } from "@/lib/physical/ebay-listings-cached"

export default async function PaperCardListings({ name, slug }: { name: string; slug: string }) {
  const result = await getPaperListings(name, slug)
  return <PaperCardListingsView name={name} result={result} />
}

export function PaperCardListingsView({ name, result }: { name: string; result: PaperListingsResult }) {
  if (result.status !== "ok" || result.listings.length === 0) return null
  return (
    <Section title={`${name} paper cards on eBay`}>
      <p className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", margin: "0 0 12px", lineHeight: 1.6 }}>
        Live listings from eBay. Prices are what sellers are asking, not RPC values.
        {result.affiliate ? " RPC may earn a commission if you buy through these links." : ""}
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 180px), 1fr))", gap: 12 }}>
        {result.listings.map((l) => (
          <li key={l.itemId} style={{ border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden", background: "var(--rpc-surface)" }}>
            <a
              href={l.href}
              target="_blank"
              rel={l.isAffiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}
              style={{ display: "flex", flexDirection: "column", height: "100%", color: "inherit", textDecoration: "none" }}
            >
              {l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.imageUrl} alt="" loading="lazy" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "contain", background: "rgba(0,0,0,0.4)", display: "block" }} />
              ) : null}
              <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, color: "var(--rpc-text-primary)", lineHeight: 1.35 }}>{l.title}</span>
                <span className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
                  {l.priceUsd != null ? `Asking ${fmtUsd(l.priceUsd)}` : "See price on eBay"}
                  {l.buyingOptions.includes("AUCTION") ? " · Auction" : ""}
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  )
}
