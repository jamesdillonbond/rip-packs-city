// components/entity/CandyPropertyBody.tsx
//
// One league / brand Candy covers (/candy-mlb/property/<slug>, 2026-11-26): MLB, DC, NASCAR, WWE …
// Its collections (grouped — comics, packs, ICONs — where the brand is big), most valuable cards, biggest
// sales and who is on the cards. Pure props; data is lib/candy/properties.ts (get_candy_property_page).
// ⛔ The word "property" never renders — the eyebrow says "League" or "Entertainment". "Cards" is cards in
// circulation per the chain; sales are those ON RECORD. No FMV tier.

import Link from "next/link"
import type { CSSProperties } from "react"
import { Section, StatCell, fmtUsd, fmtCount, relTime } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { slugifyPlayerName } from "@/lib/entity-labels"
import { subjectPlural } from "@/lib/property-words"
import { candySeasonSpan, groupCandyCollections, type CandyPropertyCollection, type CandyPropertyPage } from "@/lib/candy/properties"

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }
const sub: CSSProperties = { marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }
const h3: CSSProperties = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "14px 0 6px" }

const editionHref = (collection: string, externalId: string) => `/${collection}/edition/${encodeURIComponent(externalId)}`
const setHref = (collection: string, setSlug: string) => `/${collection}/set/${encodeURIComponent(setSlug)}`
const anchorOf = (program: string) => program.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

export function CandyPropertyUnavailable({ collection }: { collection: string }) {
  return (
    <section data-testid="candy-property-unavailable" style={{ padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
        Couldn&rsquo;t load this page
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, margin: "12px auto 0", lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time. This is a problem on our side &mdash; it does not mean the cards are gone. Reloading often works.
      </p>
      <Link href={`/${collection}/overview`} className="rpc-mono" style={{ display: "inline-block", marginTop: 16, color: "var(--rpc-red-text)" }}>
        Back to Candy →
      </Link>
    </section>
  )
}

function CollectionRows({ collection, rows }: { collection: string; rows: CandyPropertyCollection[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <tr key={`${r.name}-${i}`}>
          <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
            {r.set_slug ? <Link prefetch={false} href={setHref(collection, r.set_slug)} style={{ color: "inherit" }}>{r.name}</Link> : r.name}
          </td>
          <td style={cell}>{fmtCount(r.cards)}</td>
          <td style={cell}>{r.listed_editions > 0 ? fmtCount(r.listed_editions) : "—"}</td>
          <td style={cell}>{r.sales_90d > 0 ? `${fmtCount(r.sales_90d)}${r.sales_90d_volume_usd ? ` · ${fmtUsd(r.sales_90d_volume_usd)}` : ""}` : "—"}</td>
        </tr>
      ))}
    </>
  )
}

