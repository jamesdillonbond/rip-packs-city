// app/api/public/arweave-thumb/[id]/route.ts
//
// A RESIZED image for an Arweave transaction id: GET /api/public/arweave-thumb/<id>?w=<width>[&f=png]
//
// WHY (2026-10-26, Candy parity). Every Candy MLB card image is a full-size PNG on arweave.net —
// 3.9 MB for a base ICON, 7.5 MB for a Rainbow (measured: Ohtani, Murakami Blue) — and the site
// rendered it with a plain <img>. A Candy edition page (hero + Parallel Printings ladder + More
// editions) downloaded tens of megabytes on a phone, and the Rainbow editions' social card (OG) had
// NO art at all, because the card's 4 MB image cap drops a 7.5 MB original. Same answer as UFC's
// IPFS art (#162, /api/public/ipfs-thumb): decode once, resize to a fixed width, serve WebP (PNG for
// the OG card — satori cannot decode WebP) with an immutable cache, so each (id, width, format) is
// computed ONCE and then served by the CDN.
//
// ⛔ FAILS OPEN TO THE ORIGINAL, NEVER TO A BROKEN IMAGE. Anything that goes wrong (upstream not ok,
// not an image, too large, a decode error) 302s to https://arweave.net/<id>, uncached, so the reader
// still sees the art at its old weight and the next request retries the resize.
//
// SSRF: the host is fixed (arweave.net, whose 302 to its content-addressed subdomain fetch follows)
// and the id is a 43-char base64url transaction id — nothing caller-supplied reaches the host part.

import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"
import { IPFS_THUMB_DEFAULT_WIDTH, IPFS_THUMB_WIDTHS } from "@/lib/ipfs-media"

export const runtime = "nodejs"
export const maxDuration = 30

const ID_RE = /^[A-Za-z0-9_-]{43}$/
const WIDTHS = new Set<number>(IPFS_THUMB_WIDTHS)
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

function toOriginal(id: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `https://arweave.net/${id}`, "Cache-Control": "no-store" },
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!ID_RE.test(id)) return new NextResponse(null, { status: 404 })

  const wParam = req.nextUrl.searchParams.get("w")
  const width = wParam === null ? IPFS_THUMB_DEFAULT_WIDTH : Number(wParam)
  if (!WIDTHS.has(width)) {
    return NextResponse.json({ error: `w must be one of ${IPFS_THUMB_WIDTHS.join(", ")}` }, { status: 400 })
  }
  const fParam = req.nextUrl.searchParams.get("f")
  if (fParam !== null && fParam !== "png" && fParam !== "webp") {
    return NextResponse.json({ error: "f must be png or webp" }, { status: 400 })
  }
  const asPng = fParam === "png"

  try {
    const res = await fetch(`https://arweave.net/${id}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const type = res.headers.get("content-type") ?? ""
    const declared = Number(res.headers.get("content-length") ?? 0)
    if (!res.ok || !type.startsWith("image/") || declared > MAX_INPUT_BYTES) {
      console.warn(`[arweave-thumb] fallback id=${id} status=${res.status} type=${type || "none"} bytes=${declared || "?"}`)
      return toOriginal(id)
    }
    const input = Buffer.from(await res.arrayBuffer())
    if (input.byteLength > MAX_INPUT_BYTES) return toOriginal(id)

    const pipeline = sharp(input, { limitInputPixels: 60_000_000 }).rotate().resize({ width, withoutEnlargement: true })
    const out = asPng ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.webp({ quality: 78 }).toBuffer()

    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": asPng ? "image/png" : "image/webp",
        "Content-Length": String(out.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Arweave-Thumb": `${width}w; ${input.byteLength}->${out.byteLength}`,
      },
    })
  } catch (err) {
    console.warn(`[arweave-thumb] fallback id=${id} error=${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
    return toOriginal(id)
  }
}
