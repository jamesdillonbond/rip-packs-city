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
// (/api/public/ipfs-media/<cid>), asks our own image optimizer for a card-sized
// derivative of any art the origin will not size for us, and returns a base64
// data URI Satori can embed with ZERO network I/O — or null, so callers degrade
// to their existing "no media" branch instead of 500ing.
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
// 2026-09-12 (later the same day) — ⭐ THE BYTE CAP WAS STRIPPING ART FROM 100%
// OF ULTIMATES AND 0% OF COMMONS, which is the worst possible correlation: the
// cap removes art from exactly the Moments people share. Two production cards,
// same route, same day: edition 220:8093 (Walter Clayton Jr., ULTIMATE, $1,350)
// published a blank grey placeholder at 36,440 B; edition 133:4738 (Marcus
// Smart, COMMON, $0.39) published full art at 167,677 B. The only difference is
// the source PNG — 7,677,876 B against 3,754,556 B, either side of the 4 MB cap
// below. Six random `/editions/` art files per tier, Content-Length measured
// directly: ULTIMATE 6/6 over (median 6.73 MB), LEGENDARY 5/6, RARE 4/6,
// FANDOM 4/6, COMMON 0/6 (median 3.21 MB). Higher tiers buy more elaborate
// artwork — foils, particles, transparency — and that costs bytes in a
// 2880×2880 PNG.
//
// ⚠ THE CAP IS NOT THE DEFECT AND RAISING IT IS THE WRONG FIX: at 7 MB the
// base64 data URI is ~9.3 MB, past the 7.67 MB satori failure this module
// already documents below. The PAYLOAD is the defect, and the payload is
// 2880×2880 art drawn into a 550px slot on a 1200×630 card.
//
// So art nobody will size for us now goes through OUR OWN image optimizer —
// `/_next/image?url=…&w=640&q=75`, already deployed, already crawlable
// (`app/robots.ts` allows `/_next/image`), already permitted for these hosts by
// `next.config.ts` `images.remotePatterns`. Cowork measured 119,162 B of PNG
// back for that 7,677,876 B Ultimate: 64× smaller, three orders of magnitude
// under the cap.
//
// ⚠ RE-DERIVED HERE FROM THE INSTALLED NEXT (16.2.9) RATHER THAN TAKEN ON
// FAITH, because the whole fix turns on the optimizer handing back a format
// satori can decode:
//   · `images.formats` defaults to `["image/webp"]`, and
//     `getSupportedMimeType` returns a format ONLY when `accept.includes(it)`
//     — `image/*` does not contain the literal `image/webp`, so it negotiates
//     to "", and a PNG upstream comes back PNG (image-optimizer.js:222, 1118).
//     ⛔ THE `Accept: image/*` HEADER BELOW IS THEREFORE LOAD-BEARING: naming
//     webp or avif in it would hand satori exactly the formats it cannot
//     decode. Pinned in __tests__/og-img-data.test.ts.
//   · `images.qualities` defaults to `[75]` and a quality outside it is a 400,
//     so `q` is 75 and not a taste call; `w` must be one of
//     deviceSizes ∪ imageSizes, where 640 is the smallest entry that still
//     covers the largest slot any card draws (the moment card's 550px pane).
//     Both pinned against the installed config rather than as literals.
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

// ── THE OPTIMIZER LEG ────────────────────────────────────────────────────────
// `w` must be a member of `images.deviceSizes ∪ images.imageSizes` and `q` a
// member of `images.qualities`, or the optimizer answers 400. Neither is a
// preference; both are pinned against the installed Next defaults.
const OG_ART_WIDTH = 640
const OG_ART_QUALITY = 75

/**
 * Hosts `next.config.ts` `images.remotePatterns` admits. The optimizer 400s on
 * anything else, so asking for one would cost a wasted round trip and land us
 * back on the direct fetch anyway.
 *
 * ⚠ THIS LIST IS A CLAIM ABOUT ANOTHER FILE, so it is asserted against that
 * file rather than maintained by memory — `__tests__/og-img-data.test.ts` reads
 * `next.config.ts` and fails if an entry here is not in `remotePatterns`.
 * Absent hosts (arweave.net for Candy MLB, storage.googleapis.com for 16 legacy
 * Top Shot rows) are not a defect here: they skip the optimizer and take the
 * direct fetch, which is exactly what they do today.
 */
