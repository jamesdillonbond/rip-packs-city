// lib/moment/scoped-moment-href.ts
//
// Collection-scoped resolution for /[collection]/moment/<id> (2026-10-20). A flow
// nft_id is unique only WITHIN a collection; see the page for the incident.

import { getCollectionUuid } from "@/lib/collections"
import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// Each read is bounded: a slow read resolves "unavailable" and the caller forwards as before.
const MOMENT_REDIRECT_READ_MS = 4000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const b = (p: any, label: string) => withBoardBudget(p, label, MOMENT_REDIRECT_READ_MS, "moment-redirect/")

/**
 * Where an nft_id of THIS collection lives. /moment/<id> (resolve_moment_id) renders
 * the full serial page through five fallbacks (moments, wmc, listings, Top Shot
 * listings, sales), so the unscoped forward is KEPT for every id no other collection
 * claims (~99% of All Day ids). Only on a collision is it resolved here, scoped:
 *  - this collection's `moments` row → /moment/<moment uuid> (globally unique);
 *  - else this collection's wallet_moments_cache or sales row → its edition page
 *    (`moments.nft_id` is globally unique, so the colliding twin has no row there);
 *  - else null (404) — never another collection's Moment.
 * A non-numeric id (moment / edition uuid, Solana mint) cannot collide: forwarded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveScopedMoment(client: any = supabaseAdmin, collection: string, momentId: string): Promise<string | null | "unavailable"> {
  try {
    return (await b(resolveScopedMomentUnbounded(client, collection, momentId), "scoped")) as string | null | "unavailable"
  } catch {
    return "unavailable"
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveScopedMomentUnbounded(client: any, collection: string, momentId: string): Promise<string | null | "unavailable"> {
  const unscoped = `/moment/${encodeURIComponent(momentId)}`
  const cid = getCollectionUuid(collection)
  if (!cid || !/^\d+$/.test(momentId)) return unscoped
  const db = client
  const m = await db.from("moments").select("id, collection_id").eq("nft_id", momentId).limit(1)
  if (m.error) return "unavailable"
  const row = m.data?.[0]
  if (row && row.collection_id === cid) return `/moment/${encodeURIComponent(String(row.id))}`
  let collides = !!row // a moments row of ANOTHER collection
  if (!collides) {
    const [ow, os] = await Promise.all([
      db.from("wallet_moments_cache").select("collection_id").eq("moment_id", momentId).neq("collection_id", cid).limit(1),
      db.from("sales").select("collection_id").eq("nft_id", momentId).neq("collection_id", cid).limit(1),
    ])
    if (ow.error || os.error) return "unavailable"
    collides = (ow.data?.length ?? 0) > 0 || (os.data?.length ?? 0) > 0
  }
  if (!collides) return unscoped
  const w = await db
    .from("wallet_moments_cache")
    .select("edition_key")
    .eq("moment_id", momentId)
    .eq("collection_id", cid)
    .not("edition_key", "is", null)
    .limit(1)
  if (w.error) return "unavailable"
  const key = w.data?.[0]?.edition_key
  if (key) return `/${collection}/edition/${encodeURIComponent(String(key))}`
  const sl = await db.from("sales").select("edition_id").eq("nft_id", momentId).eq("collection_id", cid).not("edition_id", "is", null).limit(1)
  if (sl.error) return "unavailable"
  const eid = sl.data?.[0]?.edition_id
  if (!eid) return null
  const ed = await db.from("editions").select("external_id").eq("id", eid).limit(1)
  if (ed.error) return "unavailable"
  const ext = ed.data?.[0]?.external_id
  return ext ? `/${collection}/edition/${encodeURIComponent(String(ext))}` : null
}
