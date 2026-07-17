// app/(collections)/[collection]/moment/[momentId]/page.tsx
//
// Per-NFT moment page. Thin resolver: forwards to the canonical public moment
// page at `/moment/<id>`, which resolves the id as a flow nft_id (numeric),
// moment uuid, or edition uuid via the get_moment_detail SECDEF RPC and renders
// the full per-NFT / edition detail (and notFound()s for genuinely unknown ids).
//
// History (2026-07-17, H2): this route previously read a nonexistent
// `editions.route_slug` column, so the lookup ALWAYS errored to null and every
// moment silently fell through to the collection-wide listing — a dead end. The
// only internal caller (PackLifecycleClient) passes a flow nft_id, which the
// canonical page resolves directly, so forwarding there lands the user on the
// real detail surface instead of a generic list.

import { redirect, notFound } from "next/navigation"
import { getCollection, publishedCollections } from "@/lib/collections"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ collection: string; momentId: string }>
}

export default async function MomentRedirectPage({ params }: PageProps) {
  const { collection, momentId: rawMomentId } = await params
  const momentId = decodeURIComponent(rawMomentId)

  const c = getCollection(collection)
  if (!c) notFound()

  // Only published collections carry moment data in our index; the catch-all
  // [collection] segment also serves unpublished placeholders.
  if (!publishedCollections().some((x) => x.id === collection)) {
    redirect(`/${collection}/overview`)
  }

  if (!momentId) {
    redirect(`/${collection}/collection`)
  }

  // Canonical per-NFT / edition detail page. It self-resolves the id and renders
  // the specific serial when the id is an nft_id / moment uuid, or the edition
  // aggregate for an edition uuid; it notFound()s if the id is truly unknown.
  redirect(`/moment/${encodeURIComponent(momentId)}`)
}
