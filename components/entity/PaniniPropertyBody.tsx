// components/entity/PaniniPropertyBody.tsx
//
// One league / brand a Panini product is made under (/panini-blockchain/property/<slug>, 2026-11-26):
// its products by season, most valuable cards, biggest sales and who is on the cards. Pure props; data is
// lib/panini/properties.ts (get_panini_property_page). ⛔ The word "property" never renders — the eyebrow says
// "League" or "Entertainment". Counts are editions RPC has SEEN; sales are those ON RECORD and lag. No FMV tier.

import Link from "next/link"
import type { CSSProperties } from "react"
import { Section, StatCell, fmtUsd, fmtCount, relTime } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { slugifyPlayerName } from "@/lib/entity-labels"
import { serialLabelOfSku } from "@/lib/panini/product-url"
import { paniniSubjectIsPlayer } from "@/lib/panini/subjects"
import { seasonSpan, subjectPlural, type PaniniPropertyGroups, type PaniniPropertyPage } from "@/lib/panini/properties"
import { groupPlural } from "@/lib/property-words"
import PaniniPropertyProducts from "@/components/entity/PaniniPropertyProducts"

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }
const sub: CSSProperties = { marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }

const editionHref = (collection: string, externalId: string) => `/${collection}/edition/${encodeURIComponent(externalId)}`

