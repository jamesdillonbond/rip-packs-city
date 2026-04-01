import type { Metadata } from "next"
import { getCollection } from "@/lib/collections"
import { collectionPageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const params = await props.params
  const collection = getCollection(params.collection)
  if (!collection) return {}

  // Get page-specific SEO from lib/seo.ts (defaults to "collection" tab)
  const pageMeta = collectionPageMetadata("collection")

  // Merge with collection-specific context
  const title = `${collection.label} — ${(pageMeta as any).title || "Collection"}`
  const description =
    (pageMeta as any).description ||
    `Collector intelligence for ${collection.label} on Rip Packs City.`
  const canonical = `https://rip-packs-city.vercel.app/${collection.id}`

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${title} | Rip Packs City`,
      description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  }
}

export default function CollectionSegmentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
