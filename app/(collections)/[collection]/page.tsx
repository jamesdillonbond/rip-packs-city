import { permanentRedirect } from "next/navigation"

// The collection root has no page of its own: it is always the overview.
// 2026-10-21: a PERMANENT redirect (308). It was redirect() — a 307, which tells
// Google the root is the URL to keep and /overview a temporary stand-in, while
// every canonical, sitemap entry and breadcrumb names /overview.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionRoot(props: any) {
  const params = await props.params
  permanentRedirect(`/${params.collection}/overview`)
}
