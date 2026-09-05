// lib/media/avatar-proxy.ts
//
// Which third-party avatar hosts we serve through our own origin, and how the
// proxied URL is built.
//
// ⚠ THE REASON THIS EXISTS IS NOT PRIVACY OR CACHING — IT IS THAT THE IMAGE DOES
// NOT RENDER AT ALL (found 2026-08-16). `proxy.ts` sets an ENUMERATED
// `img-src` CSP listing our catalogue CDNs, and it does not include the NFT
// image hosts. A collector whose avatar is `https://i2c.seadn.io/...` therefore
// gets it refused by the browser before a byte is fetched — indistinguishable
// on screen from a dead link, and it falls through to the monogram. Serving the
// bytes from our own origin satisfies `'self'`, which is in EVERY policy we
// send, so a proxied avatar renders regardless of which CSP a response carries.
// (There are two: a permissive one from `next.config.ts` and the restrictive one
// from `proxy.ts`. Browsers enforce multiple CSP headers as an INTERSECTION, so
// the restrictive `img-src` governs. Same-origin sidesteps the whole question.)
//
// Privacy (no visitor IP handed to a third party), edge caching, and a size
// ceiling all come along for free, but they are not why this is here.
//
// ⚠ THE HOST ALLOWLIST IS THE SSRF GUARD, and that is deliberate rather than
// lazy. It is the same shape as `/api/public/ipfs-media/[cid]`, where the header
// says outright that the CID regex "is the SSRF guard" because the upstream host
// is fixed. An avatar has no fixed host, so the bound has to come from an
// allowlist instead. The alternative — accept any host and validate the resolved
// IP at request time — is a materially harder problem (DNS rebinding: the name
// resolves public when you check it and private when `fetch` re-resolves it),
// and mitigating it properly needs IP-pinned connections that `fetch` does not
// expose. An allowlist has no such failure mode.

/**
 * Third-party image hosts we are willing to fetch and re-serve.
 *
 * ⚠ DELIBERATELY THE COMPLEMENT OF THE CSP `img-src` LIST. Hosts already named
 * there (assets.nbatopshot.com, media.nflallday.com, ipfs.io, …) render fine
 * hotlinked, so routing them through here would add a hop and a dependency for
 * no gain — and would break avatars that work today if this route ever faults.
 * `__tests__/avatar-proxy-hosts.test.ts` asserts the two sets stay disjoint by
 * parsing proxy.ts, so adding a host to one and forgetting the other is caught.
 *
 * Exact hostnames, not suffix matches: `(^|\.)seadn\.io$` would also admit any
 * subdomain an attacker can get delegated. Add entries as real collectors need
 * them — this is expected to grow, and growing it is a one-line change.
 */
export const PROXYABLE_AVATAR_HOSTS: readonly string[] = [
  // OpenSea's image CDNs — what "copy image address" yields on an OpenSea item.
  "i.seadn.io",
  "i2c.seadn.io",
  "raw.seadn.io",
  "openseauserdata.com",
  "i.seadn.io.ipns.dweb.link",
  // ⛔ `arweave.net` WAS HERE AND WAS REMOVED 2026-09-04. It is now in the CSP
  // `img-src` instead, so Arweave art hotlinks like ipfs.io does. Two reasons it
  // could never work through this proxy, both measured on the live asset:
  //
  //   1. **arweave.net ALWAYS 302s** to a content-addressed subdomain, and this
  //      route refuses redirects as its SSRF guard (see its header). Every
  //      Arweave URL sent here 502'd.
  //   2. Even following that redirect, the asset is **6,872,443 bytes** against
  //      `MAX_AVATAR_BYTES` = 4,194,304. It is full-size NFT ART, not an 80px
  //      avatar, so this route's size cap, content-type allowlist and redirect
  //      rule are all correctly sized for a job it is not doing.
  //
  // ⚠ Hotlinking does NOT weaken the SVG rule below. That rule exists because
  // serving an SVG from OUR origin makes it same-origin and navigable — a stored
  // XSS. A cross-origin `<img src>` does not execute scripts, so this direction
  // is the safer one.
  //
  // ⛔ If you re-add it here, remove it from the CSP in the same commit:
  // `__tests__/avatar-proxy-hosts.test.ts` asserts the two sets stay DISJOINT.
]

/** Image types we will re-serve. */
export const PROXY_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]

/**
 * ⚠ SVG IS EXCLUDED ON PURPOSE AND MUST STAY EXCLUDED. An SVG is a document: it
 * can carry `<script>`, and serving one from OUR origin makes it same-origin
 * with the session — a stored XSS delivered through a profile picture. Every
 * other image type here is inert. This is the single most important line in the
 * file, and it is the reason the content-type list is an ALLOWLIST rather than
 * a `startsWith("image/")` test, which would have admitted `image/svg+xml`.
 */
export const SVG_IS_DELIBERATELY_UNSUPPORTED = true

/** Is this a URL we can serve through our own origin? */
export function isProxyableAvatarUrl(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false
  const value = raw.trim()
  if (value === "") return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  // https only. An http upstream would be fetched by us over cleartext and then
  // re-served over TLS, which launders a downgraded fetch into something that
  // looks secure to the visitor.
  if (url.protocol !== "https:") return false
  return PROXYABLE_AVATAR_HOSTS.includes(url.hostname.toLowerCase())
}

