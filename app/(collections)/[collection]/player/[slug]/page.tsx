// app/(collections)/[collection]/player/[slug]/page.tsx
// Phase 1D. Player (or Character on Pinnacle) detail page.
//
// Data: get_player_detail(collection_id, player_slug) +
// get_player_editions(collection_id, player_slug, 200, 0).
// Pinnacle: is_character flips labels Player→Character, Team→Franchise.

import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw } from "@/lib/entity-detail-gate"
import { sectionRows, structuralSection } from "@/lib/entity-section-rpc"
import { playerPageMetadata, playerJsonLd, collectionDisplayName, NOT_FOUND_METADATA } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { getEntityLabels } from "@/lib/entity-labels"
import { Section, SectionUnavailable, StatCell, fmtCount, fmtUsd, relTime } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import { buildPlayerSetCards } from "@/lib/player-page-view"
import { proxyIpfsUrl } from "@/lib/ipfs-media"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface PlayerDetail {
  id: string
  collection_id: string
  collection_slug: string
  player_slug: string
  external_id: string | null
  name: string
  first_name: string | null
  last_name: string | null
  team: string | null
  team_slug: string | null
  jersey_number: number | null
  position: string | null
  player_tier: string | null
  is_active: boolean | null
  headshot_url: string | null
  is_character: boolean | null
  edition_count: number | null
  total_circulation: number | null
  fmv_total_usd: number | null
  floor_total_usd: number | null
  first_minted_at: string | null
  last_minted_at: string | null
}

const PAGE_SIZE = 200

async function fetchDetail(collectionId: string, slug: string): Promise<PlayerDetail | null> {
  // rpcWithRetry (inside fetchEntityDetailRaw): the primary detail fetch retries
  // connection-class errors (incl. "Timed out acquiring connection from
  // connection pool") in-process with backoff before surfacing, so a transient
  // pool blip no longer throws to the error boundary / Sentry on the first miss.
  // cache()'d, so the segment layout's 404 gate + generateMetadata + this render
  // share ONE get_player_detail call. See lib/entity-detail-gate.ts.
  const { data, error } = await fetchEntityDetailRaw("player", collectionId, slug)
  if (error) {
    // Transient RPC failure (statement timeout under contention) must NOT
    // render as not-found — that soft-404s real pages (same class fixed on
    // pack/team 2026-07-14). Throw -> retryable error boundary.
    console.error("[player] detail error", error.message)
    throw new Error(`player detail unavailable: ${error.message}`)
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as PlayerDetail) ?? null
  return data as PlayerDetail
}

// Section fetches go through lib/entity-section-rpc.ts: connection-class errors
// retry before surfacing, and the EDITIONS GRID is structural — if it fails
// after retries we throw a retryable error rather than render a real player with
// a convincingly empty catalogue. The streamed sections below degrade to empty
// and log under `[entity-section]` so the degradation is greppable.
async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  return sectionRows<EditionTile>("player editions", "get_player_editions", { p_collection_id: collectionId, p_player_slug: slug, p_limit: limit, p_offset: offset }, { structural: true })
}

interface PlayerTopSale {
  sale_id: string
  edition_id: string | null
  route_slug: string | null
  player_name: string | null
  edition_name: string | null
  set_name: string | null
  tier: string | null
  thumbnail_url: string | null
  price_usd: number | null
  serial_number: number | null
  sold_at: string | null
  marketplace: string | null
  nft_id: string | null
  source: string | null
  buyer_address: string | null
  seller_address: string | null
  transaction_hash: string | null
}

async function fetchTopSales(collectionId: string, slug: string, limit: number): Promise<PlayerTopSale[]> {
  return sectionRows<PlayerTopSale>("player top sales", "get_player_top_sales", { p_collection_id: collectionId, p_player_slug: slug, p_limit: limit })
}

function TopSalesSkeleton() {
  return (
    <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rpc-card rpc-skeleton" style={{ height: 44 }} />
      ))}
    </div>
  )
}

