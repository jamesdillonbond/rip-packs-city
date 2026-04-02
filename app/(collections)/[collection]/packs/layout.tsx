import type { Metadata } from "next"
import { getCollection } from "@/lib/collections"
import { collectionPageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const params = await props.params
  const collection = getCollection(params.collection)
  const label = collection?.label ?? "NBA Top Shot"

  const pageMeta = collectionPageMetadata("packs", label) as Metadata
  const title = (pageMeta.title as string) ?? `Pack EV Calculator — ${label}`
  const description =
    (pageMeta.description as string) ??
    `Calculate expected value for every ${label} pack on the secondary market. Real-time FMV, pull rates, and tier breakdowns powered by RPC.`
  return {
    title,
    description,
    openGraph: {
      title: title + " | Rip Packs City",
      description,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  }
}

export default function PacksLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
