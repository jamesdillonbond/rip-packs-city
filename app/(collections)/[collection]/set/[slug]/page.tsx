// app/(collections)/[collection]/set/[slug]/page.tsx
// Phase 1C. Set detail page across all 5 published collections.
//
// Data: get_set_detail(collection_id, set_slug) + get_set_editions(...,100,0).
// Aggregate stats + tier mix + paginated edition grid.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchFullTierMix, buildTierMixRows } from "@/lib/set-detail/tier-mix"
import { fetchEntityDetailRaw } from "@/lib/entity-detail-gate"
import { sectionRows } from "@/lib/entity-section-rpc"
import { setPageMetadata, collectionEntityJsonLd, collectionDisplayName, entityUrl, NOT_FOUND_METADATA } from "@/lib/seo"
import { Section, StatCell, fmtCount, fmtUsd, relTime } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import HeroMontage from "@/components/entity/HeroMontage"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface SetDetail {
  set_name: string
  set_name_variants: string[] | null
  underlying_set_count: number | null
  edition_count: number | null
  editions_with_fmv: number | null
  total_circulation: number | null
  tiers_present: string[] | null
  min_series: number | null
  max_series: number | null
  fmv_total_usd: number | null
  floor_total_usd: number | null
  summary_computed_at: string | null
}

const PAGE_SIZE = 100

// Routed through the shared cache()'d fetch so the segment layout's 404 gate,
// generateMetadata and this render collapse into ONE get_set_detail call per
// request. See lib/entity-detail-gate.ts.
async function fetchDetail(collectionId: string, slug: string): Promise<SetDetail | null> {
  const { data, error } = await fetchEntityDetailRaw("set", collectionId, slug)
  if (error) {
    // Transient RPC failure (statement timeout under contention) must NOT
    // render as not-found — that soft-404s real pages (same class fixed on
    // pack/team 2026-07-14). Throw -> retryable error boundary.
    console.error("[set] detail error", error.message)
    throw new Error(`set detail unavailable: ${error.message}`)
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as SetDetail) ?? null
  return data as SetDetail
}

// The editions grid is STRUCTURAL — a set page whose grid silently renders
// empty is indistinguishable from a set we have no data for, and it is the
// reason the page exists. Retries connection-class errors, then throws.
// See lib/entity-section-rpc.ts.
async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  return sectionRows<EditionTile>("set editions", "get_set_editions", { p_collection_id: collectionId, p_set_slug: slug, p_limit: limit, p_offset: offset }, { structural: true })
}

