// app/(collections)/[collection]/series/[slug]/page.tsx
// Phase 1F. Series detail page across all 5 published collections.
//
// Data: get_series_detail(collection_id, series_slug) +
// get_series_editions(collection_id, series_slug, 100, 0) +
// get_series_rollups(collection_id, series_slug).
// Some series have edition_count = 0 (sparse coverage) — empty state.
//
// Set B5 fix (2026-07-17): the "Sets in this Series" / "Top Players" cards
// come from get_series_rollups, which aggregates over ALL editions in the
// series server-side. The old client-side grouping over the first
// PAGE_SIZE editions (kept below as the RPC-error fallback) undercounted
// large series and dropped sets entirely outside the FMV top-100.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw } from "@/lib/entity-detail-gate"
import { sectionRowResult, sectionRows, structuralSection } from "@/lib/entity-section-rpc"
import { seriesPageMetadata, collectionEntityJsonLd, collectionDisplayName, entityUrl, NOT_FOUND_METADATA } from "@/lib/seo"
import { Section, SectionUnavailable, StatCell, fmtCount, fmtUsd } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import HeroMontage from "@/components/entity/HeroMontage"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface SeriesDetail {
  series_number: number | null
  display_label: string
  season: string | null
  edition_count: number | null
  total_circulation: number | null
  fmv_total_usd: number | null
  floor_total_usd: number | null
  set_count: number | null
  player_count: number | null
}

const PAGE_SIZE = 100

// Routed through the shared cache()'d fetch so the segment layout's 404 gate,
// generateMetadata and this render collapse into ONE get_series_detail call per
// request. See lib/entity-detail-gate.ts.
async function fetchDetail(collectionId: string, slug: string): Promise<SeriesDetail | null> {
  const { data, error } = await fetchEntityDetailRaw("series", collectionId, slug)
  if (error) {
    // Transient RPC failure (statement timeout under contention) must NOT render
    // as not-found — that soft-404s a real page. Returning null here fed the
    // page's `if (!detail) notFound()`, so a saturated read rendered "this series
    // does not exist" for a series holding 3,596 editions (deep-audit D10:
    // /nba-top-shot/series/series-4 appeared to 404 while get_series_detail
    // returns a fully populated row for it).
    // It also DEFEATED the layout gate, which fails open specifically so "a
    // transient pool blip must never emit a 404 and invite Google to drop a real
    // page" — the page was undoing that protection one call later.
    // Same fix already shipped on set / player / team (2026-07-14); series and
    // edition were missed. Throw -> retryable error boundary.
    console.error("[series] detail error", error.message)
    throw new Error(`series detail unavailable: ${error.message}`)
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as SeriesDetail) ?? null
  return data as SeriesDetail
}

// Structural — see the set page's note. The rollups below stay decorative.
async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  return sectionRows<EditionTile>("series editions", "get_series_editions", { p_collection_id: collectionId, p_series_slug: slug, p_limit: limit, p_offset: offset }, { structural: true })
}

interface SetRollupRow { set_slug: string; set_name: string; edition_count: number; fmv_total: number }
interface PlayerRollupRow { player_slug: string; player_name: string; edition_count: number; fmv_total: number }
interface SeriesRollups { sets: SetRollupRow[]; players: PlayerRollupRow[] }

