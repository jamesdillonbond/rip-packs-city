import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata, unknownCollectionMetadata } from "@/lib/seo"
import FeatureTabGate from "@/components/collection/FeatureTabGate"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return unknownCollectionMetadata("market", id)
  return pageMetadata("market", collection.label, collection.id)
}

export default async function MarketLayout(
  props: { children: ReactNode; params: Promise<{ collection: string }> }
) {
  const { collection: id } = await props.params
  return <FeatureTabGate id={id} page="market">{props.children}</FeatureTabGate>
}
