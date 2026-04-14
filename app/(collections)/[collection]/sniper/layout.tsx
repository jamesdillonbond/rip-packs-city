import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("sniper", "Flow", id)
  return pageMetadata("sniper", collection.label, collection.id)
}

export default function SniperLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
