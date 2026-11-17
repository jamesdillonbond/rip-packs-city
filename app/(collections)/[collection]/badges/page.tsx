// app/(collections)/[collection]/badges/page.tsx
//
// The standalone per-collection badges browse tab was retired (no collection
// lists "badges" in its pages array, and nothing links to it) — badges now
// render inline on edition / moment pages via get_edition_badges_unified. The
// route lingered only as a 404 for old bookmarks / SEO (Pack H). Redirect any
// straggler to the collection overview rather than 404.

import { notFound, redirect } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"

export const dynamicParams = true

export default async function BadgesRedirect(props: { params: Promise<{ collection: string }> }) {
  const { collection } = await props.params
  if (!getCollectionByUrlSlug(collection)) notFound()
  redirect(`/${collection}/overview`)
}
