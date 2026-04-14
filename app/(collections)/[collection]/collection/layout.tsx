import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("collection", "Flow", id)
  return pageMetadata("collection", collection.label, collection.id)
}

export default function CollectionLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
