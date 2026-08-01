// app/(collections)/[collection]/team/[slug]/layout.tsx
//
// Existence gate for /<collection>/team/<slug>, and the ONLY place it can live.
//
// This segment ships a `loading.tsx`, which makes Next wrap the PAGE in an
// implicit <Suspense>: the document shell + fallback are flushed (committing a
// **200** status line) before the page's own `notFound()` ever runs, so an
// unknown slug answered HTTP 200 with a not-found body — a soft-404. Google
// treats those as thin duplicates, and ~20,500 sitemap URLs sit on the five
// entity routes. A layout is part of the shell, so Next must await it BEFORE the
// first flush; putting the gate here commits a real 404 and KEEPS the skeleton.
// Same pattern as app/moment/[id]/layout.tsx (e835882c). Full rationale + the
// four-variant Next 16.2.9 probe: lib/entity-detail-gate.ts.
//
// Safety: the gate calls the same `get_team_detail` the page 404s on, via the
// cache()'d shared fetch — so it is a STRICT SUBSET of the page's own condition
// (it cannot invent a 404) and it costs no extra round trip. It FAILS OPEN on
// any RPC error.

import { notFound, permanentRedirect } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw, firstEntityRow, decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { slugifyName } from "@/lib/entity-labels"
import { isExhibitionTeamSlug } from "@/lib/team-denylist"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function TeamSegmentLayout({ children, params }: LayoutProps) {
  const { collection, slug: rawSlug } = await params

  // A malformed percent-escape means we cannot reproduce the key the page will
  // use — fail open rather than 404 on a guess.
  const slug = decodeSlugOrNull(rawSlug)
  if (slug === null) return <>{children}</>

  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // Exhibition / all-star rosters are not real franchises. The page already
  // 404s them; doing it here makes it a real 404 instead of a soft one.
  if (isExhibitionTeamSlug(slug)) notFound()

  // ── Existence gate + canonical-slug redirect ────────────────────────────
  // Both read the ONE cache()'d get_team_detail call the page itself uses.
  //
  // Why the redirect (2026-08-01): get_team_detail carries a diacritic-
  // stripping FALLBACK lane so /team/atletico-de-madrid resolves to "Atlético
  // de Madrid". The other SIX section RPCs (get_team_players,
  // _top_editions, _activity, _sets, _squeeze, _checklist) do NOT — they match
  // only regexp_replace(lower(trim(team_name)),'[^a-z0-9]+','-','g'), so on the
  // fallback slug every one returned 0 rows and the page rendered a real
  // franchise with a completely EMPTY body (measured: 0/0/0/0 vs 28/24/40/14).
  // Canonicalising here (rather than teaching six more functions the alias)
  // also gives the team hub ONE indexable URL.
  //
  // Loop-safety: slugifyName is byte-equivalent to that Postgres expression, and
  // on the primary lane every matched variant slugifies back to the requested
  // slug — so the canonical target can only ever resolve via the primary lane
  // and immediately compares equal. Fails OPEN on any RPC error/throw.
  let detail: { team_name?: string | null } | null = null
  try {
    const { data, error } = await fetchEntityDetailRaw("team", coll.id, slug)
    if (error) {
      console.warn(`[team-layout] detail rpc error slug=${slug}: ${error.message} — failing OPEN`)
      return <>{children}</>
    }
    detail = firstEntityRow<{ team_name?: string | null }>(data)
  } catch (err) {
    console.warn(
      `[team-layout] detail rpc threw slug=${slug}: ${err instanceof Error ? err.message : String(err)} — failing OPEN`,
    )
    return <>{children}</>
  }

  if (detail == null) notFound()

  const canonical = detail.team_name ? slugifyName(detail.team_name) : ""
  if (canonical && canonical !== slug) {
    permanentRedirect(`/${collection}/team/${encodeURIComponent(canonical)}`)
  }

  return <>{children}</>
}
