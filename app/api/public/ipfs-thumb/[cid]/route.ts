// app/api/public/ipfs-thumb/[cid]/route.ts
//
// A RESIZED image for an IPFS CID: GET /api/public/ipfs-thumb/<cid>?w=<width>[&f=png]
//
// `f=png` exists for OG cards only (satori cannot decode WebP; same contract as arweave-thumb).
// The MIRROR holds WebP only; a PNG ask is transcoded from it, so cards get the mirror too.
//
// WHY (known-issues #162, 2026-09-29). Every UFC Strike image is a full-size 3.7–4.4 MB PNG, and
// pages render it with a plain <img>, so a phone downloaded megabytes per 60–120 px tile. The
// original is fetched through /api/public/ipfs-media/<cid> (same origin): that route owns the
// gateway race and its CDN copy, so a warm original costs this route ~0.6 s, not a gateway trip.
// This route decodes it once, resizes to one of a few widths, and returns WebP with an immutable
// cache, so each (CID, width) is computed ONCE and then served by the CDN.
//
// 🚨 THE MIRROR COMES FIRST (2026-11-01). "Computed once, then served by the CDN" was true only
// for a (CID, width, region) whose FIRST resize succeeded, and that first resize needs a public
// IPFS gateway to answer inside ipfs-media's 8 s budget. For UFC (582 CIDs, none pinned on
// Dapper's gateway) on 2026-11-01 none did: production logged, CID after CID,
//     ipfs.dapperlabs.com=403  gateway.pinata.cloud=abort_timeout  ipfs.io=429
// and a UFC trophy rendered as a broken image on the owner's own trophy case and its share card.
// A CDN entry is regional and evictable, so it is not a copy we own. The resized bytes now live in
// Supabase Storage (bucket IPFS_THUMB_MIRROR_BUCKET, key `<cid>/<width>.webp`):
//   1. Read the mirror. A hit is served directly — no gateway is touched.
//   2. On a miss, resize exactly as before, and WRITE THE RESULT BACK, so every success is kept.
//   3. scripts/ipfs-thumb-mirror.mjs backfills the misses offline, with long timeouts and retries
//      a page request cannot afford (.github/workflows/ipfs-thumb-mirror.yml).
// ⚠ A MIRROR FAILURE IS NEVER A RENDER FAILURE: an unreachable or erroring mirror falls through to
// the gateway path (step 2), and a failed write-back is logged and the resized image still served.
//
// ⛔ FAILS OPEN TO THE ORIGINAL, NEVER TO A BROKEN IMAGE. Anything that goes wrong (upstream
// not ok, not an image, too large, a decode error) 302s to the original proxy URL, uncached,
// so the reader still sees the art at its old weight and the next request retries the resize.
//
// Node runtime: sharp is native and cannot run on the edge runtime ipfs-media uses.

import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"
import {
  IPFS_THUMB_DEFAULT_WIDTH,
  IPFS_THUMB_MIRROR_BUCKET,
  IPFS_THUMB_WIDTHS,
  ipfsThumbMirrorKey,
  type IpfsThumbWidth,
} from "@/lib/ipfs-media"

export const runtime = "nodejs"
export const maxDuration = 30

// Same allowlist as ipfs-media: the CID is echoed into the upstream path, so this is the SSRF guard.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})$/

// A fixed set (lib/ipfs-media.ts), so a caller cannot mint unbounded cache variants (each is a CPU-costing miss).
const WIDTHS = new Set<number>(IPFS_THUMB_WIDTHS)
const DEFAULT_WIDTH = IPFS_THUMB_DEFAULT_WIDTH

// The originals measured 3.7–4.4 MB; ipfs-media redirects above 8 MB. Refuse to buffer beyond this.
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
// The mirror is one Supabase Storage read of a ~50 KB object. Short, so a slow mirror costs a
// reader little before the gateway path takes over.
const MIRROR_READ_TIMEOUT_MS = 3_000
const MIRROR_WRITE_TIMEOUT_MS = 5_000

const IMMUTABLE = "public, max-age=31536000, immutable"

function toOriginal(origin: string, cid: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: `${origin}/api/public/ipfs-media/${cid}`,
      // Never pin a fallback: the next request should try the resize again.
      "Cache-Control": "no-store",
    },
  })
}

function image(bytes: Uint8Array, type: "image/webp" | "image/png", tag: string): NextResponse {
  return new NextResponse(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": IMMUTABLE,
      "X-Ipfs-Thumb": tag,
    },
  })
}

