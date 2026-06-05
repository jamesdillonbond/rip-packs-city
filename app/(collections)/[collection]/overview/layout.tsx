import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"
import PopularOnCollection from "@/components/entity/PopularOnCollection"

// ISR-cache the segment hourly so the server-rendered public fan-out
// (PopularOnCollection) doesn't run its query on every request.
export const revalidate = 3600

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("overview", "Flow", id)
  return pageMetadata("overview", collection.label, collection.id)
}

export default async function OverviewLayout(props: {
  children: ReactNode
  params: Promise<{ collection: string }>
}) {
  const { collection } = await props.params
  return (
    <>
      {props.children}
      <PopularOnCollection collection={collection} />
    </>
  )
}
