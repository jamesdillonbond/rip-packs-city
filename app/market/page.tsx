// app/market/page.tsx
//
// The Market HUB — the bottom bar's MARKET tab lands here (2026-09-28, Trevor).
// Same reasoning as /sniper: the tab used to open `/{last-visited collection}/
// market`, a choice the visitor never saw, and rendered INERT on a collection
// with no market (UFC). The hub is one fixed destination that exists for everyone:
//   1. "Back to <X> Market" for a returning collector (recorded collection only);
//   2. one tile per published collection with a market page, carrying its 24 h
//      sales and volume (lib/market/hub.ts — read its header for the ZERO rule);
//   3. the week's biggest sales across collections (the /insights/top-sales read).
//
// ⚠ Every number here has three states: failed/absent → no number (never $0);
// a count → the count; zero → zero WITH the last recorded sale, because a zero
// cannot tell a quiet market from a stalled feed (Golazos, 16 days, 2026-09-28).

import type { Metadata } from "next"
import Link from "next/link"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import SiteFooter from "@/components/SiteFooter"
import LastCollectionShortcut from "@/components/hub/LastCollectionShortcut"
import { publishedCollections, fromDbSlug } from "@/lib/collections"
import { isMarketClosed } from "@/lib/market-closed"
import { fetchMarketTileStats } from "@/lib/market/hub"
import { fetchTopSales, type TopSaleRow } from "@/lib/insights/top-sales"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { formatAsOfPt } from "@/lib/sniper/hub"
import { fmtUsdWhole1000 as usd } from "@/lib/usd-format"
import { OG_INHERITED } from "@/lib/seo"

// Five minutes, like /sniper. The pulse RPC is ~0.6 s; this keeps it off the
// per-request path.
export const revalidate = 300

const TOP_SALES_N = 8

export function generateMetadata(): Metadata {
  return {
    title: "Market — Flow Collectibles Sales & Volume by Collection",
    alternates: { canonical: "https://www.rippackscity.com/market" },
    description:
      "24-hour sales and volume for every Flow collection RPC tracks — NBA Top Shot, NFL All Day, Disney Pinnacle and more — plus the week's biggest sales.",
    openGraph: {
      ...OG_INHERITED,
      title: "Market — Rip Packs City",
      description: "Sales and volume by collection, and the week's biggest sales.",
    },
  }
}

async function readTopSales(): Promise<{ ok: boolean; rows: TopSaleRow[] }> {
  try {
    const { rows } = await withBoardBudget(
      fetchTopSales({ collection: null, window: "7d", sort: "price", limit: TOP_SALES_N }),
      "market-hub-top-sales",
      undefined,
      "market/",
    )
    return { ok: true, rows }
  } catch (e) {
    console.error("[market/hub] top sales", e instanceof Error ? e.message : e)
    return { ok: false, rows: [] }
  }
}

/** The edition page for a sale, scoped by its collection. null when it cannot be built. */
function saleHref(r: TopSaleRow): string | null {
  const slug = r.collection ? fromDbSlug(r.collection) : null
  if (!slug || !r.external_id) return null
  return `/${slug}/edition/${encodeURIComponent(r.external_id)}`
}

const shortDatePt = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })

