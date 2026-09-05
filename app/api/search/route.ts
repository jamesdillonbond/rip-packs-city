// app/api/search/route.ts
//
// Global catalog search. Backs the header search bar.
//
// Before this, "search" on RPC meant one of three narrow things, none of which
// was a catalog index: /api/edition-search (player_name ilike only, limit 10),
// /api/search-editions (auth-gated, for the alert-create modal), or a
// client-side .includes() over rows a board had already loaded. There was no
// /api/search and no global search bar.
//
// Public GET, same posture as /api/entity/* — it indexes data that is already
// anonymously readable (collection tabs un-gated 2026-07-17; player/set/team
// pages are in the sitemap). It exposes nothing new, it just makes what is
// already public findable. Writes nothing.
//
// NARRATIVE SEARCH IS LIVE, AND PARTIAL — which is why coverage is reported.
// As of 2026-08-13 `editions.description` carries the upstream prose the Top
// Shot moment page renders. The prose exists for only part of the catalog
// (measured, not guessed: see `meta.coverage`), and ONLY for Top Shot — All
// Day's ingest is WAF-blocked, and no other collection has a prose source.
//
// ⚠ This header used to cite "Damian Lillard game winner" returning the "For
// the Win" moments as proof it worked. That was a FALSE POSITIVE: "For The
// Win" is a SET NAME containing the query words, i.e. set-name matching read
// as prose matching. A domain expert spotted it in one sentence. Do not
// re-introduce a claim of this shape without checking the returned rows are
// the RIGHT rows — a non-empty result is not a correct result.
//
// ⚠ And it matches WORDS, not concepts. There is no stemming: the two most
// famous Blazers game winners say "game-winning" and "buzzer" in their prose
// and never "winner" or "beater", so `game winner` cannot reach one and
// `buzzer beater` cannot reach the other, while `game winning` reaches both.
// (Measured: Postgres English stemming does NOT relate winner↔winning or
// buzzer↔beater, so switching to `websearch_to_tsquery` would not fix this —
// and it ANDs its terms by default too.) A 3-or-more-token query may miss ONE
// token (rpc_search_catalog, 2026-08-14), which is what makes "lillard buzzer
// beater" work; a 1- or 2-token query must still match every word.
//
// That partiality is the thing this route must not hide. A narrative query
// that matches nothing could mean "no such moment" OR "we have no prose for
// that slice of the catalog", and those are completely different statements to
// make to a collector. `meta.coverage` is read LIVE from
// edition_description_coverage — never hardcoded, because the backfill moves
// the number every run and a hardcoded percentage is stale the moment it ships
// (the Panini lesson).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug, getCollectionByUuid } from "@/lib/collection-slug"
import { buildSearchHref, type SearchHit } from "@/lib/search/href"
import { boundedRead } from "@/lib/api/bounded-read"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MIN_Q = 2
const MAX_Q = 80

interface CoverageRow {
  collection_slug: string
  searchable_editions: number
  with_description: number
  pct: number | string | null
}

/**
 * Live descriptive-prose coverage per collection. Returns null on any failure —
 * the search still answers; it just omits a disclosure it cannot substantiate.
 * Never hardcode these numbers: the backfill moves them on every run.
 */
async function fetchDescriptionCoverage(): Promise<CoverageRow[] | null> {
  try {
    const supa = supabaseAdmin as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> }
    }
    const { data, error } = await boundedRead(
      supa
        .from("edition_description_coverage")
        .select("collection_slug, searchable_editions, with_description, pct"),
      "api/search/edition_description_coverage",
    )
    if (error || !Array.isArray(data)) return null
    return data as CoverageRow[]
  } catch {
    return null
  }
}

