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
import type { PaniniProduct, PaniniProductMarketCap, PaniniProductPlayer, PaniniProductRead } from "@/lib/panini/product"
import { fmtUsdCompact } from "@/lib/insights/market-cap-format"
import { slugifyPlayerName } from "@/lib/entity-labels"
import type { PaniniProductPack } from "@/lib/panini/edition-extras"
import { paniniSportLabel } from "@/lib/panini/sport-label"

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
  topPlayers,
  marketCap,
  property = null,
}: {
  collection: string
  collectionLabel: string
  product: PaniniProduct
  packs: { packs: PaniniProductPack[] | null; productName: string | null }
  /** Top Players (2026-11-23, Top Shot's "Top Players in this Series"); absent = not read (older callers). */
  topPlayers?: { ok: boolean; players: PaniniProductPlayer[] }
  /** Market cap (2026-11-23, the series page's tile); absent = not read. */
  marketCap?: { ok: boolean; cap: PaniniProductMarketCap | null }
  /** The league / brand this product is made under (2026-11-26) — a breadcrumb step; absent = not read or unplaced. */
  property?: { name: string; href: string; subjects?: string } | null
}) {
  const unpriced = p.editions - p.priced_editions
  return (
    <div data-testid="panini-product">
      <Breadcrumbs items={[{ name: collectionLabel, href: `/${collection}/overview` }, { name: "Products", href: `/${collection}/product` }, ...(property ? [{ name: property.name, href: property.href }] : []), { name: p.name }]} />

      <header style={{ marginTop: 8 }}>
        <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
          Panini product{p.sport ? ` · ${paniniSportLabel(p.sport)}` : ""}
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(24px, 5vw, 40px)", letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "4px 0 6px" }}>
          {p.name}
        </h1>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {fmtCount(p.editions)} editions seen · {fmtCount(p.players)} {(property?.subjects ?? "Players").toLowerCase()} · {fmtCount(p.sets)} sets
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

      {marketCap && (!marketCap.ok || marketCap.cap) && <PaniniProductMarketCapTile res={marketCap} />}

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

      {/* Top Players (2026-11-23, Panini parity pass 2): the series page's "Top Players in this Series" — per player,
          editions RPC has seen in this product and their FMV total (unpriced editions counted, never summed as $0).
          A failed read says so; a product whose cards carry no player hides the section. */}
      {topPlayers && (!topPlayers.ok || topPlayers.players.length > 0) && (
        <Section title={`Top ${property?.subjects ?? "Players"} in this Product`}>
          {!topPlayers.ok ? (
            <div className="rpc-mono" data-testid="panini-product-players-unavailable" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
              This list couldn&rsquo;t load right now.
            </div>
          ) : (
            <div data-testid="panini-product-players" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
              {topPlayers.players.map((pl) => (
                <Link
                  key={pl.player_name}
                  href={`/${collection}/player/${encodeURIComponent(slugifyPlayerName(pl.player_name))}`}
                  className="rpc-card"
                  style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
                >
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{pl.player_name}</div>
                  <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                    {fmtCount(pl.editions)} edition{pl.editions === 1 ? "" : "s"} · {pl.fmv_total_usd != null ? fmtUsd(pl.fmv_total_usd) : "no FMV yet"}
                    {pl.fmv_total_usd != null && pl.priced_editions < pl.editions ? ` (${fmtCount(pl.priced_editions)} priced)` : ""}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>
      )}

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

/**
 * The product's Market Cap (2026-11-23, Panini parity pass 3) — Top Shot's series-page tile for a Panini product:
 * the sum of its editions' market caps (collector-held × FMV; burned and issuer-held stock out), from the same rows
 * every Panini edition page's tile shows. Coverage is said when not every edition has a price or a supply split
 * (never summed as $0). No rank: products are not ranked anywhere, so the tile does not claim one.
 */
export function PaniniProductMarketCapTile({ res }: { res: { ok: boolean; cap: PaniniProductMarketCap | null } }) {
  if (!res.ok) {
    return (
      <Section title="Market Cap">
        <div className="rpc-mono" data-testid="panini-product-mcap-unavailable" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
          The market cap couldn&rsquo;t load right now.
        </div>
      </Section>
    )
  }
  const c = res.cap
  if (!c) return null
  const unpriced = c.editions - c.editions_priced
  const partialSupply = c.editions_supply_known < c.editions
  return (
    <Section title="Market Cap">
      <div data-testid="panini-product-mcap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <StatCell
          label="Market Cap"
          value={c.mcap_usd != null ? fmtUsdCompact(c.mcap_usd) : "Unknown"}
          sub={c.mcap_usd != null ? "collector-held × FMV" : c.mcap_minted_usd != null ? `≤ ${fmtUsdCompact(c.mcap_minted_usd)} on minted supply` : "no priced edition yet"}
        />
        <StatCell
          label="Collector-held"
          value={c.editions_supply_known === 0 || c.collector_held == null ? "—" : fmtCount(c.collector_held)}
          // 2026-11-25: collector_held covers only editions with a known split, so its "of N minted" is the minted
          // supply of THOSE editions (minted_supply_known), never every edition's — two populations understated it.
          sub={
            c.editions_supply_known === 0
              ? "holder split not known yet"
              : c.minted_supply_known != null
                ? partialSupply
                  ? `of ${fmtCount(c.minted_supply_known)} minted on the ${fmtCount(c.editions_supply_known)} editions with a known split`
                  : `of ${fmtCount(c.minted_supply_known)} minted`
                : undefined
          }
        />
        <StatCell label="Burned" value={c.burned != null ? fmtCount(c.burned) : "—"} sub={c.issuer_held != null ? `${fmtCount(c.issuer_held)} still with Panini` : undefined} />
      </div>
      {c.stale && (
        <div className="rpc-mono" role="status" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5, color: "var(--rpc-red-text)" }}>
          {c.stale === "unknown"
            ? "When these figures were computed is not recorded — treat them as possibly out of date."
            : `These figures are from ${c.stale} — the market-cap refresh is behind, so they may be out of date.`}
        </div>
      )}
      <div className="rpc-mono" data-testid="panini-product-mcap-note" style={{ marginTop: 10, fontSize: 10, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
        The sum of this product&rsquo;s edition market caps — FMV × collector-held supply, burned cards and Panini&rsquo;s unopened stock taken out.
        {unpriced > 0 ? ` ${fmtCount(unpriced)} of ${fmtCount(c.editions)} editions have no price yet and are not in it.` : ""}
        {partialSupply ? ` ${fmtCount(c.editions - c.editions_supply_known)} editions have no supply split yet.` : ""}{" "}
        <Link href="/insights/market-cap" style={{ color: "var(--rpc-text-secondary)", textDecoration: "underline", textUnderlineOffset: 3 }}>All market caps →</Link>
      </div>
    </Section>
  )
}
