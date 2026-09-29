// app/api/public/ipfs-thumb/[cid]/route.ts
//
// A RESIZED image for an IPFS CID: GET /api/public/ipfs-thumb/<cid>?w=<width>
//
// WHY (known-issues #162, 2026-09-29). Every UFC Strike image is a full-size 3.7–4.4 MB PNG, and
// pages render it with a plain <img>, so a phone downloaded megabytes per 60–120 px tile. The
// original is fetched through /api/public/ipfs-media/<cid> (same origin): that route owns the
// gateway race and its CDN copy, so a warm original costs this route ~0.6 s, not a gateway trip.
// This route decodes it once, resizes to one of a few widths, and returns WebP with an immutable
// cache, so each (CID, width) is computed ONCE and then served by the CDN.
//
// ⛔ FAILS OPEN TO THE ORIGINAL, NEVER TO A BROKEN IMAGE. Anything that goes wrong (upstream
// not ok, not an image, too large, a decode error) 302s to the original proxy URL, uncached,
// so the reader still sees the art at its old weight and the next request retries the resize.
//
// Node runtime: sharp is native and cannot run on the edge runtime ipfs-media uses.

import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"
import { IPFS_THUMB_DEFAULT_WIDTH, IPFS_THUMB_WIDTHS } from "@/lib/ipfs-media"

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params
  if (!CID_RE.test(cid)) return new NextResponse(null, { status: 404 })

  const wParam = req.nextUrl.searchParams.get("w")
  const width = wParam === null ? DEFAULT_WIDTH : Number(wParam)
  if (!WIDTHS.has(width)) {
    return NextResponse.json({ error: `w must be one of ${IPFS_THUMB_WIDTHS.join(", ")}` }, { status: 400 })
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

    const out = await sharp(input, { limitInputPixels: 60_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()

    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(out.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Ipfs-Thumb": `${width}w; ${input.byteLength}->${out.byteLength}`,
      },
    })
  } catch (err) {
    console.warn(`[ipfs-thumb] fallback cid=${cid} error=${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
    return toOriginal(origin, cid)
  }
}
