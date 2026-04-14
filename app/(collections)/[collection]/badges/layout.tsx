import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("badges", "Flow", id)
  return pageMetadata("badges", collection.label, collection.id)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function BadgesLayout({ children }: { children: ReactNode; params: Promise<{ collection: string }> }) {
  return <>{children}</>
}