// Streamed independently (Suspense) so a slow/cold get_player_top_sales never blocks
// or fails the whole player page — it fills in (or shows the empty state) after the
// rest of the page has painted.
async function TopSalesRows({ collection, collectionId, slug }: { collection: string; collectionId: string; slug: string }) {
  const topSales = await fetchTopSales(collectionId, slug, 5)
  return (
    <>
        {topSales.length === 0 ? (
          <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            No recorded sales yet
          </div>
        ) : (
          <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {topSales.map(s => {
              const href = s.route_slug ? `/${collection}/edition/${encodeURIComponent(s.route_slug)}` : null
              const truncAddr = (a: string | null) => {
                if (!a) return "—"
                const lower = a.toLowerCase().startsWith("0x") ? a.toLowerCase() : `0x${a.toLowerCase()}`
                return lower.length > 12 ? `${lower.slice(0, 6)}…${lower.slice(-4)}` : lower
              }
              const inner = (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, auto) 1fr minmax(100px, auto) minmax(110px, auto) minmax(110px, auto) minmax(90px, auto)", gap: 12, padding: "10px 12px", alignItems: "center", minWidth: 560 }}>
                  <span className="rpc-mono" style={{ fontSize: 11, color: s.serial_number != null && s.serial_number > 0 ? "var(--rpc-text-secondary)" : "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
                    {s.serial_number != null && s.serial_number > 0 ? `#${s.serial_number}` : "unresolved"}
                  </span>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.edition_name ?? s.set_name ?? "—"}
                  </span>
                  <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", textAlign: "right" }}>{relTime(s.sold_at)}</span>
                  <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", textAlign: "right" }} title={s.buyer_address ?? undefined}>
                    {truncAddr(s.buyer_address)}
                  </span>
                  <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", textAlign: "right" }} title={s.seller_address ?? undefined}>
                    {truncAddr(s.seller_address)}
                  </span>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", textAlign: "right" }}>{fmtUsd(s.price_usd)}</span>
                </div>
              )
              return href ? (
                <Link key={s.sale_id} href={href} className="rpc-card" style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link>
              ) : (
                <div key={s.sale_id} className="rpc-card">{inner}</div>
              )
            })}
          </div>
        )}
    </>
  )
}

interface RookieCollector {
  wallet_address: string
  username: string | null
  moments_held: number
  est_value_usd: number | null
  rnk: number
}

async function fetchTopCollectors(playerName: string, limit: number): Promise<RookieCollector[]> {
  return sectionRows<RookieCollector>("player top collectors", "get_topshot_rookie_collectors", { p_player_name: playerName, p_limit: limit })
}

