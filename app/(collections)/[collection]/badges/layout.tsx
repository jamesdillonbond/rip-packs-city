import type { Metadata } from "next"
import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { collectionHasPage, getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("badges", "Flow", id)
  return pageMetadata("badges", collection.label, collection.id)
}

// Server-side guard: badges are a Top Shot-native concept (Rookie Year,
// Top Shot Debut, Championship). AllDay has parallels but not the same
// badge taxonomy; Golazos and Pinnacle don't have badges at all. The tab
// bar hides the tab for collections without badges, but a user pasting a
// /nfl-all-day/badges URL still lands here — redirect them to overview
// rather than render a half-broken page.
export default async function BadgesLayout(props: { children: ReactNode; params: Promise<{ collection: string }> }) {
  const { collection: id } = await props.params
  if (!collectionHasPage(id, "badges")) {
    redirect(`/${id || "nba-top-shot"}/overview`)
  }
  return <>{props.children}</>
}
