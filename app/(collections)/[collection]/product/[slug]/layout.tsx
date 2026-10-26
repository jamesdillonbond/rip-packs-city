// app/(collections)/[collection]/product/[slug]/layout.tsx
//
// Existence gate for /<collection>/product/<name-slug> (Panini products, 2026-10-25).
// Lives in the layout for the same reason as the series/set gates: a layout is awaited before the first
// flush, so an unknown product commits a real 404, not a soft one. Only a collection with the registry's
// `productPages` flag has the route at all.
//
// Fails OPEN: a failed read renders the page (which says it couldn't load), never a guessed 404.
// An upper-case spelling 308s to the lower-case slug the rollup stores (slugs are lower-case by construction).

import { notFound, permanentRedirect } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { fetchPaniniProduct, paniniProductHref } from "@/lib/panini/product"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function ProductSegmentLayout({ children, params }: LayoutProps) {
  const { collection, slug: rawSlug } = await params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll || !getCollection(coll.urlSlug)?.productPages) notFound()

  const slug = decodeSlugOrNull(rawSlug)
  if (slug === null) return <>{children}</>
  if (slug !== slug.toLowerCase()) permanentRedirect(paniniProductHref(collection, slug.toLowerCase()))

  const res = await fetchPaniniProduct(slug)
  if (!res.ok) return <>{children}</>
  if (!res.product) notFound()

  return <>{children}</>
}
