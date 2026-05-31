// app/(collections)/[collection]/moment/[momentId]/page.tsx
//
// Per-NFT moment page. Currently a thin resolver: looks up the moment's
// edition via wallet_moments_cache → editions, then redirects to the
// canonical edition detail page so the rest of the app can keep linking
// `/${slug}/moment/${momentId}` without 404ing.
//
// A full per-NFT view (current owner, transfer history, lock state) is
// scoped for a later pass — for now the edition page is the closest match.
// If we can't resolve a moment to an edition (rare; happens for moments
// outside any indexed wallet) we fall back to the collection-wide listing.

import { redirect, notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollection, getCollectionUuid, publishedCollections } from "@/lib/collections"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ collection: string; momentId: string }>
}

async function resolveEditionRouteSlug(opts: {
  collectionUuid: string
  momentId: string
}): Promise<string | null> {
  // Path A: wallet_moments_cache holds (moment_id, edition_key) for every
  // moment seen by any indexed wallet. We then bridge edition_key → editions.id
  // and read editions.route_slug. This works for non-Pinnacle collections
  // where edition_key matches an external_id pattern.
  const { data: wmc } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("edition_key")
    .eq("collection_id", opts.collectionUuid)
    .eq("moment_id", opts.momentId)
    .limit(1)
    .maybeSingle()

  const editionKey = wmc?.edition_key as string | null | undefined
  if (!editionKey) return null

  // Try editions.external_id first (works for TS, AllDay, Golazos, UFC).
  const { data: ed } = await (supabaseAdmin as any)
    .from("editions")
    .select("route_slug")
    .eq("collection_id", opts.collectionUuid)
    .eq("external_id", editionKey)
    .limit(1)
    .maybeSingle()

  if (ed?.route_slug) return ed.route_slug as string

  // Fallback for Pinnacle: pinnacle_editions has its own route slug column.
  const { data: ped } = await (supabaseAdmin as any)
    .from("pinnacle_editions")
    .select("route_slug")
    .eq("edition_key", editionKey)
    .limit(1)
    .maybeSingle()

  return (ped?.route_slug as string | null | undefined) ?? null
}

export default async function MomentRedirectPage({ params }: PageProps) {
  const { collection, momentId: rawMomentId } = await params
  const momentId = decodeURIComponent(rawMomentId)

  const c = getCollection(collection)
  if (!c) notFound()

  // Only published collections route through here — the catch-all
  // [collection] segment also serves panini-blockchain etc., which don't
  // have moment data in our index.
  if (!publishedCollections().some((x) => x.id === collection)) {
    redirect(`/${collection}/overview`)
  }

  const collectionUuid = getCollectionUuid(collection)
  if (collectionUuid && momentId) {
    try {
      const slug = await resolveEditionRouteSlug({ collectionUuid, momentId })
      if (slug) {
        redirect(`/${collection}/edition/${encodeURIComponent(slug)}`)
      }
    } catch (err) {
      // Don't unwind a NEXT_REDIRECT thrown by redirect() above — re-throw it.
      if (err && typeof err === "object" && "digest" in err) throw err
      console.log("[moment-resolver]", momentId, err)
    }
  }

  // Couldn't resolve — drop them into the collection-wide listing where they
  // can search/filter. Keeps every link from 404ing while we build the real
  // per-NFT detail surface.
  redirect(`/${collection}/collection`)
}
