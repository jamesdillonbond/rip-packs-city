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
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { playerPageMetadata, playerJsonLd, collectionDisplayName } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { getEntityLabels } from "@/lib/entity-labels"
import { Section, StatCell, fmtCount, fmtUsd, relTime } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

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

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
function rpc() { return supabaseAdmin as unknown as RpcClient }

async function fetchDetail(collectionId: string, slug: string): Promise<PlayerDetail | null> {
  const { data, error } = await rpc().rpc("get_player_detail", { p_collection_id: collectionId, p_player_slug: slug })
  if (error) { console.error("[player] detail error", error.message); return null }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as PlayerDetail) ?? null
  return data as PlayerDetail
}

async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await rpc().rpc("get_player_editions", { p_collection_id: collectionId, p_player_slug: slug, p_limit: limit, p_offset: offset })
  if (error) { console.error("[player] editions error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
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
  const { data, error } = await rpc().rpc("get_player_top_sales", { p_collection_id: collectionId, p_player_slug: slug, p_limit: limit })
  if (error) { console.error("[player] top sales error", error.message); return [] }
  return Array.isArray(data) ? (data as PlayerTopSale[]) : []
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

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const detail = await fetchDetail(coll.id, slug)
  if (!detail) return {}
  return playerPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PlayerPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const detail = await fetchDetail(coll.id, slug)
  if (!detail) notFound()

  const labels = getEntityLabels(collection)
  const isCharacter = detail.is_character === true
  const editions = await fetchEditions(coll.id, slug, PAGE_SIZE, 0)

  // Portrait fallback chain: headshot_url → first edition thumbnail → none.
  const portrait = detail.headshot_url ?? editions[0]?.thumbnail_url ?? null
  const teamHref = detail.team_slug ? `/${collection}/team/${encodeURIComponent(detail.team_slug)}` : null

  // Group editions by set_slug → set summary cards.
  const setMap = new Map<string, { setSlug: string; setName: string; count: number; fmvTotal: number }>()
  for (const e of editions) {
    if (!e.set_slug || !e.set_name) continue
    const existing = setMap.get(e.set_slug)
    if (existing) {
      existing.count += 1
      existing.fmvTotal += e.fmv_usd ?? 0
    } else {
      setMap.set(e.set_slug, { setSlug: e.set_slug, setName: e.set_name, count: 1, fmvTotal: e.fmv_usd ?? 0 })
    }
  }
  const setCards = Array.from(setMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal)

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
        <EditionsGridPaginated
          collectionUrlSlug={collection}
          fetchUrl={`/api/entity/player?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
          initial={editions}
          pageSize={PAGE_SIZE}
          showSetLink
          showSort
        />
      </Section>

      {/* ── Top sales ────────────────────────────────────────────────────── */}
      <Section title="Top Sales">
        <Suspense fallback={<TopSalesSkeleton />}>
          <TopSalesRows collection={collection} collectionId={coll.id} slug={slug} />
        </Suspense>
      </Section>

      {/* ── Sets ─────────────────────────────────────────────────────────── */}
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