/** The mirror's bytes for (cid, width), or null on a miss OR any failure (logged — never thrown). */
async function readMirror(cid: string, width: IpfsThumbWidth): Promise<Uint8Array | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  const url = `${base}/storage/v1/object/public/${IPFS_THUMB_MIRROR_BUCKET}/${ipfsThumbMirrorKey(cid, width)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MIRROR_READ_TIMEOUT_MS) })
    const type = res.headers.get("content-type") ?? ""
    if (res.ok && type.startsWith("image/webp")) return new Uint8Array(await res.arrayBuffer())
    // Supabase answers a missing object 400/404; anything else is the mirror failing, not missing.
    if (res.status !== 400 && res.status !== 404) {
      console.warn(`[ipfs-thumb] mirror read failed cid=${cid} w=${width} status=${res.status} type=${type || "none"}`)
    } else {
      res.body?.cancel().catch(() => {})
    }
    return null
  } catch (err) {
    console.warn(`[ipfs-thumb] mirror read failed cid=${cid} w=${width} error=${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    return null
  }
}

/** Keep a successful resize. Returns whether it LANDED; a failure is logged, never thrown. */
async function writeMirror(cid: string, width: IpfsThumbWidth, bytes: Uint8Array): Promise<boolean> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !key) return false
  try {
    const res = await fetch(`${base}/storage/v1/object/${IPFS_THUMB_MIRROR_BUCKET}/${ipfsThumbMirrorKey(cid, width)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "image/webp",
        "Cache-Control": "31536000",
        "x-upsert": "true",
      },
      body: bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(MIRROR_WRITE_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[ipfs-thumb] mirror write failed cid=${cid} w=${width} status=${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[ipfs-thumb] mirror write failed cid=${cid} w=${width} error=${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    return false
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params
  if (!CID_RE.test(cid)) return new NextResponse(null, { status: 404 })

  const wParam = req.nextUrl.searchParams.get("w")
  const width = wParam === null ? DEFAULT_WIDTH : Number(wParam)
  if (!WIDTHS.has(width)) {
    return NextResponse.json({ error: `w must be one of ${IPFS_THUMB_WIDTHS.join(", ")}` }, { status: 400 })
  }
  const w = width as IpfsThumbWidth
  const fParam = req.nextUrl.searchParams.get("f")
  if (fParam !== null && fParam !== "png" && fParam !== "webp") {
    return NextResponse.json({ error: "f must be png or webp" }, { status: 400 })
  }
  const asPng = fParam === "png"
  const toPng = async (b: Uint8Array) => new Uint8Array(await sharp(b).png({ compressionLevel: 9 }).toBuffer())

  const mirrored = await readMirror(cid, w)
  if (mirrored) {
    if (!asPng) return image(mirrored, "image/webp", `${w}w; mirror`)
    try {
      return image(await toPng(mirrored), "image/png", `${w}w; mirror; png`)
    } catch (err) {
      // A mirror object that will not decode is not served; fall through to the gateway path.
      console.warn(`[ipfs-thumb] mirror decode failed cid=${cid} w=${w} error=${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
    }
  }

  const origin = req.nextUrl.origin
  try {
    const res = await fetch(`${origin}/api/public/ipfs-media/${cid}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const type = res.headers.get("content-type") ?? ""
    const declared = Number(res.headers.get("content-length") ?? 0)
    if (!res.ok || !type.startsWith("image/") || declared > MAX_INPUT_BYTES) {
      console.warn(`[ipfs-thumb] fallback cid=${cid} status=${res.status} type=${type || "none"} bytes=${declared || "?"}`)
      return toOriginal(origin, cid)
    }
    const input = Buffer.from(await res.arrayBuffer())
    if (input.byteLength > MAX_INPUT_BYTES) return toOriginal(origin, cid)

    const out = new Uint8Array(
      await sharp(input, { limitInputPixels: 60_000_000 })
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer(),
    )

    const kept = await writeMirror(cid, w, out)
    const tag = `${w}w; ${input.byteLength}->${out.byteLength}; mirror-write=${kept ? "ok" : "failed"}`
    return asPng ? image(await toPng(out), "image/png", `${tag}; png`) : image(out, "image/webp", tag)
  } catch (err) {
    console.warn(`[ipfs-thumb] fallback cid=${cid} error=${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
    return toOriginal(origin, cid)
  }
}