// Phase 7 (2026-05-26): the full-set tier mix moved to lib/set-detail/tier-mix.ts
// so it is measured by the primary coverage gate and so its FAILURE is
// expressible — it used to return a bare [] on a query error, which this page
// read as the legitimate "no full-set count, sample the first page" fallback.
// See that module's header.


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
    return { title: `${slug.replace(/-/g, " ")} | ${coll.displayName} | Rip Packs City` }
  }
  if (!detail) return NOT_FOUND_METADATA
  return setPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function SetPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // ⚠ BOUNDED READ (deep-audit R19). This was a bare `await fetchDetail(...)`.
  // Observed live 2026-08-22: /nba-top-shot/set/base-set returned a bare
  // "500: This page couldn't load" after 18 s under DB load.
  //
  // ⚠ AND AN error.tsx BOUNDARY DOES NOT CATCH IT. This route is ISR
  // (`revalidate = 600`, `dynamicParams = true`), so the throw happens while the
  // page is being GENERATED, not while a mounted tree renders — Next serves its
  // own default error page and the segment boundary never runs. Verified: the
  // boundary IS in the deployed bundle and the 500 was still Next's default.
  // `generateMetadata` above already degrades; only the page body did not.
  //
  // ⚠ A FAILED READ MUST NOT BECOME notFound(). `!detail` means the RPC answered
  // and this set does not exist — a 404 is then true. A THROW means we could not
  // ask, and rendering 404 there would tell a crawler a real set is gone.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  let detailFailed = false
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    detailFailed = true
  }
  if (detailFailed) return <SetUnavailable collection={collection} slug={slug} />
  if (!detail) notFound()

  const setNames = [detail.set_name, ...(detail.set_name_variants ?? [])]
  const [editions, tierMix] = await Promise.all([
    fetchEditions(coll.id, slug, PAGE_SIZE, 0),
    fetchFullTierMix(coll.id, setNames),
  ])

  const minLabel = detail.min_series !== null ? seriesDisplay(detail.min_series, collection) : null
  const maxLabel = detail.max_series !== null ? seriesDisplay(detail.max_series, collection) : null
  const seriesLabel = minLabel !== null && maxLabel !== null
    ? (minLabel === maxLabel ? minLabel : `${minLabel} – ${maxLabel}`)
    : null

  // Phase 7: the bar is built from the full-set count, falling back to the
  // first-page sample when that read SUCCEEDED and returned nothing (a
  // collection whose editions are not reachable by set_name).
  //
  // ⚠ On a FAILED read the section is withheld entirely. The bar prints
  // ABSOLUTE COUNTS with no provenance, so sampling 100 of a ~3,600-edition set
  // renders "COMMON · 62 · 62.0%" against a true ~2,200 — a wrong number
  // presented identically to a right one. Showing nothing is the honest
  // outcome; the editions grid below still carries the page.
  const tierMixRows = tierMix.ok ? buildTierMixRows(tierMix.rows, editions) : []

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionEntityJsonLd({ name: detail.set_name, url: entityUrl(collection, "set", slug), collectionUrlSlug: collection, eds: editions as unknown as Array<Record<string, unknown>>, crumbName: detail.set_name })) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          { name: detail.set_name },
        ]}
      />
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18, display: "flex", gap: 18, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 32, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
          {detail.set_name}
        </h1>
        {/* D20: disclose merged sets. The big merges are name-IDENTICAL seasonal
            repeats (e.g. AllDay "Draw It Up" = 10 sets across S3–9), which produce
            a single spelling variant — so key the banner on the underlying set
            COUNT, not on distinct spellings. Falls back to the old spellings
            banner only if the count field is absent (old RPC during a deploy). */}
        {detail.underlying_set_count != null && detail.underlying_set_count > 1 ? (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Combined view: {detail.underlying_set_count} sets share this name
            {seriesLabel ? ` (${seriesLabel})` : ""}
            {detail.set_name_variants && detail.set_name_variants.length > 1
              ? ` — spellings: ${detail.set_name_variants.join(" · ")}`
              : ""}
            . Edition count, completion % and FMV totals are combined across all of them.
          </div>
        ) : detail.underlying_set_count == null && detail.set_name_variants && detail.set_name_variants.length > 1 ? (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Variants merged: {detail.set_name_variants.join(" · ")}
          </div>
        ) : null}
        {seriesLabel && (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 12, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
            Part of {seriesLabel}
          </div>
        )}
        {detail.summary_computed_at && (
          <div className="rpc-mono" style={{ marginTop: 8, fontSize: 10, color: "var(--rpc-text-muted)" }}>
            Updated {relTime(detail.summary_computed_at)}
          </div>
        )}
        </div>
        <HeroMontage items={editions} collectionUrlSlug={collection} />
      </section>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCell label="Editions" value={fmtCount(detail.edition_count)} sub={detail.editions_with_fmv !== null ? `${fmtCount(detail.editions_with_fmv)} with FMV` : undefined} />
        <StatCell label="Total Mint" value={fmtCount(detail.total_circulation)} />
        <StatCell label="FMV Total" value={fmtUsd(detail.fmv_total_usd)} />
        <StatCell label="Floor Total" value={fmtUsd(detail.floor_total_usd)} />
      </section>

      {/* ── Tier mix bar ─────────────────────────────────────────────────── */}
      {tierMixRows.length > 0 && (
        <Section title="Tier Mix">
          <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", border: "1px solid var(--rpc-border)" }}>
            {tierMixRows.map(r => (
              <div key={r.tier} title={`${r.tier} — ${r.n} (${r.pct.toFixed(1)}%)`} style={{
                width: `${r.pct}%`,
                background: tierBgFor(r.tier),
                minWidth: r.pct > 0 ? 2 : 0,
              }} />
            ))}
          </div>
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 10 }}>
            {tierMixRows.map(r => (
              <div key={r.tier} className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, background: tierBgFor(r.tier), borderRadius: 2 }} />
                {r.tier} · {r.n} · {r.pct.toFixed(1)}%
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Editions grid ────────────────────────────────────────────────── */}
      <Section title="Editions">
        <EditionsGridPaginated
          collectionUrlSlug={collection}
          fetchUrl={`/api/entity/set?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
          initial={editions}
          pageSize={PAGE_SIZE}
          showSetLink={false}
          showSort
        />
      </Section>
    </div>
  )
}

function tierBgFor(tier: string): string {
  const k = tier.toUpperCase()
  switch (k) {
    case "ULTIMATE":   return "var(--tier-ultimate)"
    case "LEGENDARY":  return "var(--tier-legendary)"
    case "CHAMPION":   return "var(--tier-champion)"
    case "CHALLENGER": return "var(--tier-challenger)"
    case "CONTENDER":  return "var(--tier-contender)"
    case "RARE":       return "var(--tier-rare)"
    case "FANDOM":     return "var(--tier-fandom)"
    case "UNCOMMON":   return "var(--tier-uncommon)"
    case "COMMON":     return "var(--tier-common)"
    default:           return "var(--rpc-text-ghost)"
  }
}

// Top Shot encodes series as a raw on-chain UInt32 where 0 = Series 1, and
// there is no on-chain series 1 (see the CLAUDE.md series map). The
// sets_summary view carries that raw value, so it must be mapped before
// display. Other collections' series encodings are not verified here, so
// they fall back to the raw "Series N" form unchanged.
const SERIES_DISPLAY: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

function seriesDisplay(n: number, collectionUrlSlug: string): string {
  if (collectionUrlSlug === "nba-top-shot") return SERIES_DISPLAY[n] ?? `Series ${n}`
  return `Series ${n}`
}

// Rendered when get_set_detail could not be READ — distinct from a set that does
// not exist (that still 404s above). Reports our failure and makes no claim
// about the set's contents; a heavy page under load must degrade in brand rather
// than bail to Next's unbranded default.
function SetUnavailable({ collection, slug }: { collection: string; slug: string }) {
  const name = slug.replace(/-/g, " ")
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Set unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(28px, 5vw, 44px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load {name}
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The set data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean the set is empty or gone. Reloading often works.
      </p>
      <a
        href={`/${collection}/sets`}
        style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}
      >
        All sets
      </a>
    </main>
  )
}