export function PaniniPropertyUnavailable({ collection }: { collection: string }) {
  return (
    <section data-testid="panini-property-unavailable" style={{ padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
        Couldn&rsquo;t load this page
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, margin: "12px auto 0", lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time. This is a problem on our side &mdash; it does not mean the cards are gone. Reloading often works.
      </p>
      <Link href={`/${collection}/product`} className="rpc-mono" style={{ display: "inline-block", marginTop: 16, color: "var(--rpc-red-text)" }}>
        Browse Panini products →
      </Link>
    </section>
  )
}

export default function PaniniPropertyBody({
  collection,
  collectionLabel,
  page: p,
  groups = null,
}: {
  collection: string
  collectionLabel: string
  page: PaniniPropertyPage
  /** Teams / nations / clubs / clans (optional read; null = unavailable or none — the section is left out). */
  groups?: PaniniPropertyGroups | null
}) {
  const unpriced = p.editions - p.priced_editions
  const seasons = seasonSpan(p)
  const subjects = subjectPlural(p.subject_word)
  // A grouping section only when the league has a group word and at least two groups to compare.
  const groupTitle = groups && groups.groups.length >= 2 ? groupPlural(groups.group_word) : null
  return (
    <div data-testid="panini-property">
      <Breadcrumbs items={[{ name: collectionLabel, href: `/${collection}/overview` }, { name: "Products", href: `/${collection}/product` }, { name: p.name }]} />

      <header style={{ marginTop: 8 }}>
        <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
          Panini · {p.heading === "entertainment" ? "Entertainment" : "League"}
          {p.category && p.category !== p.name && p.category !== "Entertainment" ? ` · ${p.category}` : ""}
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(24px, 5vw, 40px)", letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "4px 0 6px" }}>
          Panini {p.name} cards
        </h1>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {fmtCount(p.products.length)} {p.products.length === 1 ? "product" : "products"}
          {seasons ? ` · ${seasons}` : ""} · {fmtCount(p.editions)} cards seen
          {p.computed_at ? ` · updated ${relTime(p.computed_at)}` : ""}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
        <StatCell
          label="FMV total"
          value={fmtUsd(p.fmv_total_usd)}
          sub={unpriced > 0 ? `${fmtCount(p.priced_editions)} priced · ${fmtCount(unpriced)} unpriced` : `${fmtCount(p.priced_editions)} cards priced`}
        />
        <StatCell label="Listed now" value={fmtCount(p.listed_editions)} sub="cards with an ask re-read in 7 days" />
        <StatCell label="Cheapest ask" value={fmtUsd(p.cheapest_ask_usd)} sub="lowest confirmed ask, any card" />
        <StatCell
          label="Sales · 30 days"
          value={fmtCount(p.sales_30d)}
          sub={p.sales_30d > 0 ? `on record · ${fmtUsd(p.sales_30d_volume_usd)}` : "none on record yet"}
        />
      </div>
      <div className="rpc-mono" data-testid="panini-property-sales-lag" style={{ marginTop: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>
        Panini sales reach RPC hours to days after they happen, so the newest days are not complete.
        {p.newest_sale_at ? ` Newest sale on record: ${relTime(p.newest_sale_at)}.` : ""}
      </div>

      <div style={{ marginTop: 14 }}>
        <PaniniCoverageNote coverage={null} />
      </div>

      <Section title="Products">
        <div className="rpc-mono" style={sub}>Every {p.name} product RPC has seen a card from, newest season first.</div>
        <PaniniPropertyProducts collection={collection} products={p.products} />
      </Section>

      {groups && groupTitle ? (
        <Section title={groupTitle}>
          <div className="rpc-mono" data-testid="panini-property-groups-note" style={sub}>
            By the FMV total of their cards. {fmtCount(groups.editions_named)} of {fmtCount(groups.editions_total)} {p.name} cards name {groupTitle === "Teams" ? "a team" : groupTitle === "Nations" ? "a nation" : groupTitle === "Clubs" ? "a club" : groupTitle === "Clans" ? "a clan" : "a school"}
            {groups.editions_named < groups.editions_total ? "; the rest are not counted here." : "."}
            {groups.groups_total > groups.groups.length ? ` Top ${fmtCount(groups.groups.length)} of ${fmtCount(groups.groups_total)}.` : ""}
          </div>
          <div data-testid="panini-property-groups" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {groups.groups.map((g) => (
              <div key={g.name} className="rpc-card" style={{ padding: 12 }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{g.name}</div>
                <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  {fmtCount(g.editions)} card{g.editions === 1 ? "" : "s"} · {g.fmv_total_usd != null ? fmtUsd(g.fmv_total_usd) : "no FMV yet"}
                  {g.fmv_total_usd != null && g.priced_editions < g.editions ? ` (${fmtCount(g.priced_editions)} priced)` : ""}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {p.top_subjects.length > 0 && (
        <Section title={`Top ${subjects}`}>
          <div className="rpc-mono" style={sub}>By the FMV total of their cards across every {p.name} product. Unpriced cards are counted, never summed as $0.</div>
          <div data-testid="panini-property-subjects" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {p.top_subjects.map((pl) => {
              const body = (
                <>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{pl.player_name}</div>
                  <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                    {fmtCount(pl.editions)} card{pl.editions === 1 ? "" : "s"} · {pl.fmv_total_usd != null ? fmtUsd(pl.fmv_total_usd) : "no FMV yet"}
                    {pl.fmv_total_usd != null && pl.priced_editions < pl.editions ? ` (${fmtCount(pl.priced_editions)} priced)` : ""}
                  </div>
                </>
              )
              return paniniSubjectIsPlayer(pl.player_name, null) ? (
                <Link
                  key={pl.player_name}
                  prefetch={false}
                  href={`/${collection}/player/${encodeURIComponent(slugifyPlayerName(pl.player_name))}`}
                  className="rpc-card"
                  style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
                >
                  {body}
                </Link>
              ) : (
                <div key={pl.player_name} className="rpc-card" style={{ padding: 12 }}>{body}</div>
              )
            })}
          </div>
        </Section>
      )}

      <Section title="Most Valuable Cards">
        <div className="rpc-mono" style={sub}>Highest FMV among the cards RPC has priced.</div>
        {p.top_editions.length === 0 ? (
          <div className="rpc-mono" data-testid="panini-property-no-priced" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>No {p.name} card is priced yet.</div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Most valuable cards")}>
            <table data-testid="panini-property-top-editions" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
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
                      <Link prefetch={false} href={editionHref(collection, e.external_id)} style={{ color: "inherit" }}>{e.player_name ?? e.external_id}</Link>
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
          <div className="rpc-mono" data-testid="panini-property-no-sales" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
            No {p.name} sale is on record for the last 90 days.
          </div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Top sales in 90 days")}>
            <table data-testid="panini-property-top-sales" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
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
                      <Link prefetch={false} href={editionHref(collection, s.external_id)} style={{ color: "inherit" }}>
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

      <Section title="More">
        <div className="rpc-mono" style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12 }}>
          <Link href={`/${collection}/market`} style={{ color: "var(--rpc-text-primary)" }}>Panini market →</Link>
          <Link href={`/${collection}/packs`} style={{ color: "var(--rpc-text-primary)" }}>Packs →</Link>
          <Link href="/insights/panini-squeeze" style={{ color: "var(--rpc-text-primary)" }}>Panini boards →</Link>
          {p.team_league ? (
            <Link href="/teams" data-testid="panini-property-teams" style={{ color: "var(--rpc-text-primary)" }}>{p.name} team hubs →</Link>
          ) : null}
          <Link href={`/${collection}/product`} style={{ color: "var(--rpc-text-primary)" }}>All Panini products →</Link>
          <Link href="/leagues" style={{ color: "var(--rpc-text-primary)" }}>All leagues and brands →</Link>
        </div>
      </Section>
    </div>
  )
}
