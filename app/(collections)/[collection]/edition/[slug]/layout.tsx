// app/(collections)/[collection]/edition/[slug]/layout.tsx
//
// Existence gate for /<collection>/edition/<slug>, and the ONLY place it can live.
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
// Safety: the gate calls the same `get_edition_detail` the page 404s on, via the
// cache()'d shared fetch — so it is a STRICT SUBSET of the page's own condition
// (it cannot invent a 404) and it costs no extra round trip. It FAILS OPEN on
// any RPC error.

import { notFound, permanentRedirect } from "next/navigation"
import { getCollectionByUrlSlug, isPinnacleUrlSlug } from "@/lib/collection-slug"
import { entityResolves, decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { lookupTopShotFossilRedirect } from "@/lib/edition/fossil-redirect"
import { lookupTopShotEditionAliasRedirect } from "@/lib/edition/alias-redirect"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function EditionSegmentLayout({ children, params }: LayoutProps) {
  const { collection, slug: rawSlug } = await params

  // A malformed percent-escape means we cannot reproduce the key the page will
  // use — fail open rather than 404 on a guess.
  const slug = decodeSlugOrNull(rawSlug)
  if (slug === null) return <>{children}</>

  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // Pinnacle edition URLs are 308'd to /pinnacle/moment/<render_id> by the page
  // itself. Do not gate them here — the redirect must win, and the Pinnacle key
  // space is not get_edition_detail's.
  if (isPinnacleUrlSlug(collection)) return <>{children}</>

  // The ~6,404 inert UUID-keyed Top Shot fossil editions: canonical TS slugs are
  // `setID:playID` (no hyphen), fossils are `<uuid>:<uuid>` (hyphenated). The
  // page already 404s these; doing it here makes it a real 404.
  // 2026-10-03 (Search Console): a fossil whose canonical twin is UNAMBIGUOUS
  // 308s to it instead (topshot_edition_uuid_redirects, 4,447 rows) — and it
  // has to happen HERE, because this gate runs before the page's own arm. A
  // miss, an error or a timeout is the same 404 as before.
  if (collection === "nba-top-shot" && slug.includes("-")) {
    const canonical = await lookupTopShotFossilRedirect(slug)
    if (canonical) permanentRedirect(`/${collection}/edition/${encodeURIComponent(canonical)}`)
    notFound()
  }

  // #175 (2026-10-10): a Top Shot ALIAS key — the API's `149:<play>::8` for
  // the chain's `152:<play>` — 308s to the canonical page that holds the sales,
  // owners and market (topshot_edition_aliases, 25 rows). It happens HERE for
  // the same reason the fossil 308 does: a redirect thrown after the shell
  // flushed is a 200 with a client hop. A miss, an error or a timeout renders
  // the alias page as before — never a guessed redirect, never a 404.
  if (collection === "nba-top-shot") {
    const canonical = await lookupTopShotEditionAliasRedirect(slug)
    if (canonical) permanentRedirect(`/${collection}/edition/${encodeURIComponent(canonical)}`)
  }

  if (!(await entityResolves("edition", coll.id, slug))) notFound()

  return <>{children}</>
}
