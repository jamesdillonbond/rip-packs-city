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
import { resolveScopedMoment } from "@/lib/moment/scoped-moment-href"

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

  // ⛔ 2026-10-20 live sweep: a bare forward to /moment/<id> DROPPED THE COLLECTION,
  // and /moment resolves an nft_id with no collection (resolve_moment_id prefers Top
  // Shot on a collision). /nfl-all-day/moment/1000080 rendered Top Shot's Gordon
  // Hayward instead of All Day's Dallas Goedert #390 — ~1% of All Day ids collide
  // (203 of 20,000 sampled). A flow nft_id is unique only WITHIN a collection, so it
  // is resolved here, scoped (CLAUDE.md: scope every moment_id read by collection).
  const target = await resolveScopedMoment(undefined, collection, momentId)
  if (target === "unavailable") {
    // Read failed: the unscoped forward is the pre-10-20 behaviour, and for the ~99%
    // of ids that do not collide it is correct; no worse than before.
    redirect(`/moment/${encodeURIComponent(momentId)}`)
  }
  if (!target) notFound()
  redirect(target)
}
