// app/sniper/page.tsx
//
// The Sniper HUB — the bottom bar's SNIPER tab lands here (2026-09-28, Trevor).
// Before this, the tab went to `/{last-visited collection}/sniper`: a choice the
// visitor never saw, Top Shot for every first-timer, and an inert tab on a
// collection with no sniper. `/sniper` itself was a bare redirect to Top Shot's.
//
// The hub is one fixed, collection-agnostic destination:
//   1. a "Back to <X> Sniper" shortcut for a returning collector (client island,
//      shown only when a last collection was actually recorded — never a
//      default, never a redirect);
//   2. one tile per published collection that HAS a sniper page → the full tool;
//   3. the biggest discounts right now, across collections, from the SAME cached
//      read /insights/deals serves (`readBoardOrLive("deals", fetchDealsDefault)`)
//      — no second copy of the query.
//
// ⚠ THREE STATES for the deals list, never two (CLAUDE.md honesty rule): the
// read failed → "unavailable", never "no deals"; the read succeeded and is empty
// → the one place "nothing 10%+ below FMV right now" may be said; rows → rows.
// ⚠ NO PER-COLLECTION COUNTS ON THE TILES: the board read is capped at the top
// 200 by discount, so a count from it is a CAP, not a census of each collection.

import type { Metadata } from "next"
import Link from "next/link"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import SiteFooter from "@/components/SiteFooter"
import LastCollectionShortcut from "@/components/hub/LastCollectionShortcut"
import { publishedCollections } from "@/lib/collections"
import { readBoardOrLive } from "@/lib/insights/board-cache"
import { fetchDealsDefault } from "@/lib/insights/boards"
import { OG_INHERITED } from "@/lib/seo"
import { formatAsOfPt, pickHubDeals, type SniperDealRow } from "@/lib/sniper/hub"
import { fmtUsdWhole1000 as usd } from "@/lib/usd-format"

// Match /insights/deals and its API route's 5-minute edge cache.
export const revalidate = 300

export function generateMetadata(): Metadata {
  return {
    title: "Sniper — Deals Below FMV Across Every Collection",
    alternates: { canonical: "https://www.rippackscity.com/sniper" },
    description:
      "The biggest discounts below fair market value right now across Flow collectibles, and a sniper for each collection — NBA Top Shot, NFL All Day, Disney Pinnacle and more.",
    openGraph: {
      ...OG_INHERITED,
      title: "Sniper — Rip Packs City",
      description: "Live deals below FMV across every collection RPC prices.",
    },
  }
}

export default async function SniperHubPage() {
  const { payload, source } = await readBoardOrLive("deals", () => fetchDealsDefault())
  const readFailed = source === "live-degraded"
  const rows = readFailed ? [] : pickHubDeals(((payload.rows as SniperDealRow[]) ?? []))
  const asOf = formatAsOfPt((payload.data_as_of as string | null) ?? null)
  const tiles = publishedCollections().filter((c) => c.pages.includes("sniper"))

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <GlobalSiteHeader />
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 16px 96px", display: "flex", flexDirection: "column", gap: 28 }}>
        <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: "clamp(30px, 7vw, 44px)",
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              lineHeight: 1.05,
              margin: 0,
            }}
          >
            Sniper
          </h1>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--rpc-text-secondary)" }}>
            Listings priced below fair market value. Start with the biggest discounts across collections, or open a
            collection&apos;s sniper for every filter.
          </p>
        </header>

        <LastCollectionShortcut page="sniper" label="Sniper" />

        <section aria-labelledby="sniper-hub-collections">
          <h2 id="sniper-hub-collections" style={sectionTitle}>
            Pick a collection
          </h2>
          <div className="rpc-sniper-hub-tiles">
            {tiles.map((c) => (
              <Link
                key={c.id}
                href={`/${c.id}/sniper`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 0,
                  minHeight: 56,
                  padding: "10px 14px",
                  borderRadius: 8,
                  borderLeft: `3px solid ${c.accent}`,
                  background: "var(--rpc-surface-raised)",
                  color: "var(--rpc-text-primary)",
                  textDecoration: "none",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 20 }}>{c.icon}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.shortLabel}</span>
                <span aria-hidden="true" style={{ color: "var(--rpc-text-muted)" }}>→</span>
              </Link>
            ))}
          </div>
        </section>

        <section aria-labelledby="sniper-hub-deals">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h2 id="sniper-hub-deals" style={sectionTitle}>
              Biggest discounts right now
            </h2>
            {!readFailed && asOf ? (
              <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
                Prices as of {asOf}
              </span>
            ) : null}
          </div>

          {readFailed ? (
            <p data-testid="sniper-hub-unavailable" style={noticeStyle}>
              Deals couldn&apos;t be loaded right now. Each collection&apos;s sniper above still works.
            </p>
          ) : rows.length === 0 ? (
            <p data-testid="sniper-hub-empty" style={noticeStyle}>
              No listing is 10% or more below its FMV right now.
            </p>
          ) : (
            <ol data-testid="sniper-hub-deals" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {rows.map((r, i) => {
                const title = r.player_name || r.name || "Unnamed"
                const body = (
                  <>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {title}
                      </span>
                      <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[r.collection_name, r.set_name, r.tier].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                      <span style={{ fontWeight: 800, color: "var(--rpc-red)", fontSize: 14 }}>
                        −{Math.round(r.discount_pct ?? 0)}%
                      </span>
                      <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                        {usd(r.low_ask)} · FMV {usd(r.fmv_usd)}
                      </span>
                    </span>
                  </>
                )
                return (
                  <li key={(r.external_id ?? "") + ":" + i}>
                    {r.detail_url ? (
                      <Link href={r.detail_url} style={dealRowStyle}>
                        {body}
                      </Link>
                    ) : (
                      <div style={dealRowStyle}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}

          <Link
            href="/insights/deals"
            className="rpc-mono"
            style={{ display: "inline-flex", alignItems: "center", minHeight: 44, marginTop: 8, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-secondary)" }}
          >
            The full Below FMV board →
          </Link>
        </section>
      </main>
      <SiteFooter />
      <style>{`
        .rpc-sniper-hub-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
        /* minmax(0, …) — a bare 1fr track cannot shrink below its content's
           min width, and at 320 px the two tiles forced the layout viewport to
           374 px (measured 2026-09-28, the 320 px mobile sweep). */
        @media (max-width: 480px) { .rpc-sniper-hub-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        /* Below 360 px two columns only fit by truncating names to "TO…" —
           stack them instead. */
        @media (max-width: 360px) { .rpc-sniper-hub-tiles { grid-template-columns: minmax(0, 1fr); } }
      `}</style>
    </div>
  )
}

const sectionTitle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 13,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  margin: "0 0 10px",
}

const noticeStyle: React.CSSProperties = {
  margin: 0,
  padding: "14px 16px",
  borderRadius: 8,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-surface)",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--rpc-text-secondary)",
}

const dealRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 56,
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-surface)",
  color: "var(--rpc-text-primary)",
  textDecoration: "none",
}
