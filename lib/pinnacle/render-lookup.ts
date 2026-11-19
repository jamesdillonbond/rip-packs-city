// lib/pinnacle/render-lookup.ts
//
// One lookup for "which pin (render_id) is this Pinnacle NFT?" (2026-11-08,
// handoff pinnacle-wmc-render-gap). Two readers needed it and each asked only
// Dapper's studio-platform search, which answers nothing for some pins: the
// wmc render-id lane found 972 unresolved pins every hour, resolved 0, and
// logged ok:true; sales rows sat render-less until that same search answered.
//
// Order:
//   1. RPC's own mint records — public.pinnacle_mint_events (nft_id → render_id),
//      written from the chain's PinNFTMinted events by ingest-pinnacle-mints.
//      Authoritative for every pin whose mint we indexed.
//   2. Dapper's Atlas `NFTService/GetNFTs` by id — for pins our mint index has
//      not got (it has holes: 28 of 32 unresolved sales on 11-08 were absent).
//      Until 2026-11-18 this was Studio's `searchPinnacleNft`, dead since 11-17
//      (HTTP 530). Atlas `nfts[].renderId` reproduced the mint-record render_id on
//      29 of 29 sampled pins (11-18; the 30th id Atlas did not return, so it stays
//      unresolvable — never a guess). Atlas is reached through the database
//      (lib/pinnacle/atlas-disney.ts): its WAF blocks Vercel's fetch.
// A failed mint-record read is reported, never read as "no match"; Atlas is
// still asked for every id, so a read failure costs coverage, not correctness.

import {
  atlasErrorMessage,
  atlasNftRender,
  dbAtlasDisneyCall,
  type AtlasDisneyCall,
  type AtlasRpcDb,
} from "@/lib/pinnacle/atlas-disney"

export type RenderHit = { render_id: string; serial: number | null; source: "mint_records" | "atlas" }

// GetNFTs answers ~9 KB per NFT (assets included); 100 ids ≈ 0.9 MB per response.
const ATLAS_CHUNK = 100
const READ_CHUNK = 500

/** nft_id → render_id from pinnacle_mint_events. `error` set on a failed read (map then partial). */
export async function renderIdsFromMintRecords(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  nftIds: string[],
): Promise<{ map: Map<string, string>; error: string | null }> {
  const map = new Map<string, string>()
  const ids = [...new Set(nftIds.filter(Boolean).map(String))]
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await db
      .from("pinnacle_mint_events")
      .select("nft_id, render_id")
      .in("nft_id", ids.slice(i, i + READ_CHUNK))
      .not("render_id", "is", null)
    if (error) return { map, error: error.message ?? String(error) }
    for (const r of (data ?? []) as Array<{ nft_id: unknown; render_id: unknown }>) {
      if (typeof r.render_id === "string" && r.render_id) map.set(String(r.nft_id), r.render_id)
    }
  }
  return { map, error: null }
}

/**
 * One Atlas `NFTService/GetNFTs` call for ≤ 100 ids. Throws on a failed read, with
 * the HTTP status in the message ("atlas GetNFTs HTTP 403 (Cloudflare challenge)").
 * An id Atlas does not return is simply absent from the result.
 */
export async function renderIdsFromAtlas(
  ids: string[],
  call: AtlasDisneyCall,
): Promise<Array<{ id: string; serial: number | null; render_id: string | null }>> {
  const r = await call("NFTService/GetNFTs", { product: "disney", nftIds: ids })
  if (!r.ok) throw new Error(atlasErrorMessage("NFTService/GetNFTs", r))
  const nfts = (r.body as { nfts?: unknown } | null)?.nfts
  // A body with no `nfts` array is an UNRENDERABLE answer, not "none of these exist".
  if (!Array.isArray(nfts)) throw new Error("atlas GetNFTs: response carried no nfts array")
  return nfts.map(atlasNftRender).filter((n): n is NonNullable<typeof n> => n != null)
}

export type ResolveResult = {
  hits: Map<string, RenderHit>
  fromMintRecords: number
  fromAtlas: number
  /** ids neither source could name */
  unresolvable: string[]
  mintReadError: string | null
  atlasErrors: number
  /** The FIRST chunk's error message (e.g. "atlas GetNFTs HTTP 403 (…)"), so a caller
   *  can say WHY the chunks failed. "2 gql chunk errors" alone hid a Dapper Studio
   *  outage from every alerter that attributes upstream statuses (2026-11-18, #218). */
  atlasFirstError: string | null
}

/** Mint records first, Dapper's Atlas for the rest. Never throws. */
export async function resolvePinnacleRenderIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  nftIds: string[],
  opts: { atlas?: AtlasDisneyCall } = {},
): Promise<ResolveResult> {
  const atlas = opts.atlas ?? dbAtlasDisneyCall(db as AtlasRpcDb)
  const ids = [...new Set(nftIds.filter(Boolean).map(String))]
  const hits = new Map<string, RenderHit>()
  let mintReadError: string | null = null
  try {
    const m = await renderIdsFromMintRecords(db, ids)
    mintReadError = m.error
    for (const [id, rid] of m.map) hits.set(id, { render_id: rid, serial: null, source: "mint_records" })
  } catch (e) {
    mintReadError = e instanceof Error ? e.message : String(e)
  }
  const fromMintRecords = hits.size

  let atlasErrors = 0
  let atlasFirstError: string | null = null
  const rest = ids.filter((id) => !hits.has(id))
  for (let i = 0; i < rest.length; i += ATLAS_CHUNK) {
    try {
      const nodes = await renderIdsFromAtlas(rest.slice(i, i + ATLAS_CHUNK), atlas)
      for (const n of nodes) {
        if (n.render_id && !hits.has(String(n.id))) hits.set(String(n.id), { render_id: n.render_id, serial: n.serial, source: "atlas" })
      }
    } catch (e) {
      atlasErrors++
      atlasFirstError = atlasFirstError ?? (e instanceof Error ? e.message : String(e))
    }
  }
  return {
    hits,
    fromMintRecords,
    fromAtlas: hits.size - fromMintRecords,
    unresolvable: ids.filter((id) => !hits.has(id)),
    mintReadError,
    atlasErrors,
    atlasFirstError,
  }
}
