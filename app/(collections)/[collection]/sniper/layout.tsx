import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata, unknownCollectionMetadata } from "@/lib/seo"
import PopularOnCollection from "@/components/entity/PopularOnCollection"
import FeatureTabGate from "@/components/collection/FeatureTabGate"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return unknownCollectionMetadata("sniper", id)
  return pageMetadata("sniper", collection.label, collection.id)
}

// 2026-09-07: `PopularOnCollection` (the server-rendered catalog fan-out that
// /overview carries) is mounted under this tab too. The tab's page is a client
// shell behind a Suspense boundary, so an anonymous crawler received ≤ 180
// chars of <main> ("Loading …") and ZERO entity links from a sitemap URL at
// priority 0.7 — measured 2026-09-07 on every published collection. The block
// gives Googlebot the same 18 edition + set/player/team/series links the
// overview has; its reads are Data-Cached per collection for an hour.
export default async function SniperLayout(props: {
  children: ReactNode
  params: Promise<{ collection: string }>
}) {
  const { collection } = await props.params
  // 2026-10-26 (Candy parity pass): the only tab layout without its FeatureTabGate. On a
  // collection that does not ship a Sniper (Candy MLB, UFC) the client shell rendered and the
  // feed answered `deals: []` with no failure flag, so the page told a reader "No deals match
  // your filters" — a market claim about a board that has no source for that collection.
  // Every in-site link to this tab is already gated on collectionHasPage(…, "sniper").
  return (
    <FeatureTabGate id={collection} page="sniper">
      {props.children}
      <PopularOnCollection collection={collection} />
    </FeatureTabGate>
  )
}
