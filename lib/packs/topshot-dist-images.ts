// lib/packs/topshot-dist-images.ts
//
// Fills `pack_distributions.image_url` for Top Shot distributions that have
// none, from the pack NFTs themselves.
//
// WHY (2026-09-25). Dapper's `searchPackNft` GraphQL — the only image writer —
// has answered 530 since ~08-28, and the PDS contract that now names new
// distributions (topshot-pack-dist-names-onchain) carries no image for most of
// them. 49 dists (8734–8869) sat with image_url NULL, so a collector's
// transaction history and the pack page showed a "▣" placeholder.
//
// SOURCE. Every Top Shot PackNFT's MetadataViews.Display thumbnail is
//   https://media.nbatopshot.com/packnfts/<pack_nft_id>/media/image
// and that URL redirects to the DISTRIBUTION's own image, e.g.
//   https://asset-preview.nbatopshot.com/cdn-cgi/image/width=256,…/distributions/production-…_POR.png
// Verified 2026-09-25: 49 of 49 dists answered; dist 8710's redirect equals the
// image_url it already had (positive control); a made-up pack id is a 404.
// We read the redirect (never download the image) and store the original by
// stripping Cloudflare's `cdn-cgi/image/<options>/` resize segment.
//
// HONESTY. A read or write error, or a response that is neither a redirect nor
// a 404, fails the pass (ok=false, first error named). A 404 is `no_image` and
// a dist with no known pack is `no_pack` — both left NULL, never guessed. The
// written count is the rows the fill-only UPDATE (`image_url IS NULL`) returned.

export const PACKNFT_MEDIA_BASE = "https://media.nbatopshot.com/packnfts"
const FETCH_TIMEOUT_MS = 10_000

const CDN_RESIZE = /^(https:\/\/asset-preview\.nbatopshot\.com)\/cdn-cgi\/image\/[^/]+\//

/**
 * The original image URL behind a pack-media redirect target, or null when the
 * target is not one of Top Shot's own asset hosts (never store a URL we do not
 * recognise).
 */
export function originalImageUrl(location: string | null | undefined): string | null {
  if (!location) return null
  const url = location.trim().replace(CDN_RESIZE, "$1/")
  if (url.startsWith("https://asset-preview.nbatopshot.com/")) return url
  if (url.startsWith("https://storage.googleapis.com/assets-nbatopshot/")) return url
  return null
}

export interface DistImagePassResult {
  ok: boolean
  error: string | null
  complete: boolean
  imageless: number
  filled: number
  no_pack: number
  no_image: number
  fetch_errors: number
  write_errors: number
}

interface Options {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
  collectionId: string
  maxRows: number
  /** Epoch ms after which the pass stops (complete=false). */
  deadlineMs: number
  fetchImpl?: typeof fetch
}

export async function fillMissingDistImages(opts: Options): Promise<DistImagePassResult> {
  const { db, collectionId, maxRows, deadlineMs } = opts
  const doFetch = opts.fetchImpl ?? fetch
  const r: DistImagePassResult = {
    ok: true, error: null, complete: true,
    imageless: 0, filled: 0, no_pack: 0, no_image: 0, fetch_errors: 0, write_errors: 0,
  }
  const fail = (msg: string) => {
    r.ok = false
    r.error = r.error ?? msg
  }

  const { data, error } = await db
    .from("pack_distributions")
    .select("id,dist_id")
    .eq("collection_id", collectionId)
    .is("image_url", null)
    .order("dist_id", { ascending: true })
    .limit(maxRows + 1)
  if (error) {
    fail(`image read failed: ${error.message}`)
    return r
  }
  const all = (data ?? []) as Array<{ id: string; dist_id: string }>
  r.complete = all.length <= maxRows
  const rows = all.slice(0, maxRows)
  r.imageless = rows.length

  for (const row of rows) {
    if (Date.now() > deadlineMs) {
      r.complete = false
      break
    }

    // Any pack of the dist will do — purchased first, then opened (a dist
    // discovered from rips alone may have no purchase row; the media redirect
    // still answers for a burned pack, verified 2026-09-25).
    let packNftId: string | undefined
    let lookupFailed = false
    for (const [table, distCol] of [["pack_purchases", "pack_dist_id"], ["pack_rips", "dist_id"]] as const) {
      const pack = await db
        .from(table)
        .select("pack_nft_id")
        .eq("collection_id", collectionId)
        .eq(distCol, row.dist_id)
        .order("sealed_at", { ascending: false })
        .limit(1)
      if (pack.error) {
        fail(`pack lookup failed (${table}): ${pack.error.message}`)
        lookupFailed = true
        break
      }
      const id = (pack.data ?? [])[0]?.pack_nft_id as string | undefined
      if (id && /^\d+$/.test(id)) {
        packNftId = id
        break
      }
    }
    if (lookupFailed) continue
    if (!packNftId) {
      r.no_pack++
      continue
    }

    let location: string | null
    try {
      const res = await doFetch(`${PACKNFT_MEDIA_BASE}/${packNftId}/media/image?format=jpeg&width=256`, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 404) {
        r.no_image++
        continue
      }
      location = res.headers.get("location")
      if (!location) throw new Error(`HTTP ${res.status} with no redirect`)
    } catch (e) {
      r.fetch_errors++
      fail(`pack media ${packNftId}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const imageUrl = originalImageUrl(location)
    if (!imageUrl) {
      r.fetch_errors++
      fail(`pack media ${packNftId}: unrecognised redirect target`)
      continue
    }

    const upd = await db
      .from("pack_distributions")
      .update({ image_url: imageUrl, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("image_url", null)
      .select("id")
    if (upd.error) {
      r.write_errors++
      fail(`image write: ${upd.error.message}`)
      continue
    }
    r.filled += Array.isArray(upd.data) ? upd.data.length : 0
  }

  return r
}
