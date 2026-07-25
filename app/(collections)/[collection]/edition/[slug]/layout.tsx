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

import { notFound } from "next/navigation"
import { getCollectionByUrlSlug, isPinnacleUrlSlug } from "@/lib/collection-slug"
import { entityResolves, decodeSlugOrNull } from "@/lib/entity-detail-gate"

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
  if (collection === "nba-top-shot" && slug.includes("-")) notFound()

  if (!(await entityResolves("edition", coll.id, slug))) notFound()

  return <>{children}</>
}
