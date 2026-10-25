import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { collectionPageJsonLd, pageMetadata, unknownCollectionMetadata } from "@/lib/seo"
import PopularOnCollection from "@/components/entity/PopularOnCollection"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

// ISR-cache the segment hourly so the server-rendered public fan-out
// (PopularOnCollection) doesn't run its query on every request.
export const revalidate = 3600

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return unknownCollectionMetadata("overview", id)
  return pageMetadata("overview", collection.label, collection.id)
}

export default async function OverviewLayout(props: {
  children: ReactNode
  params: Promise<{ collection: string }>
}) {
  const { collection } = await props.params
  // The collection's CollectionPage + BreadcrumbList (Home → collection) belongs
  // on the collection's own front door only — moved here from the [collection]
  // layout 2026-10-21, where it duplicated every entity page's own trail.
  const known = getCollection(collection)
  return (
    <>
      {known ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(collectionPageJsonLd(known.id)) }} />
      ) : null}
      {props.children}
      <PopularOnCollection collection={collection} />
    </>
  )
}