function coverageNote(coverage: CoverageRow[] | null): string {
  const base =
    "Searches player, set, team, play type, edition key, and moment descriptions."
  if (!coverage || coverage.length === 0) return base
  const withProse = coverage
    .filter((c) => Number(c.with_description) > 0)
    .sort((a, b) => Number(b.with_description) - Number(a.with_description))
  if (withProse.length === 0) {
    return base + " No moment descriptions are loaded yet, so narrative queries return nothing."
  }
  const parts = withProse.map(
    (c) => `${c.collection_slug} ${c.pct ?? "?"}% (${c.with_description}/${c.searchable_editions})`
  )
  return (
    base +
    ` Descriptions cover only part of the catalog — ${parts.join(", ")} — so a narrative query` +
    " that matches nothing may mean we have no description for that moment, not that it does not exist." +
    // Word-matching, not concept-matching, and there is no stemming: the prose
    // that says "game-winning" is unreachable by "game winner". Telling the
    // user that is worth more than another apology for an empty result.
    " It matches words, not concepts — if a phrase finds nothing, try the words the story would use" +
    " (\"game winning\" rather than \"game winner\"), or add the player's name."
  )
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const q = (sp.get("q") ?? "").trim().slice(0, MAX_Q)

  if (q.length < MIN_Q) {
    return NextResponse.json(
      { results: [], meta: { q, reason: "too_short", min: MIN_Q } },
      { headers: { "Cache-Control": "no-store" } }
    )
  }

  // Optional collection scope, given as the URL slug the app routes on
  // ("nba-top-shot"), resolved to the uuid the RPC takes. An unknown slug is a
  // 400 rather than a silent all-collections search, so a typo in a caller
  // can't quietly widen the query.
  const collectionParam = sp.get("collection")
  let collectionId: string | null = null
  if (collectionParam) {
    const coll = getCollectionByUrlSlug(collectionParam)
    if (!coll) {
      return NextResponse.json({ error: "unknown collection" }, { status: 400 })
    }
    collectionId = coll.id
  }

  const limitRaw = Number(sp.get("limit") ?? 20)
  const limit = Math.max(1, Math.min(30, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20))

  const supa = supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  }

  // Coverage is fetched alongside the search, not derived from it. A failed
  // coverage read must NOT fail the search — it degrades to null and the
  // client simply omits the disclosure rather than showing a wrong number.
  const [{ data, error }, coverage] = await Promise.all([
    boundedRead(
      supa.rpc("rpc_search_catalog", { p_q: q, p_collection_id: collectionId, p_limit: limit }),
      "api/search/rpc_search_catalog",
    ),
    fetchDescriptionCoverage(),
  ])

  if (error) {
    // 503, not a 200 with an empty `results` array. An empty array here would
    // be byte-identical to a legitimate "nothing matched", so a database
    // outage would render to the user as "we have no such moment" — the
    // failure-renders-as-data class this codebase has been burned by. The
    // driver message is logged, never published.
    console.error("[api/search]", error.message)
    return NextResponse.json(
      { error: "Search is unavailable right now.", code: "search_unavailable" },
      { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } }
    )
  }

  const rows = Array.isArray(data) ? (data as SearchHit[]) : []
  const results = rows
    .map((r) => {
      const coll = getCollectionByUuid(r.collection_id)
      if (!coll) return null // unpublished/unknown collection → no route to link to
      const href = buildSearchHref(r.kind, coll.urlSlug, r.slug)
      if (!href) return null
      return {
        kind: r.kind,
        label: r.label,
        sublabel: r.sublabel,
        href,
        collection: coll.urlSlug,
        collectionName: coll.displayName,
        thumbnailUrl: r.thumbnail_url,
        editionCount: r.edition_count,
      }
    })
    .filter(Boolean)

  return NextResponse.json(
    {
      results,
      meta: {
        q,
        count: results.length,
        collection: collectionParam ?? null,
        // Stated, not implied — see the honesty note at the top of this file.
        searches: ["player", "set", "team", "edition key", "play type", "moment description"],
        coverage,
        note: coverageNote(coverage),
      },
    },
    // Short public cache: the catalog changes on a catalog-backfill cadence,
    // not per request, and repeated type-ahead prefixes are the common case.
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
  )
}
