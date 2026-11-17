import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata, unknownCollectionMetadata } from "@/lib/seo"
import FeatureTabGate from "@/components/collection/FeatureTabGate"
import PopularOnCollection from "@/components/entity/PopularOnCollection"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return unknownCollectionMetadata("sets", id)
  return pageMetadata("sets", collection.label, collection.id)
}

// 2026-09-07: `PopularOnCollection` (the server-rendered catalog fan-out that
// /overview carries) is mounted under this tab too. The tab's page is a client
// shell behind a Suspense boundary, so an anonymous crawler received ≤ 180
// chars of <main> ("Loading …") and ZERO entity links from a sitemap URL at
// priority 0.7 — measured 2026-09-07 on every published collection. The block
// gives Googlebot the same 18 edition + set/player/team/series links the
// overview has; its reads are Data-Cached per collection for an hour.
export default async function SetsLayout(
  props: { children: ReactNode; params: Promise<{ collection: string }> }
) {
  const { collection: id } = await props.params
  return (
    <>
      <FeatureTabGate id={id} page="sets">{props.children}</FeatureTabGate>
      <PopularOnCollection collection={id} />
    </>
  )
}