export default function CandyPropertyBody({
  collection,
  collectionLabel,
  page: p,
}: {
  collection: string
  collectionLabel: string
  page: CandyPropertyPage
}) {
  const unpriced = p.editions - p.priced_editions
  const seasons = candySeasonSpan(p)
  const subjects = subjectPlural(p.subject_word)
  const groups = groupCandyCollections(p.collections)
  const grouped = groups.length > 1
  return (
    <div data-testid="candy-property">
      <Breadcrumbs items={[{ name: collectionLabel, href: `/${collection}/overview` }, { name: p.name }]} />

      <header style={{ marginTop: 8 }}>
        <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
          Candy · {p.heading === "entertainment" ? "Entertainment" : "League"}
          {p.category && p.category !== p.name ? ` · ${p.category}` : ""}
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(24px, 5vw, 40px)", letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "4px 0 6px" }}>
          Candy {p.name} cards
        </h1>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {fmtCount(p.collections.length)} {p.collections.length === 1 ? "collection" : "collections"}
          {seasons ? ` · ${seasons}` : ""} · {fmtCount(p.cards)} cards
          {p.computed_at ? ` · updated ${relTime(p.computed_at)}` : ""}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
        <StatCell label="Cards" value={fmtCount(p.cards)} sub="in circulation, per the chain" />
        <StatCell
          label="Priced"
          value={fmtCount(p.priced_editions)}
          sub={unpriced > 0 ? `of ${fmtCount(p.editions)} different cards · ${fmtCount(unpriced)} have no price yet` : `of ${fmtCount(p.editions)} different cards`}
        />
        <StatCell label="Listed now" value={fmtCount(p.listed_editions)} sub="different cards with a live ask" />
        <StatCell
          label="Sales · 90 days"
          value={fmtCount(p.sales_90d)}
          sub={p.sales_90d > 0 ? `on record · ${fmtUsd(p.sales_90d_volume_usd)}` : "none on record"}
        />
      </div>
      {p.newest_sale_at ? (
        <div className="rpc-mono" style={{ marginTop: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>Newest sale on record: {relTime(p.newest_sale_at)}.</div>
      ) : null}

      <Section title="Collections">
        <div className="rpc-mono" style={sub}>
          Every {p.name} collection Candy has published.{grouped ? " Grouped by line; busiest line first." : ""}
        </div>
        {grouped ? (
          <nav aria-label="Lines" className="rpc-mono" data-testid="candy-property-programs" style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, marginBottom: 6 }}>
            {groups.map((g) => (
              <a key={g.program ?? "all"} href={`#${anchorOf(g.program ?? "all")}`} style={{ color: "var(--rpc-text-primary)" }}>
                {g.program ?? "All"} ({fmtCount(g.rows.length)})
              </a>
            ))}
          </nav>
        ) : null}
        {groups.map((g) => (
          <div key={g.program ?? "all"} id={grouped ? anchorOf(g.program ?? "all") : undefined} style={{ scrollMarginTop: 80 }}>
            {grouped ? <h3 style={h3}>{g.program}</h3> : null}
            <div className="rpc-scroll-x" {...scrollRegion("Collections")}>
              <table data-testid="candy-property-collections" style={{ borderCollapse: "collapse", width: "100%", minWidth: 460 }}>
                <thead>
                  <tr>
                    <th scope="col" style={head}>Collection</th>
                    <th scope="col" style={head}>Cards</th>
                    <th scope="col" style={head}>Listed</th>
                    <th scope="col" style={head}>Sales 90d</th>
                  </tr>
                </thead>
                <tbody>
                  <CollectionRows collection={collection} rows={g.rows} />
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Section>

      {p.top_subjects.length > 0 && (
        <Section title={`Top ${subjects}`}>
          <div className="rpc-mono" style={sub}>By how many different {p.name} cards they are on.</div>
          <div data-testid="candy-property-subjects" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {p.top_subjects.map((pl) => (
              <Link
                key={pl.player_name}
                prefetch={false}
                href={`/${collection}/player/${encodeURIComponent(slugifyPlayerName(pl.player_name))}`}
                className="rpc-card"
                style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
              >
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{pl.player_name}</div>
                <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  {fmtCount(pl.editions)} card{pl.editions === 1 ? "" : "s"} · {fmtCount(pl.priced_editions)} priced
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Most Valuable Cards">
        <div className="rpc-mono" style={sub}>Highest FMV among the cards RPC has priced.</div>
        {p.top_editions.length === 0 ? (
          <div className="rpc-mono" data-testid="candy-property-no-priced" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>No {p.name} card is priced yet.</div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Most valuable cards")}>
            <table data-testid="candy-property-top-editions" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Card</th>
                  <th scope="col" style={head}>Collection</th>
                  <th scope="col" style={head}>Made</th>
                  <th scope="col" style={head}>FMV</th>
                </tr>
              </thead>
              <tbody>
                {p.top_editions.map((e) => (
                  <tr key={e.external_id}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      <Link prefetch={false} href={editionHref(collection, e.external_id)} style={{ color: "inherit" }}>{e.player_name ?? e.name ?? e.external_id}</Link>
                    </td>
                    <td style={cell}>{e.set_name ?? "—"}</td>
                    <td style={cell}>{e.circulation_count ? fmtCount(e.circulation_count) : "—"}</td>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>{fmtUsd(e.fmv_usd)}</td>
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
          <div className="rpc-mono" data-testid="candy-property-no-sales" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
            No {p.name} sale is on record for the last 90 days.
          </div>
        ) : (
          <div className="rpc-scroll-x" {...scrollRegion("Top sales in 90 days")}>
            <table data-testid="candy-property-top-sales" style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Card</th>
                  <th scope="col" style={head}>Collection</th>
                  <th scope="col" style={head}>Sold for</th>
                  <th scope="col" style={head}>When</th>
                </tr>
              </thead>
              <tbody>
                {p.top_sales_90d.map((s, i) => (
                  <tr key={`${s.external_id}-${s.sold_at}-${i}`}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      <Link prefetch={false} href={editionHref(collection, s.external_id)} style={{ color: "inherit" }}>
                        {s.player_name ?? s.name ?? s.external_id}
                        {s.serial_number ? ` #${s.serial_number}` : ""}
                      </Link>
                    </td>
                    <td style={cell}>{s.set_name ?? "—"}</td>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>{fmtUsd(s.price_usd)}</td>
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
          <Link href={`/${collection}/market`} style={{ color: "var(--rpc-text-primary)" }}>Candy market →</Link>
          <Link href={`/${collection}/packs`} style={{ color: "var(--rpc-text-primary)" }}>Packs →</Link>
          {p.team_league ? (
            <Link href="/teams" data-testid="candy-property-teams" style={{ color: "var(--rpc-text-primary)" }}>{p.name} team hubs →</Link>
          ) : null}
          <Link href={`/${collection}/overview`} style={{ color: "var(--rpc-text-primary)" }}>Everything Candy covers →</Link>
        </div>
      </Section>
    </div>
  )
}