// Streamed independently (Suspense) off the rookie ownership index. The index is
// rookie-scoped, so a non-rookie player returns zero rows and the whole section —
// header included — renders nothing. Never blocks or fails the rest of the page.
async function TopCollectorsSection({ playerName }: { playerName: string }) {
  const collectors = await fetchTopCollectors(playerName, 10)
  if (collectors.length === 0) return null
  return (
    <Section title="Top Collectors">
      <div className="rpc-mono" style={{ padding: "0 4px 8px", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
        Based on the indexed on-chain ownership graph · ranked by estimated value of this player&apos;s moments held
      </div>
      <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {collectors.map(c => {
          const lower = c.wallet_address.toLowerCase().startsWith("0x") ? c.wallet_address.toLowerCase() : `0x${c.wallet_address.toLowerCase()}`
          const label = c.username ? `@${c.username}` : (lower.length > 12 ? `${lower.slice(0, 6)}…${lower.slice(-4)}` : lower)
          const inner = (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(38px, auto) 1fr minmax(90px, auto) minmax(110px, auto)", gap: 12, padding: "10px 12px", alignItems: "center", minWidth: 420 }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: c.rnk <= 3 ? "var(--rpc-red)" : "var(--rpc-text-muted)" }}>#{c.rnk}</span>
              <span style={{ fontFamily: c.username ? "var(--font-display)" : "var(--font-mono)", fontWeight: c.username ? 700 : 400, fontSize: c.username ? 14 : 12, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              <span className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", textAlign: "right" }}>{fmtCount(c.moments_held)} <span style={{ color: "var(--rpc-text-muted)" }}>held</span></span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", textAlign: "right" }}>{fmtUsd(c.est_value_usd)}</span>
            </div>
          )
          return (
            <Link key={c.wallet_address} href={`/share/${encodeURIComponent(lower)}`} className="rpc-card" style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link>
          )
        })}
      </div>
    </Section>
  )
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return NOT_FOUND_METADATA
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    // Transient failure: generic non-404 title so crawlers never cache a
    // not-found signal for a real page.
    return { title: { absolute: `${slug.replace(/-/g, " ")} | ${coll.displayName} | Rip Packs City` } }
  }
  if (!detail) return NOT_FOUND_METADATA
  return playerPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PlayerPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // BOUNDED (R19). 2,062 "player detail unavailable: rpc get_player_detail timed
  // out after 45000ms" across 528 distinct users in 7 days. A THROW is not a 404:
  // 404-ing here de-indexes a real player page.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  let detailFailed = false
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    detailFailed = true
  }
  if (detailFailed) return <PlayerUnavailable collection={collection} slug={slug} />
  if (!detail) notFound()

  const labels = getEntityLabels(collection)
  const isCharacter = detail.is_character === true
  // get_player_editions is STRUCTURAL and throws (203 occurrences / 199 users).
  //
  // ⚠ PER-SECTION, NOT PER-PAGE (R19, 2026-08-23). This used to return
  // `PlayerUnavailable`, discarding the hero, the headshot, the team link and
  // every stat the detail row carries — a separate, far cheaper read that
  // routinely succeeds when the editions read does not. The reader keeps all of
  // it now; the grid and the derived set cards each report for themselves.
  const editionsRes = await structuralSection<EditionTile>(
    "player editions",
    fetchEditions(coll.id, slug, PAGE_SIZE, 0),
  )
  const editions = editionsRes.rows
  const editionsOk = editionsRes.ok

  // Portrait fallback chain: headshot_url → first edition thumbnail → none.
  const portrait = detail.headshot_url ?? proxyIpfsUrl(editions[0]?.thumbnail_url) ?? null
  const teamHref = detail.team_slug ? `/${collection}/team/${encodeURIComponent(detail.team_slug)}` : null

  // Group editions by set_slug → set summary cards (buildPlayerSetCards, tested).
  // ⚠ Derived from `editions`, so it inherits that read's state: on a failure it
  // would be `[]` and the Sets section would silently vanish from a player who
  // has plenty. `editionsOk` is what keeps the two apart.
  const setCards = editionsOk ? buildPlayerSetCards(editions) : []

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(playerJsonLd(detail as unknown as Record<string, unknown>, collection, slug)) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          ...(detail.team && teamHref ? [{ name: detail.team, href: teamHref }] : []),
          { name: detail.name },
        ]}
      />
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18 }}>
        <div className="rpc-entity-hero rpc-entity-hero--240">
          <div style={{ width: "100%", maxWidth: 240, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden" }}>
            {portrait ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={portrait} alt={`${detail.name} ${labels.portrait}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                No {labels.portrait.toLowerCase()}
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.18em", textTransform: "uppercase" }}>{labels.player}</div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {detail.name}
            </h1>

            {isCharacter ? (
              <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
                Character{detail.team ? <> · {labels.team}: {teamHref ? <Link href={teamHref} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>{detail.team}</Link> : detail.team}</> : null}
              </div>
            ) : (
              <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                {detail.jersey_number !== null && <span>#{detail.jersey_number}</span>}
                {detail.position && <span>{detail.position}</span>}
                {detail.team && (teamHref ? (
                  <Link href={teamHref} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>{detail.team}</Link>
                ) : <span>{detail.team}</span>)}
                {detail.is_active === true && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--rpc-success)", boxShadow: "0 0 6px var(--rpc-success)" }} />
                    <span style={{ color: "var(--rpc-success)" }}>active</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCell label="Editions" value={fmtCount(detail.edition_count)} />
        <StatCell label="Total Mint" value={fmtCount(detail.total_circulation)} />
        <StatCell label="FMV Total" value={fmtUsd(detail.fmv_total_usd)} />
        <StatCell label="Floor Total" value={fmtUsd(detail.floor_total_usd)} />
      </section>

      {(detail.first_minted_at || detail.last_minted_at) && (
        <div className="rpc-mono" style={{ marginTop: 8, padding: "0 4px", display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--rpc-text-muted)" }}>
          <span>{detail.first_minted_at ? <>First minted {relTime(detail.first_minted_at)}</> : ""}</span>
          <span>{detail.last_minted_at ? <>Last minted {relTime(detail.last_minted_at)}</> : ""}</span>
        </div>
      )}

      {/* ── Editions grid ────────────────────────────────────────────────── */}
      <Section title="Editions">
        {editionsOk ? (
          <EditionsGridPaginated
            collectionUrlSlug={collection}
            fetchUrl={`/api/entity/player?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
            initial={editions}
            pageSize={PAGE_SIZE}
            showSetLink
            showSort
          />
        ) : (
          <SectionUnavailable noun={`${detail.name}\u2019s editions`} />
        )}
      </Section>

      {/* ── Top sales ────────────────────────────────────────────────────── */}
      <Section title="Top Sales">
        <Suspense fallback={<TopSalesSkeleton />}>
          <TopSalesRows collection={collection} collectionId={coll.id} slug={slug} />
        </Suspense>
      </Section>

      {/* ── Top collectors (rookie ownership index) ──────────────────────── */}
      <Suspense fallback={null}>
        <TopCollectorsSection playerName={detail.name} />
      </Suspense>

      {/* ── Sets ─────────────────────────────────────────────────────────── */}
      {!editionsOk && (
        <Section title="Sets">
          {/* Derived from the editions read, so it is unavailable for the same
              reason — and its empty state is SILENT, which on a player with a
              deep catalogue reads as "no sets" rather than as a failure. */}
          <SectionUnavailable noun={`the sets ${detail.name} appears in`} />
        </Section>
      )}

      {setCards.length > 0 && (
        <Section title="Sets">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {setCards.map(s => (
              <Link
                key={s.setSlug}
                href={`/${collection}/set/${encodeURIComponent(s.setSlug)}`}
                className="rpc-card"
                style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
              >
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{s.setName}</div>
                <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  {fmtCount(s.count)} edition{s.count === 1 ? "" : "s"} · {fmtUsd(s.fmvTotal)}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
// Rendered when the detail RPC could not be READ — distinct from a player that
// does not exist (that still 404s). Reports our failure, claims nothing about
// the data.
function PlayerUnavailable({ collection, slug }: { collection: string; slug: string }) {
  const label = slug.replace(/-/g, " ")
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Player unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(26px, 5vw, 42px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load {label}
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean this player has no moments. Reloading often works.
      </p>
      <a href={`/${collection}/overview`} style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}>
        Back to overview
      </a>
    </main>
  )
}
