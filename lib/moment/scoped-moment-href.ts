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
 * claims (~99% of All Day ids). A claim is checked in EVERY source that resolver reads
 * (2026-10-27: an id only another collection had LISTED was forwarded and rendered that
 * collection's page). Only on a collision is it resolved here, scoped:
 *  - this collection's `moments` row → /moment/<moment uuid> (globally unique);
 *  - else this collection's wallet_moments_cache, sales or listing row → its edition
 *    page (`moments.nft_id` is globally unique, so the colliding twin has no row there);
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
  // resolve_moment_id keys a listing's collection on its EDITION (editions.collection_id).
  // Started once, read up to twice (a PostgREST builder re-fetches on every await).
  const listed = Promise.resolve(
    db.from("cached_listings_v2").select("edition_id").eq("flow_id", momentId).not("edition_id", "is", null).limit(20),
  ).catch((e: unknown) => ({ data: null, error: e ?? { message: "listing read threw" } }))
  if (!collides) {
    // The Top Shot listing tables belong to Top Shot by construction, so they only
    // collide for another collection.
    const topShot = cid === getCollectionUuid("nba-top-shot")
    const none = { data: [], error: null }
    const [ow, os, ol, tal, tsl] = await Promise.all([
      db.from("wallet_moments_cache").select("collection_id").eq("moment_id", momentId).neq("collection_id", cid).limit(1),
      db.from("sales").select("collection_id").eq("nft_id", momentId).neq("collection_id", cid).limit(1),
      listed,
      topShot ? none : db.from("topshot_active_listings").select("nft_id").eq("nft_id", momentId).not("edition_id", "is", null).limit(1),
      topShot ? none : db.from("ts_listings").select("flow_id").eq("flow_id", momentId).limit(1),
    ])
    if (ow.error || os.error || ol.error || tal.error || tsl.error) return "unavailable"
    collides = (ow.data?.length ?? 0) > 0 || (os.data?.length ?? 0) > 0 || (tal.data?.length ?? 0) > 0 || (tsl.data?.length ?? 0) > 0
    const listedIds = (ol.data ?? []).map((r: { edition_id: string }) => r.edition_id)
    if (!collides && listedIds.length > 0) {
      const le = await db.from("editions").select("id").in("id", listedIds).neq("collection_id", cid).limit(1)
      if (le.error) return "unavailable"
      collides = (le.data?.length ?? 0) > 0
    }
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
  if (eid) {
    const ed = await db.from("editions").select("external_id").eq("id", eid).limit(1)
    if (ed.error) return "unavailable"
    const ext = ed.data?.[0]?.external_id
    if (ext) return `/${collection}/edition/${encodeURIComponent(String(ext))}`
  }
  // Last: this collection's own listing (an untracked holder with no sale yet).
  const ol = await listed
  if (ol.error) return "unavailable"
  const listedIds = (ol.data ?? []).map((r: { edition_id: string }) => r.edition_id)
  if (listedIds.length === 0) return null
  const le = await db.from("editions").select("external_id").in("id", listedIds).eq("collection_id", cid).not("external_id", "is", null).limit(1)
  if (le.error) return "unavailable"
  const lext = le.data?.[0]?.external_id
  return lext ? `/${collection}/edition/${encodeURIComponent(String(lext))}` : null
}
