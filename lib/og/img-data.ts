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
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-12 — TWO WHOLE COLLECTIONS OF ART WERE BEING DROPPED HERE, SILENTLY,
// and neither was a bug in this module's judgement — both were URL SHAPES it
// declined to normalize. Measured against the live DB the same day:
//
//   * Disney Pinnacle addresses ALL of its art as a SITE-RELATIVE path
//     (`/api/public/pinnacle-image/<render_id>` — the signed-CDN resolver;
//     Dapper 403s any durable bare URL, so there is nothing else to store).
//     The `^https?://` gate rejected every one of them, so no Pinnacle art has
//     EVER rendered on any OG card.
//   * NFL All Day addresses ALL 6,190 of its editions as `format=webp`
//     (`media.nflallday.com/editions/<n>/media/image?width=512&format=webp`),
//     and WebP is excluded below on purpose. Same outcome: no All Day art on
//     any card, on the moment card as much as the trophy tiles.
//
// The WebP exclusion is CORRECT and stays. The fix is to stop handing satori a
// format it cannot decode when the SAME origin will hand us a PNG for the
// asking — verified both ways against media.nflallday.com: `format=webp` →
// 200 image/webp 38,008 B (`RIFF…WEBP`), `format=png` → 200 image/png
// 45,121 B (`\x89PNG`).
//
// Both fixes live in `ogImageTarget` rather than at the two call sites that
// noticed, because the call sites are not where the defect is: the moment card
// passes `thumbnail_url` straight in, and every future caller would inherit the
// same two holes.
// ─────────────────────────────────────────────────────────────────────────────

const IPFS_GATEWAY_RE =
  /^https?:\/\/(?:ipfs\.io|ipfs\.dapperlabs\.com|cloudflare-ipfs\.com)\/ipfs\/([A-Za-z0-9]+)/

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// Satori/resvg reliably decodes PNG/JPEG/GIF/SVG only — WebP/AVIF are dropped
// rather than risked (embedding one can still fail the whole render).
const OK_TYPES = /^image\/(png|jpe?g|gif|svg\+xml)/i

// A `format=` query param on a render-on-demand origin. Asking for PNG instead
// is STRICTLY NO-WORSE than not asking: an origin that honours it gives us art
// we can embed, and one that ignores it (or 400s) gives us back exactly the
// drop we would have taken anyway. That property is why this is a general
// rewrite and not a host allowlist — an allowlist would have to be extended by
// hand the next time a collection lands, which is how All Day got here.
const RENDER_FORMAT_RE = /([?&]format=)(?:webp|avif)(?=&|$)/i

export interface OgImgOpts {
  timeoutMs?: number
  maxBytes?: number
}

/**
 * Resolve what we will actually FETCH for a stored art URL, or null if there
 * is nothing fetchable. Exported so the normalizations are pinned directly
 * rather than inferred from a mocked fetch's first argument.
 */
export function ogImageTarget(raw: string): string | null {
  let url = raw
  // Site-relative art is OURS (the Pinnacle signed-CDN resolver). `//host/path`
  // is protocol-relative, NOT site-relative — prefixing BASE_URL to it would
  // build `https://www.rippackscity.com//assets.example.com/...`, so it is left
  // to the gate below to reject.
  if (url.startsWith("/") && !url.startsWith("//")) url = BASE_URL + url
  if (!/^https?:\/\//.test(url)) return null

  const m = url.match(IPFS_GATEWAY_RE)
  if (m) return `${BASE_URL}/api/public/ipfs-media/${m[1]}`

  return url.replace(RENDER_FORMAT_RE, "$1png")
}

export async function ogImageDataUri(
  url: string | null | undefined,
  opts: OgImgOpts = {},
): Promise<string | null> {
  if (!url || typeof url !== "string") return null
  if (url.startsWith("data:")) return url

  const target = ogImageTarget(url)
  if (!target) return null

  const timeoutMs = opts.timeoutMs ?? 4500
  // 4MB cap — measured live: satori/resvg renders a 2.85MB 2880px PNG fine
  // (Blazers montage) but dies on a 7.67MB one (Lakers/Wilt Chamberlain,
  // 2026-07-07). Oversized art drops to the placeholder tile instead.
  //
  // ⚠ Pinnacle `front.png` renders are full-resolution and sit uncomfortably
  // close to it: LEV2-LION-CARE-S6 measured 2,896,041 B on 2026-09-12. It fits,
  // but a larger Pinnacle render will silently reintroduce the drop this
  // module's 09-12 fix just closed, with a different cause. That route takes no
  // width param today, so there is no cheaper ask to make.
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024

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

/**
 * Prefetch a list in parallel, keeping every input's POSITION (a failure is a
 * null in its own slot) and enforcing a total-payload budget (~10MB) so a
 * montage of large-but-legal images can't stack past what satori will render.
 *
 * ⚠ PREFER THIS OVER `ogImageDataUris` WHENEVER THE CALLER PAIRS THE ART WITH
 * ANYTHING ELSE ABOUT THE SAME ROW — a name, a tier, a price. The compacting
 * variant below silently SHIFTS every image after a failure into the previous
 * slot, and a caller that then reads `uris[i]` alongside `rows[i]` renders one
 * collector's Moment under another one's name. That is not hypothetical: the
 * trophy-case card did exactly that, and with the two drops fixed above it was
 * captioning Kevin Durant's art "Amon-Ra St. Brown" on a card built to be
 * shared (found 2026-09-12).
 */
export async function ogImageDataUriSlots(
  urls: Array<string | null | undefined>,
  opts: OgImgOpts = {},
): Promise<Array<string | null>> {
  const settled = await Promise.all(urls.map((u) => ogImageDataUri(u, opts)))
  const out: Array<string | null> = []
  let budget = 10 * 1024 * 1024 // data-URI chars ≈ bytes × 4/3
  for (const u of settled) {
    if (!u || u.length > budget) {
      out.push(null)
      continue
    }
    budget -= u.length
    out.push(u)
  }
  return out
}

/**
 * Prefetch a list in parallel, dropping failures (order preserved among the
 * survivors) and enforcing the same total-payload budget.
 *
 * ⚠ Only correct for an ANONYMOUS montage — a set of images with nothing
 * per-image rendered beside them (`lib/og/entity-card.tsx`). Anything else
 * wants `ogImageDataUriSlots`; see the warning on it.
 */
export async function ogImageDataUris(
  urls: Array<string | null | undefined>,
  opts: OgImgOpts = {},
): Promise<string[]> {
  return (await ogImageDataUriSlots(urls, opts)).filter((u): u is string => !!u)
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
