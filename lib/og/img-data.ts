// lib/og/img-data.ts
//
// Resilient image pre-fetch for OG card renderers. Satori (next/og) fetches
// every <img src> itself at render time with no per-image error isolation —
// one unreachable / oversized / slow upstream (notably ipfs.dapperlabs.com
// art on pre-2022 Top Shot editions) throws and 500s the WHOLE card, which
// social crawlers then render as a bare link with no preview. (Root cause of
// the /api/og/team?slug=portland-trail-blazers 500, 2026-07-07.)
//
// ogImageDataUri() fetches the image server-side with a hard timeout + byte
// cap, rewrites slow public IPFS gateways to our own edge-cached proxy
// (/api/public/ipfs-media/<cid>), and returns a base64 data URI Satori can
// embed with ZERO network I/O — or null, so callers degrade to their existing
// "no media" branch instead of 500ing.

const IPFS_GATEWAY_RE =
  /^https?:\/\/(?:ipfs\.io|ipfs\.dapperlabs\.com|cloudflare-ipfs\.com)\/ipfs\/([A-Za-z0-9]+)/

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// Satori/resvg reliably decodes PNG/JPEG/GIF/SVG only — WebP/AVIF are dropped
// rather than risked (embedding one can still fail the whole render).
const OK_TYPES = /^image\/(png|jpe?g|gif|svg\+xml)/i

export interface OgImgOpts {
  timeoutMs?: number
  maxBytes?: number
}

export async function ogImageDataUri(
  url: string | null | undefined,
  opts: OgImgOpts = {},
): Promise<string | null> {
  if (!url || typeof url !== "string") return null
  if (url.startsWith("data:")) return url
  if (!/^https?:\/\//.test(url)) return null

  const timeoutMs = opts.timeoutMs ?? 4500
  // 8MB cap — the ipfs.dapperlabs.com originals are 2880px PNGs of ~2-6MB;
  // they decode fine, but anything past this is not worth an OG card.
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024

  const m = url.match(IPFS_GATEWAY_RE)
  const target = m ? `${BASE_URL}/api/public/ipfs-media/${m[1]}` : url

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(target, {
      signal: ac.signal,
      // OG cards are re-rendered on every crawler hit; let the platform cache
      // the upstream bytes where it can.
      cache: "no-store",
      headers: { Accept: "image/*" },
    })
    if (!res.ok) return null
    const ct = res.headers.get("content-type") || ""
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null
    // Sniff when the content-type is missing/generic (some gateways serve
    // application/octet-stream).
    let type = OK_TYPES.test(ct) ? ct.split(";")[0].trim() : sniff(buf)
    if (!type) return null
    return `data:${type};base64,${buf.toString("base64")}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Prefetch a list in parallel, dropping failures (order preserved). */
export async function ogImageDataUris(
  urls: Array<string | null | undefined>,
  opts: OgImgOpts = {},
): Promise<string[]> {
  const settled = await Promise.all(urls.map((u) => ogImageDataUri(u, opts)))
  return settled.filter((u): u is string => !!u)
}

function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif"
  const head = buf.subarray(0, 256).toString("utf8").trimStart().toLowerCase()
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml"
  return null
}