export default async function MarketHubPage() {
  const tiles = publishedCollections().filter((c) => c.pages.includes("market"))
  const [{ pulseOk, stats }, sales] = await Promise.all([
    fetchMarketTileStats(tiles.map((c) => c.id)),
    readTopSales(),
  ])

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <GlobalSiteHeader />
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 16px 96px", display: "flex", flexDirection: "column", gap: 28 }}>
        <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={h1Style}>Market</h1>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--rpc-text-secondary)" }}>
            What&apos;s trading across collections today. Open a collection&apos;s market to sort and filter every listing.
          </p>
        </header>

        <LastCollectionShortcut page="market" label="Market" />

        <section aria-labelledby="market-hub-collections">
          <h2 id="market-hub-collections" style={sectionTitle}>
            Last 24 hours by collection
          </h2>
          {!pulseOk ? (
            <p data-testid="market-hub-pulse-unavailable" style={{ ...noticeStyle, marginBottom: 8 }}>
              Sales and volume couldn&apos;t be loaded right now. Every collection&apos;s market below still works.
            </p>
          ) : null}
          <div className="rpc-market-hub-tiles">
            {tiles.map((c) => {
              const s = stats.get(c.id)
              const closed = isMarketClosed(c.id)
              return (
                <Link key={c.id} href={`/${c.id}/market`} data-testid={`market-tile-${c.id}`} style={{ ...tileStyle, borderLeft: `3px solid ${c.accent}` }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span aria-hidden="true" style={{ fontSize: 20 }}>{c.icon}</span>
                    <span style={tileTitle}>{c.shortLabel}</span>
                    <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--rpc-text-muted)" }}>→</span>
                  </span>
                  {closed ? (
                    <span className="rpc-mono" style={tileMeta}>Market closed</span>
                  ) : s ? (
                    s.sales24h > 0 ? (
                      <span className="rpc-mono" style={tileMeta}>
                        {s.sales24h.toLocaleString("en-US")} sales · {usd(s.volume24h)} volume
                        {s.topSale24h != null ? ` · top ${usd(s.topSale24h)}` : ""}
                      </span>
                    ) : (
                      <span className="rpc-mono" style={tileMeta} data-testid={`market-tile-zero-${c.id}`}>
                        No sales recorded in 24h
                        {s.lastSaleAt ? ` · last ${shortDatePt(s.lastSaleAt)}` : " · none in 120 days"}
                      </span>
                    )
                  ) : (
                    <span className="rpc-mono" style={tileMeta}>Open market</span>
                  )}
                </Link>
              )
            })}
          </div>
        </section>

        <section aria-labelledby="market-hub-top-sales">
          <h2 id="market-hub-top-sales" style={sectionTitle}>
            Biggest sales this week
          </h2>
          {!sales.ok ? (
            <p data-testid="market-hub-sales-unavailable" style={noticeStyle}>
              Top sales couldn&apos;t be loaded right now.
            </p>
          ) : sales.rows.length === 0 ? (
            <p data-testid="market-hub-sales-empty" style={noticeStyle}>
              No sales recorded in the last 7 days.
            </p>
          ) : (
            <ol data-testid="market-hub-sales" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {sales.rows.map((r) => {
                const href = saleHref(r)
                const collectionLabel = r.collection ? publishedCollections().find((c) => c.id === fromDbSlug(r.collection!))?.shortLabel : null
                const body = (
                  <>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.player_name || r.set_name || "Unnamed"}
                      </span>
                      <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[collectionLabel, r.set_name, r.tier, r.serial_number ? `#${r.serial_number}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{usd(r.price_usd)}</span>
                      {r.sold_at ? (
                        <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                          {formatAsOfPt(r.sold_at)}
                        </span>
                      ) : null}
                    </span>
                  </>
                )
                return (
                  <li key={r.sale_id}>
                    {href ? (
                      <Link href={href} style={rowStyle}>{body}</Link>
                    ) : (
                      <div style={rowStyle}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          <Link
            href="/insights/top-sales"
            className="rpc-mono"
            style={{ display: "inline-flex", alignItems: "center", minHeight: 44, marginTop: 8, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-secondary)" }}
          >
            All top sales →
          </Link>
        </section>
      </main>
      <SiteFooter />
      <style>{`
        .rpc-market-hub-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
        @media (max-width: 480px) { .rpc-market-hub-tiles { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  )
}

const h1Style: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: "clamp(30px, 7vw, 44px)",
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  lineHeight: 1.05,
  margin: 0,
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

const tileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minHeight: 64,
  padding: "10px 14px",
  borderRadius: 8,
  background: "var(--rpc-surface-raised)",
  color: "var(--rpc-text-primary)",
  textDecoration: "none",
}

const tileTitle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 700,
  fontSize: 15,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
}

const tileMeta: React.CSSProperties = { fontSize: 11, color: "var(--rpc-text-secondary)" }

const rowStyle: React.CSSProperties = {
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
