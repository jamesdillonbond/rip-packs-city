// app/(collections)/[collection]/set/[slug]/page.tsx
// Phase 1C. Set detail page across all 5 published collections.
//
// Data: get_set_detail(collection_id, set_slug) + get_set_editions(...,100,0).
// Aggregate stats + tier mix + paginated edition grid.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { setPageMetadata, collectionEntityJsonLd, collectionDisplayName, entityUrl } from "@/lib/seo"
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

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
function rpc() { return supabaseAdmin as unknown as RpcClient }

async function fetchDetail(collectionId: string, slug: string): Promise<SetDetail | null> {
  const { data, error } = await rpc().rpc("get_set_detail", { p_collection_id: collectionId, p_set_slug: slug })
  if (error) { console.error("[set] detail error", error.message); return null }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as SetDetail) ?? null
  return data as SetDetail
}

async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await rpc().rpc("get_set_editions", { p_collection_id: collectionId, p_set_slug: slug, p_limit: limit, p_offset: offset })
  if (error) { console.error("[set] editions error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

// Phase 7 (2026-05-26): full-set tier mix. Queries the editions table directly
// across all variants (detail.set_name + detail.set_name_variants) so the
// rendered tier bar is accurate even on sets with > PAGE_SIZE editions, instead
// of being sampled from the first 100. The new get_set_tier_mix RPC keys by
// the set's UUID which the SetDetail RPC doesn't surface yet; querying by
// set_name list works for every collection without a schema change.
async function fetchFullTierMix(collectionId: string, setNames: string[]): Promise<Array<{ tier: string; n: number }>> {
  const names = Array.from(new Set(setNames.filter(Boolean)))
  if (names.length === 0) return []
  const { data, error } = await (supabaseAdmin as any)
    .from("editions")
    .select("tier")
    .eq("collection_id", collectionId)
    .in("set_name", names)
    .limit(10000)
  if (error) { console.error("[set] tier mix error", error.message); return [] }
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as Array<{ tier: string | null }>) {
    const t = (row.tier ?? "UNKNOWN").toUpperCase()
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return Array.from(counts.entries()).map(([tier, n]) => ({ tier, n }))
}


// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const detail = await fetchDetail(coll.id, slug)
  if (!detail) return {}
  return setPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function SetPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const detail = await fetchDetail(coll.id, slug)
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

  // Phase 7: tier mix uses the full-set count from fetchFullTierMix (not the
  // paginated editions). Falls back to the editions-list sample if the full
  // count came back empty (collection without set_name index, e.g.).
  const totalForMix = tierMix.length > 0
    ? tierMix.reduce((s, r) => s + r.n, 0)
    : editions.length
  const baseRows = tierMix.length > 0
    ? tierMix
    : (() => {
        const m = new Map<string, number>()
        for (const e of editions) {
          const t = (e.tier ?? "UNKNOWN").toUpperCase()
          m.set(t, (m.get(t) ?? 0) + 1)
        }
        return Array.from(m.entries()).map(([tier, n]) => ({ tier, n }))
      })()
  const tierMixRows = baseRows
    .map(r => ({ tier: r.tier, n: r.n, pct: totalForMix > 0 ? (r.n / totalForMix) * 100 : 0 }))
    .sort((a, b) => b.n - a.n)

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
        {detail.set_name_variants && detail.set_name_variants.length > 1 && (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Variants merged: {detail.set_name_variants.join(" · ")}
          </div>
        )}
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
        <HeroMontage items={editions} />
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
    default:           return "rgba(255,255,255,0.18)"
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