export const OG_OPTIMIZER_HOSTS: readonly string[] = [
  "assets.nbatopshot.com",
  "asset-preview.nbatopshot.com",
  "media.nflallday.com",
  "assets.laligagolazos.com",
  "ipfs.io",
  "gateway.pinata.cloud",
]

// An origin that has ALREADY sized the art for us. Measured shapes, 2026-09-12:
//
//   assets.nbatopshot.com/media/<nft_id>/image?width=400        31,507 B
//   media.nflallday.com/editions/<n>/media/image?width=512      45,121 B
//
// Both are render endpoints — no file extension on the path — and both honour
// `width`. Handing those to the optimizer buys nothing and would UPSCALE them
// (sharp enlarges by default), so they skip it.
//
// ⚠ A `width=` PARAM IS NOT ITSELF THE TEST, and getting that wrong would have
// re-opened this defect on the very population it was filed for: `hiResThumb`
// (lib/trophy/slab-style.ts) appends `?width=640` to EVERY assets.nbatopshot.com
// url, including the `/editions/**_2880_2880_*.png` STATIC files, where the
// origin serves the same 2880px master whatever you ask for. A static file —
// the path ends in an image extension — is never "already sized" no matter what
// query it carries, which is why the extension is half of the test.
const SIZE_PARAM_RE = /[?&](?:width|w)=\d/i
const STATIC_IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i

