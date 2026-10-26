// app/(collections)/[collection]/product/[slug]/page.tsx
//
// Panini PRODUCT page — the counterpart of Top Shot's series page (parity pass 2026-10-25). The layout
// gates existence and the canonical slug; this page renders the product (PaniniProductBody) or, on a
// failed read, says it couldn't load. Data: lib/panini/product.ts (panini_product_rollup, hourly).

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { collectionDisplayName, entityUrl, NOT_FOUND_METADATA, OG_INHERITED, TWITTER_INHERITED, paniniProductOgUrl } from "@/lib/seo"
import { fetchPaniniProduct } from "@/lib/panini/product"
import { fetchPaniniProductPacks } from "@/lib/panini/edition-extras"
import PaniniProductBody, { PaniniProductUnavailable } from "@/components/entity/PaniniProductBody"

export const revalidate = 1800

type Props = { params: Promise<{ collection: string; slug: string }> }

async function load(props: Props) {
  const { collection, slug: rawSlug } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  const slug = decodeSlugOrNull(rawSlug)
  return { collection, coll, slug }
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { collection, coll, slug } = await load(props)
  if (!(coll && getCollection(coll.urlSlug)?.productPages) || slug === null) return NOT_FOUND_METADATA
  const res = await fetchPaniniProduct(slug)
  if (!res.ok) return { title: "Panini product", robots: { index: false, follow: true } }
  const p = res.product
  if (!p) return NOT_FOUND_METADATA
  const url = entityUrl(collection, "product", p.slug)
  const title = `${p.name} — Panini Card Values, Sets & Sales`
  const description = `${p.name}: ${p.editions.toLocaleString("en-US")} editions RPC has seen across ${p.sets.toLocaleString("en-US")} sets, with fair market values, live asks on Panini's marketplace, recent sales and packs.`
  return {
    title,
    description,
    alternates: { canonical: url },
    // 2026-10-26: a branded card like a series page's (/api/og/series), not the site default.
    openGraph: { ...OG_INHERITED, title, description, url, images: [{ url: paniniProductOgUrl(p.slug), width: 1200, height: 630, alt: p.name }] },
    twitter: { ...TWITTER_INHERITED, title, description, images: [paniniProductOgUrl(p.slug)] },
  }
}

export default async function PaniniProductPage(props: Props) {
  const { collection, coll, slug } = await load(props)
  if (!(coll && getCollection(coll.urlSlug)?.productPages) || slug === null) notFound()
  const res = await fetchPaniniProduct(slug)
  if (!res.ok) return <PaniniProductUnavailable collection={collection} />
  if (!res.product) notFound()
  const ids = res.product.product_set_ids.length ? res.product.product_set_ids : [res.product.product_set_id]
  const packs = await fetchPaniniProductPacks(ids).catch(() => ({ packs: null, productName: null }))
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 48px" }}>
      <PaniniProductBody collection={collection} collectionLabel={collectionDisplayName(collection)} product={res.product} packs={packs} />
    </div>
  )
}
