// app/(collections)/[collection]/character/[slug]/layout.tsx
//
// The character segment is Disney Pinnacle's name for the player page (2026-10-31).
// Any other collection has players, not characters: 308 to its /player/ URL before
// the page runs. For Pinnacle, the player segment's own existence gate (404 /
// alias redirect) applies unchanged.

import { permanentRedirect } from "next/navigation"
import { isPinnacleUrlSlug } from "@/lib/collection-slug"
import PlayerSegmentLayout from "../../player/[slug]/layout"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ collection: string; slug: string }>
}

export default async function CharacterSegmentLayout(props: LayoutProps) {
  const { collection, slug } = await props.params
  if (!isPinnacleUrlSlug(collection)) permanentRedirect(`/${collection}/player/${slug}`)
  return PlayerSegmentLayout(props)
}
