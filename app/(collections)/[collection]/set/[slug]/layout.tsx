// app/(collections)/[collection]/set/[slug]/layout.tsx
//
// Existence gate for /<collection>/set/<slug>, and the ONLY place it can live.
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
// Safety: the gate calls the same `get_set_detail` the page 404s on, via the
// cache()'d shared fetch — so it is a STRICT SUBSET of the page's own condition
// (it cannot invent a 404) and it costs no extra round trip. It FAILS OPEN on
// any RPC error.

import { notFound, permanentRedirect } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { entityResolves, decodeSlugOrNull, resolveSetAlias, fetchEntityDetailRaw, firstEntityRow } from "@/lib/entity-detail-gate"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function SetSegmentLayout({ children, params }: LayoutProps) {
  const { collection, slug: rawSlug } = await params

  // A malformed percent-escape means we cannot reproduce the key the page will
  // use — fail open rather than 404 on a guess.
  const slug = decodeSlugOrNull(rawSlug)
  if (slug === null) return <>{children}</>

  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  if (!(await entityResolves("set", coll.id, slug))) {
    // The UNACCENTED spelling of an accented set name ("idolos" for "Ídolos",
    // whose canonical slug is "-dolos") answers 308 to the canonical page, as
    // the team route already does (2026-09-25). Consulted only on a would-be 404.
    const alias = await resolveSetAlias(coll.id, slug)
    // A failed alias read must not become a 404 for a URL that may be real.
    if (!alias.ok) throw new Error(`set alias lookup unavailable for ${slug}`)
    if (alias.target && alias.target !== slug) {
      permanentRedirect(`/${collection}/set/${encodeURIComponent(alias.target)}`)
    }
    notFound()
  }

  // 2026-10-21 (#204 design half): a Panini product's set has ONE URL. A product key whose set
  // name no other product carries (p1814-… when only it has "Splash!") answers 308 to the name
  // slug get_set_detail names as canonical, so the two spellings are never two indexed pages.
  // Same cache()'d read as the gate above — no extra round trip — and it fails open: an error
  // or a missing field renders the page where it is.
  if (collection === "panini-blockchain") {
    const { canonical } = await paniniCanonicalSetSlug(coll.id, slug)
    if (canonical && canonical !== slug) {
      permanentRedirect(`/${collection}/set/${encodeURIComponent(canonical)}`)
    }
  }

  return <>{children}</>
}

// A failed read is `ok: false` — distinguishable from "no canonical slug" (a combined view, or a
// read that predates the field) — and either way the page renders where it is: the 308 is skipped,
// never replaced by a 404, and the SAME product's set is shown, so nothing false is asserted.
async function paniniCanonicalSetSlug(collectionId: string, slug: string): Promise<{ canonical: string | null; ok: boolean }> {
  try {
    const { data, error } = await fetchEntityDetailRaw("set", collectionId, slug)
    if (error) return { canonical: null, ok: false }
    const row = firstEntityRow<{ canonical_slug?: unknown }>(data)
    return { canonical: row && typeof row.canonical_slug === "string" && row.canonical_slug ? row.canonical_slug : null, ok: true }
  } catch {
    return { canonical: null, ok: false }
  }
}
