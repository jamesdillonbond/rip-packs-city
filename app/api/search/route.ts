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
// HONESTY: `meta.searches` states exactly which fields are covered, because
// the obvious user expectation — "Damian Lillard game winners", YouTube-style
// — is NOT satisfiable from our data and never silently will be. There is no
// description column on `editions`; `editions.name` is just "<Player> — <Set>";
// `badges`/`reward_indicators` are empty on every row; and play_type /
// play_category are shot mechanics (Rim, 3 Pointer, Dunk), not narrative. A
// query for a clutch/buzzer-beater concept correctly returns zero results, and
// the client says why rather than implying the moment doesn't exist.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug, getCollectionByUuid } from "@/lib/collection-slug"
import { buildSearchHref, type SearchHit } from "@/lib/search/href"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MIN_Q = 2
const MAX_Q = 80

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

  const { data, error } = await supa.rpc("rpc_search_catalog", {
    p_q: q,
    p_collection_id: collectionId,
    p_limit: limit,
  })

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
        searches: ["player", "set", "team", "edition key", "play type"],
        note:
          "Searches names, teams and play types. Moment descriptions are not in the catalog, so narrative queries (\"game winner\", \"buzzer beater\") return nothing.",
      },
    },
    // Short public cache: the catalog changes on a catalog-backfill cadence,
    // not per request, and repeated type-ahead prefixes are the common case.
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
  )
}