/**
 * The same-origin URL for a proxyable avatar, or the input unchanged.
 *
 * Unchanged is the right answer for both "already CSP-allowed" and "we do not
 * proxy this host": in the first case hotlinking works, and in the second the
 * proxy could not have helped anyway. Neither is made worse by passing through.
 */
export function avatarDisplayUrl(raw: string | null | undefined): string {
  const value = (raw ?? "").trim()
  if (!isProxyableAvatarUrl(value)) return value
  return `/api/public/avatar-media?src=${encodeURIComponent(value)}`
}

/**
 * Image hosts our CSP `img-src` already permits, so they render hotlinked.
 *
 * ⚠ A MIRROR OF `proxy.ts`, NOT THE SOURCE OF TRUTH — and as of 2026-09-05 it is
 * genuinely kept in sync by `__tests__/avatar-proxy-hosts.test.ts`, which parses
 * the real `img-src` directive out of that file and fails if the two disagree.
 *
 * ⛔ THAT TEST DID NOT EXIST WHEN THIS COMMENT FIRST CLAIMED IT DID, and the
 * mirror had silently drifted four hosts behind the CSP: `gateway.pinata.cloud`,
 * `*.supabase.co`, `arweave.net` and `*.arweave.net` were all permitted by the
 * real policy and all reported UNDISPLAYABLE here. That is not cosmetic —
 * `canDisplayAvatarUrl()` returning false swaps a perfectly renderable avatar
 * for the monogram default, so the Arweave art that was deliberately moved INTO
 * the CSP on 2026-09-04 (so it would hotlink) was still hidden by this file.
 * A comment asserting a guard is not a guard.
 *
 * It is duplicated rather than imported because `proxy.ts` is middleware:
 * importing from it would drag middleware code into any client bundle that asks
 * whether a URL will render.
 */
export const CSP_ALLOWED_IMAGE_HOSTS: readonly string[] = [
  "assets.nbatopshot.com",
  "asset-preview.nbatopshot.com",
  "assets.nflallday.com",
  "asset-preview.nflallday.com",
  "media.nflallday.com",
  "assets.laligagolazos.com",
  "asset-preview.laligagolazos.com",
  "assets.disneypinnacle.com",
  "asset-preview.disneypinnacle.com",
  "asset-preview.ufcstrike.com",
  "ipfs.dapperlabs.com",
  "gateway.pinata.cloud",
  "ipfs.io",
  "storage.googleapis.com",
  "cdn.nba.com",
  "cdn.wnba.com",
  "arweave.net",
  // ⛔ `cloudflare-ipfs.com` WAS HERE AND WAS REMOVED 2026-09-05, together with
  // its two entries in the proxy.ts CSP. The host is DECOMMISSIONED — it fails
  // DNS instantly, measured 0/8 CIDs in under 0.1 s — and nothing references it:
  // zero rows across every url/image/avatar/media/art/thumbnail column of every
  // live public table (the audit_* snapshot tables were excluded and are not
  // read by any route). A CSP entry for a host that cannot answer is not a
  // fallback, it is a wider policy that buys nothing.
]

/**
 * Wildcard `img-src` entries, as SUFFIXES INCLUDING THE LEADING DOT.
 *
 * ⚠ THE LEADING DOT IS THE WHOLE SAFETY ARGUMENT. `*.arweave.net` in a CSP
 * matches subdomains only, so the suffix must be `.arweave.net` — matching on
 * `arweave.net` would also admit `evilarweave.net`, which anyone can register.
 * That is the exact bypass class `__tests__/avatar-proxy-hosts.test.ts` already
 * pins for the proxy allowlist; the same rule has to hold here.
 *
 * (This predicate only decides whether to paint an <img> or fall back to the
 * monogram — it is not an SSRF boundary, nothing is fetched by us on its say-so.
 * It is written to the stricter standard anyway, because the next reader will
 * not know which of the two lists they are looking at.)
 */
export const CSP_ALLOWED_IMAGE_HOST_SUFFIXES: readonly string[] = [
  ".supabase.co",
  ".arweave.net",
]

/** Our own origin — `'self'`, so always renderable. */
const OWN_HOSTS = ["www.rippackscity.com", "rippackscity.com"]

/**
 * Will a browser actually paint this avatar?
 *
 * ⚠ THE QUESTION IS NOT "IS IT A VALID IMAGE URL" — it is whether our own CSP
 * permits it. `proxy.ts` sends an ENUMERATED `img-src`, so an arbitrary https
 * image host is refused before a byte moves, and the failure looks exactly like
 * a dead link. Any host that is neither proxyable, nor already in the CSP, nor
 * our own origin cannot be displayed however correct the URL is.
 */
export function canDisplayAvatarUrl(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim()
  if (value === "") return true // blank is the RPC-logo default
  if (value.startsWith("/")) return true // same-origin path
  if (isProxyableAvatarUrl(value)) return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  if (OWN_HOSTS.includes(host) || CSP_ALLOWED_IMAGE_HOSTS.includes(host)) return true
  return CSP_ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
