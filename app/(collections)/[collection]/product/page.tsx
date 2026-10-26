// app/(collections)/[collection]/product/page.tsx
//
// Panini products index (2026-10-25): every product page, by sport. Only collections with the registry's
// `productPages` switch have it. A failed read renders "couldn't load", never an empty list.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { collectionDisplayName, collectionOgUrl, NOT_FOUND_METADATA, OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"
import { listPaniniProducts } from "@/lib/panini/product"
import PaniniProductIndex from "@/components/entity/PaniniProductIndex"

export const revalidate = 1800

type Props = { params: Promise<{ collection: string }> }

function enabled(collection: string): boolean {
  const coll = getCollectionByUrlSlug(collection)
  return !!(coll && getCollection(coll.urlSlug)?.productPages)
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { collection } = await props.params
  if (!enabled(collection)) return NOT_FOUND_METADATA
  const title = "Panini Products — Card Values, Sets & Sales by Product"
  const description = "Every Panini digital card product RPC has seen — soccer, NBA, NFL, WNBA, MLB and NASCAR — with its sets, fair market values, live asks, recent sales and packs."
  const url = `/${collection}/product` // resolved against the root layout's metadataBase
  // 2026-10-26: the collection's card (the index has no entity card of its own) instead of none.
  const image = collectionOgUrl("panini-blockchain")
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { ...OG_INHERITED, title, description, url, images: [{ url: image, width: 1200, height: 630, alt: "Panini products" }] },
    twitter: { ...TWITTER_INHERITED, title, description, images: [image] },
  }
}

export default async function PaniniProductIndexPage(props: Props) {
  const { collection } = await props.params
  if (!enabled(collection)) notFound()
  const rows = await listPaniniProducts().catch(() => null)
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 48px" }}>
      <PaniniProductIndex collection={collection} collectionLabel={collectionDisplayName(collection)} rows={rows} />
    </div>
  )
}
