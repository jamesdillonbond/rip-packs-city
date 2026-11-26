// app/(collections)/[collection]/property/[slug]/layout.tsx
//
// Existence gate for /<collection>/property/<slug> — a league / brand a Panini product is made under
// (2026-11-26). In the layout for the same reason as the product gate: a layout is awaited before the first
// flush, so an unknown slug commits a real 404. Only a collection with the registry's `productPages` flag has
// the route. Fails OPEN: a failed read renders the page (which says it couldn't load), never a guessed 404.

import { notFound, permanentRedirect } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { fetchPaniniPropertyPage, paniniPropertyHref } from "@/lib/panini/properties"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function PropertySegmentLayout({ children, params }: LayoutProps) {
  const { collection, slug: rawSlug } = await params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll || !getCollection(coll.urlSlug)?.productPages) notFound()

  const slug = decodeSlugOrNull(rawSlug)
  if (slug === null) return <>{children}</>
  if (slug !== slug.toLowerCase()) permanentRedirect(paniniPropertyHref(collection, slug.toLowerCase()))

  const res = await fetchPaniniPropertyPage(slug)
  if (!res.ok) return <>{children}</>
  if (!res.page) notFound()

  return <>{children}</>
}