export interface OgImgOpts {
  timeoutMs?: number
  maxBytes?: number
  /**
   * Route the art through `/_next/image` (default true). Pass false for art
   * that is already small and drawn small — `lib/og/official-mark-art.ts`
   * fetches 20px badge glyphs under a 64 KB cap, where a 640px derivative is
   * both larger than the original and a transformation bought for nothing.
   */
  optimize?: boolean
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

/**
 * The `/_next/image` url for a resolved target, or null when the optimizer
 * cannot or need not serve it. Exported so the four measured url shapes are
 * pinned directly rather than inferred from a mocked fetch.
 *
 * ⚠ OUR OWN URLS ARE HANDED OVER SITE-RELATIVE, deliberately. The optimizer
 * checks an absolute url against `remotePatterns` (where our own domain does
 * not appear and must not be added — that would make us an open image proxy for
 * ourselves) and a relative one against `localPatterns`, which is undefined and
 * therefore allows everything local. Stripping BASE_URL back off is what keeps
 * the IPFS proxy and the Pinnacle resolver on the local branch.
 */
export function ogOptimizedTarget(target: string): string | null {
  const inner = target.startsWith(`${BASE_URL}/`) ? target.slice(BASE_URL.length) : target
  const isLocal = inner.startsWith("/")

  // Already sized by its origin (see SIZE_PARAM_RE) — nothing to buy.
  if (SIZE_PARAM_RE.test(inner) && !STATIC_IMAGE_PATH_RE.test(inner.split("?")[0])) return null

  if (!isLocal) {
    let host = ""
    try {
      host = new URL(inner).hostname.toLowerCase()
    } catch {
      return null
    }
    if (!OG_OPTIMIZER_HOSTS.includes(host)) return null
  }

  return `${BASE_URL}/_next/image?url=${encodeURIComponent(inner)}&w=${OG_ART_WIDTH}&q=${OG_ART_QUALITY}`
}

// ── PINNACLE: THE CACHE IS THE CHEAP SOURCE, AND SOMETIMES THE ONLY ONE ─────
// `/api/public/pinnacle-image/<render_id>` 302s to a freshly-signed Dapper CDN
// URL and hands back a FULL-RESOLUTION render: LEV2-LION-CARE-S6 measured
// 2,896,041 B at 2880×2880 on 2026-09-12 (and `?v=quarter`, which selects a
// different ANGLE rather than a smaller render, 2,545,361 B — there is no width
// parameter on that route, so there is no cheaper ask to make of it).
//
// ⭐ `pinnacle_render_cache` holds the SAME render, downscaled to ≤800px, at
// 316,140 B — 9× smaller than THAT, already base64, one indexed read away. It
// retires the risk that a larger render one day crosses the 4 MB cap below and
// silently reintroduces the art drop that this module's own 09-12 fix closed.
//
// 🚨 BUT IT IS NO LONGER THE CHEAPEST SOURCE, AND THE ORDERING MOVED ON
// 2026-09-13 BECAUSE OF IT. The optimizer leg added later the same day returns
// **61,788 B** for this render, so the cache is **5.1× LARGER than the branch it
// used to pre-empt**. It now runs AFTER the optimizer and before the direct
// fetch — see the ordering comment in `ogImageDataUri`. ⛔ Do not "restore" the
// cache-first read on the strength of the 9× figure above: that comparison is
// against the 2.9 MB live render, which is the LAST resort, not the next one.
//
// ⚠ TWO CAVEATS, BOTH STATED RATHER THAN DESIGNED AROUND.
//  1. THE CACHE HOLDS ONE ROW. It is a proven mechanism, not a populated
//     cache — it works for Simba and for nothing else today. The live route
//     therefore REMAINS the fallback and is not downgraded to a last resort.
//     `scripts/pinnacle-render-cache-fill.mjs` (home-machine, 15-minutely) is
//     the writer that would populate it; whether that scheduler is still
//     running is a separate question from whether this read is correct.
//  2. THE TWO SOURCES DISAGREE ABOUT DATACENTER EGRESS.
//     `app/api/profile/trophy-case/pdf/route.tsx` states a direct Pinnacle
//     fetch "would 403" from our egress and does not attempt one; the 2.9 MB
//     figure above is a SUCCESSFUL datacenter fetch of the same asset through
//     the signed-URL redirect. Both cannot describe the same path. This change
//     is correct either way — if the live route works, the cache is 9× cheaper;
//     if it 403s, the cache is the only Pinnacle art there is — so it is not
//     gated on resolving that, but nothing here should be read as having
//     resolved it.
const PINNACLE_RENDER_RE = /\/api\/public\/pinnacle-image\/([A-Za-z0-9-]{3,64})/

/**
 * Read one cached Pinnacle render as a data URI, or null.
 *
 * ⚠ PLAIN `fetch` AGAINST PostgREST rather than a supabase-js client, because
 * this module is imported by `/api/og/profile/[username]`, which is `edge`.
 * Pulling supabase-js in here would drag a Node-shaped client onto an edge
 * route for a decoration read.
 */
async function pinnacleCachedDataUri(
  renderId: string,
  timeoutMs: number,
): Promise<string | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!base || !key) return null
  try {
    const res = await fetch(
      `${base}/rest/v1/pinnacle_render_cache?render_id=eq.${encodeURIComponent(renderId)}&select=mime,b64&limit=1`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ mime?: string | null; b64?: string | null }>
    const row = Array.isArray(rows) ? rows[0] : null
    const b64 = row?.b64
    if (typeof b64 !== "string" || b64.length === 0) return null
    // ⚠ VALIDATE THE BYTES, do not trust `mime`. The column is written by a
    // home-machine script posting through an admin route; a truncated or
    // HTML-bodied row would otherwise be handed to satori as a PNG and take
    // the whole card down, which is the exact failure this module exists to
    // prevent. Sniffing is what every other path in here already does.
    const type = sniff(Buffer.from(b64.slice(0, 64), "base64"))
    if (!type) return null
    return `data:${type};base64,${b64}`
  } catch {
    return null
  }
}

/**
 * One bounded fetch → data URI, or null. Every degradation this module promises
 * (non-2xx, empty body, oversize body, undecodable format, timeout, network
 * error) resolves to null here rather than throwing at a card renderer.
 */