// Three-state. `ok` distinguishes "the rollup RPC failed" from "it answered and
// this series has no sets", which the caller needs: with the editions read ALSO
// gone there is nothing left to derive the cards from, and rendering no cards
// would publish "this series has no sets" out of two failed reads.
async function fetchRollups(collectionId: string, slug: string): Promise<{ rollups: SeriesRollups | null; ok: boolean }> {
  const { row, ok } = await sectionRowResult<{ sets?: unknown; players?: unknown }>("series rollups", "get_series_rollups", { p_collection_id: collectionId, p_series_slug: slug })
  if (!ok) return { rollups: null, ok: false }
  if (!row || !Array.isArray(row.sets) || !Array.isArray(row.players)) return { rollups: null, ok: true }
  return { rollups: { sets: row.sets as SetRollupRow[], players: row.players as PlayerRollupRow[] }, ok: true }
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return NOT_FOUND_METADATA
  // BOUNDED (R19). A throw in generateMetadata takes the whole response to
  // Next's unbranded 500 — no error boundary wraps metadata generation. A
  // transient failure must not return NOT_FOUND_METADATA, which would tell a
  // crawler a real series is gone.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    return { title: { absolute: `${slug.replace(/-/g, " ")} | ${coll.displayName} | Rip Packs City` } }
  }
  if (!detail) return NOT_FOUND_METADATA
  return seriesPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function SeriesPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // ⚠ BOUNDED (R19). 259 "series detail unavailable" across 38 users in 7 days.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  let detailFailed = false
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    detailFailed = true
  }
  if (detailFailed) return <SeriesUnavailable collection={collection} slug={slug} />
  if (!detail) notFound()

  // ⚠ `=== 0`, NOT `(x ?? 0) === 0`. Since 2026-08-23 `edition_count` comes from
  // `series_detail_rollup` and is NULL when that series has never been rolled up
  // — UNKNOWN, not zero. The `?? 0` form turned that unknown into "No editions
  // in this series yet" on a series that may hold thousands, AND short-circuited
  // the editions/rollups fetch so nothing downstream could contradict it. A
  // genuine 0 (ufc_strike series 0, measured) still renders the empty state.
  const isEmpty = detail.edition_count === 0
  // ⚠ `fetchEditions` is STRUCTURAL — it THROWS after retries rather than render
  // a real series with a convincingly empty catalogue (see lib/entity-section-rpc.ts).
  //
  // ⚠ PER-SECTION, NOT PER-PAGE (R19, 2026-08-23). This used to catch the throw
  // out here and return `SeriesUnavailable`, which threw away the hero and all
  // five stat cells — every one of them already read, already true, and cheap:
  // `get_series_detail` answers in ~18 ms off `series_detail_rollup` while
  // `get_series_editions` costs 6,615 ms / 32,484 buffers against an 8 s ceiling
  // (R49), so on the two largest Top Shot series the editions read is the ONLY
  // one that fails. The reader now keeps the series name, season, edition count,
  // set count, player count, FMV total and floor total, and is told plainly that
  // the editions grid did not come back.
  //
  // ⚠ The throw also used to reject the shared `Promise.all` and discard the
  // ROLLUPS alongside it, even when those succeeded. `structuralSection` absorbs
  // it so each leg reports for itself.
  //
  // ⚠ The inner try is a LAST RESORT, not the rung-2 catch it replaced. A
  // decorative section fetcher cannot throw by policy and `structuralSection`
  // absorbs the one that can — but an unexpected throw would still reject the
  // whole `Promise.all`, and on an ISR route error.tsx does not run. So the catch
  // marks EVERY section failed and lets the page render; it must never return a
  // whole-page view.
  let editionsRes: { rows: EditionTile[]; ok: boolean } = { rows: [], ok: true }
  let rollupsRes: Awaited<ReturnType<typeof fetchRollups>> = { rollups: null, ok: true }
  if (!isEmpty) {
    try {
      ;[editionsRes, rollupsRes] = await Promise.all([
        structuralSection<EditionTile>("series editions", fetchEditions(coll.id, slug, PAGE_SIZE, 0)),
        fetchRollups(coll.id, slug),
      ])
    } catch (e) {
      console.error("[series] section fan-out threw outside the section policy", e instanceof Error ? e.message : String(e))
      editionsRes = { rows: [], ok: false }
      rollupsRes = { rollups: null, ok: false }
    }
  }
  const editions = editionsRes.rows
  const editionsOk = editionsRes.ok
  const rollups = rollupsRes.rollups

  // Top 25 = first 25 (RPC pre-sorts by FMV desc).
  const top25 = editions.slice(0, 25)

  // Set / player cards: whole-series aggregates from get_series_rollups.
  // If the RPC fails, fall back to grouping the fetched page of editions —
  // partial (pre-B5 behavior) but better than hiding the sections.
  let setCards: Array<{ setSlug: string; setName: string; count: number; fmvTotal: number }>
  let topPlayers: Array<{ playerSlug: string; playerName: string; count: number; fmvTotal: number }>
  if (rollups) {
    setCards = rollups.sets.map(s => ({ setSlug: s.set_slug, setName: s.set_name, count: s.edition_count, fmvTotal: s.fmv_total ?? 0 }))
    topPlayers = rollups.players.map(p => ({ playerSlug: p.player_slug, playerName: p.player_name, count: p.edition_count, fmvTotal: p.fmv_total ?? 0 }))
  } else if (editionsOk) {
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
    setCards = Array.from(setMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal)

    const playerMap = new Map<string, { playerSlug: string; playerName: string; count: number; fmvTotal: number }>()
    for (const e of editions) {
      const ps = e.player_slug ?? null
      const pn = e.player_name ?? null
      if (!ps || !pn) continue
      const existing = playerMap.get(ps)
      if (existing) {
        existing.count += 1
        existing.fmvTotal += e.fmv_usd ?? 0
      } else {
        playerMap.set(ps, { playerSlug: ps, playerName: pn, count: 1, fmvTotal: e.fmv_usd ?? 0 })
      }
    }
    topPlayers = Array.from(playerMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal).slice(0, 12)
  } else {
    // Neither basis survived. Rendering zero cards here would publish "this
    // series has no sets" out of two failed reads — see `cardsUnavailable`.
    setCards = []
    topPlayers = []
  }

  // ⚠ The cards' empty state is SILENT (the sections simply do not render), and
  // a silent absence on a page whose stat strip says "Sets: 42" is the two-state
  // collapse in its quietest form. When neither the rollups nor the editions
  // came back we have no basis at all, so say so instead of showing nothing.
  const cardsUnavailable = rollups === null && !editionsOk

  return (
    <div>
      {/* ⚠ OMITTED, not emitted-with-zero, when the editions read failed.
          `collectionEntityJsonLd` publishes `numberOfItems: items.length`, so a
          failed structural read would hand a crawler a machine-readable claim
          that a 4,895-edition series holds none — the fabricated-number shape,
          in the one place no human proof-reads it. No claim beats a false one. */}
      {editionsOk && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionEntityJsonLd({ name: detail.display_label, url: entityUrl(collection, "series", slug), collectionUrlSlug: collection, eds: top25 as unknown as Array<Record<string, unknown>>, crumbName: detail.display_label })) }}
        />
      )}
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          { name: detail.display_label },
        ]}
      />
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18, display: "flex", gap: 18, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
          {detail.display_label}
        </h1>
        {detail.season && (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 13, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
            {detail.season}
          </div>
        )}
        </div>
        <HeroMontage items={top25} collectionUrlSlug={collection} />
      </section>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <StatCell label="Editions" value={fmtCount(detail.edition_count)} />
        <StatCell label="Sets" value={fmtCount(detail.set_count)} />
        <StatCell label="Players" value={fmtCount(detail.player_count)} />
        <StatCell label="FMV Total" value={fmtUsd(detail.fmv_total_usd)} />
        <StatCell label="Floor Total" value={fmtUsd(detail.floor_total_usd)} />
      </section>

      {isEmpty ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: "22px 18px", textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          No editions in this series yet
        </div>
      ) : (
        <>
          {/* ── Top 25 ────────────────────────────────────────────────────── */}
          <Section title="Top Editions">
            {editionsOk ? (
              <EditionsGridPaginated
                collectionUrlSlug={collection}
                fetchUrl={`/api/entity/series?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
                initial={top25}
                pageSize={PAGE_SIZE}
                showSetLink
                showSort={false}
              />
            ) : (
              <SectionUnavailable noun="the editions in this series" />
            )}
          </Section>

          {/* ── Sets in this Series ──────────────────────────────────────── */}
          {setCards.length > 0 && (
            <Section title="Sets in this Series">
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

          {cardsUnavailable && (
            <Section title="Sets in this Series">
              <SectionUnavailable noun={"this series’ sets and players"} />
            </Section>
          )}

          {/* ── Top Players in this Series ───────────────────────────────── */}
          {topPlayers.length > 0 && (
            <Section title="Top Players in this Series">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                {topPlayers.map(p => (
                  <Link
                    key={p.playerSlug}
                    href={`/${collection}/player/${encodeURIComponent(p.playerSlug)}`}
                    className="rpc-card"
                    style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{p.playerName}</div>
                    <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                      {fmtCount(p.count)} edition{p.count === 1 ? "" : "s"} · {fmtUsd(p.fmvTotal)}
                    </div>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
// Rendered when the detail RPC could not be READ — distinct from a series that
// does not exist (that still 404s). Reports our failure, claims nothing about
// the data.
function SeriesUnavailable({ collection, slug }: { collection: string; slug: string }) {
  const label = slug.replace(/-/g, " ")
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Series unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(26px, 5vw, 42px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load {label}
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean the series is empty. Reloading often works.
      </p>
      <a href={`/${collection}/sets`} style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}>
        All sets
      </a>
    </main>
  )
}