async function fetchAsDataUri(
  target: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(target, {
      signal: ac.signal,
      // OG cards are re-rendered on every crawler hit; let the platform cache
      // the upstream bytes where it can.
      cache: "no-store",
      // ⛔ LOAD-BEARING, NOT DECORATIVE — see the optimizer note in this file's
      // header. `image/*` negotiates to no format at all, which is what makes
      // `/_next/image` hand back the PNG it was given instead of the WebP
      // satori cannot decode.
      headers: { Accept: "image/*" },
    })
    if (!res.ok) return null
    const ct = res.headers.get("content-type") || ""
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null
    // Sniff when the content-type is missing/generic (some gateways serve
    // application/octet-stream).
    const type = OK_TYPES.test(ct) ? ct.split(";")[0].trim() : sniff(buf)
    if (!type) return null
    return `data:${type};base64,${buf.toString("base64")}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Below this, a fallback fetch cannot finish inside what is left of the card's
// budget, so it is not started.
const MIN_FALLBACK_MS = 250

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
  // ⚠ THE CAP IS THE LAST LINE, NOT THE FIRST. Until 2026-09-12 it was also the
  // only one, and it was silently blanking every Ultimate on the site (header).
  // It still guards everything the optimizer leg below cannot reach: a host
  // outside `remotePatterns`, an optimizer failure (Next falls back to the
  // UNOPTIMIZED buffer when sharp throws), a bypassed format, and every
  // `optimize: false` caller.
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024

  // ⚠ ONE BUDGET ACROSS BOTH LEGS, not one each. A card's art budget is 4.5s
  // because that is what a crawler will wait, and a dead upstream must not cost
  // 9s just because we asked two ways.
  let budget = timeoutMs
  const optimized = opts.optimize === false ? null : ogOptimizedTarget(target)
  if (optimized) {
    const t0 = Date.now()
    const hit = await fetchAsDataUri(optimized, budget, maxBytes)
    if (hit) return hit
    budget -= Date.now() - t0
    if (budget < MIN_FALLBACK_MS) return null
  }

  // ── PINNACLE CACHE: SECOND NOW, NOT FIRST (register #90, 2026-09-13) ───────
  // ⚠ THIS READ USED TO RUN BEFORE THE OPTIMIZER LEG AND RETURN ON A HIT, WHICH
  // MADE IT THE MORE EXPENSIVE BRANCH. Both halves re-measured rather than
  // quoted: the one cached row is **316,140 B** (`b64` 421,520 chars, live read
  // 2026-09-13) against the optimizer's **61,788 B** for the same render
  // (production, 2026-09-12) — so cache-first shipped ~5.1× MORE bytes on the
  // single card it covers than doing nothing would have.
  //
  // ⛔ NOT AN ERROR BY ITS AUTHOR, and worth saying so: the cache-first read
  // landed HOURS BEFORE the optimizer leg existed, on the same day. Against the
  // 2,896,041 B live render it was a 9× win and the comment above still reads
  // that way. It was overtaken, not wrong.
  //
  // ⭐ MOVED RATHER THAN DELETED, because its second justification survives the
  // first one dying: if the optimizer refuses this art — a `remotePatterns`
  // drift, a 400, a platform difference, or `optimize: false` — the cache is
  // still 316 KB against a 2.9 MB direct fetch that may not even clear the 4 MB
  // cap. As a FALLBACK it can only help; as a first choice it could only hurt.
  // ⚠ It therefore also runs ahead of the direct fetch when `optimize` is off,
  // which is the ordering that was right about this cache all along.
  //
  // ⚠ The cache still holds ONE ROW, two months stale (`fetched_at`
  // 2026-07-16), and this change does not populate it — see #90 for the
  // writer-ownership question, which is Trevor's and unaffected by any of this.
  const pin = target.match(PINNACLE_RENDER_RE)
  if (pin) {
    const t0 = Date.now()
    const cached = await pinnacleCachedDataUri(pin[1], budget)
    if (cached) return cached
    budget -= Date.now() - t0
    if (budget < MIN_FALLBACK_MS) return null
  }

  // ⚠ THE DIRECT FETCH IS ALWAYS THE FALLBACK, so this change is STRICTLY
  // NO-WORSE: art that renders today keeps rendering if the optimizer refuses
  // it (a `remotePatterns` drift, a 400 on an input it will not touch, a
  // platform difference between `next start` and Vercel's own optimizer — the
  // Pinnacle resolver answers 302, and only Vercel's implementation follows a
  // redirect on a LOCAL url). The optimizer can only add art, never remove it.
  return fetchAsDataUri(target, budget, maxBytes)
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
