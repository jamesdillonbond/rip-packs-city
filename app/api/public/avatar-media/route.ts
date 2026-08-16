// app/api/public/avatar-media/route.ts
//
// Same-origin proxy for third-party avatar images.
//
// GET /api/public/avatar-media?src=<encoded https url>
//
// WHY (2026-08-16): `proxy.ts` sends an ENUMERATED `img-src` CSP that does not
// include the NFT image hosts, so an avatar on `i2c.seadn.io` is refused by the
// browser before a byte moves — it looks exactly like a dead link and falls
// through to the monogram. Bytes served from our own origin satisfy `'self'`,
// which every policy we send allows. Privacy and edge caching come along free.
//
// ⚠ THE HOST ALLOWLIST IN lib/media/avatar-proxy.ts IS THE SSRF GUARD. Same
// shape as /api/public/ipfs-media/[cid], whose header says the CID regex "is the
// SSRF guard" because its upstream host is fixed. `src` here is caller-supplied
// and therefore hostile until proven otherwise; nothing outside the allowlist is
// ever fetched, so there is no DNS-rebinding window to lose.
//
// ⚠ REDIRECTS ARE REFUSED, NOT FOLLOWED. An allowlisted host that 302s is the
// exact hole an allowlist would otherwise leave open — the check passes on the
// first URL and the fetch lands wherever the redirect says, including a private
// address. `redirect: "manual"` plus an explicit 3xx rejection closes it.
//
// ⚠ ON OVERSIZE THIS 502s RATHER THAN REDIRECTING TO UPSTREAM — the opposite of
// ipfs-media, deliberately. That route redirects because ipfs.io IS in the CSP,
// so the browser can load it directly. These hosts are NOT, so a redirect would
// hand the browser a URL its own CSP forbids: a guaranteed broken image instead
// of a clean fall-through to the monogram.

import { NextRequest, NextResponse } from "next/server"
import {
  isProxyableAvatarUrl,
  PROXY_CONTENT_TYPES,
} from "@/lib/media/avatar-proxy"

export const runtime = "edge"

/**
 * An avatar renders at 80px. Anything past this is not an avatar, and the cap
 * doubles as the ceiling that keeps a response inside what the edge will cache
 * (ipfs-media measured 4.03 MB caching and 16.75 MB not).
 */
const MAX_AVATAR_BYTES = 4 * 1024 * 1024

/**
 * Well under the platform's 25s initial-response cutoff, for the reason
 * ipfs-media records: at the platform limit the platform always wins the race
 * and kills the function before the catch can run, making the soft-fail path
 * unreachable dead code.
 */
const UPSTREAM_TIMEOUT_MS = 6_000

export async function GET(req: NextRequest): Promise<NextResponse> {
  const src = (req.nextUrl.searchParams.get("src") ?? "").trim()

  // The guard. Covers empty, non-URL, non-https and non-allowlisted host.
  if (!isProxyableAvatarUrl(src)) {
    return new NextResponse(null, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(src, {
      // ⚠ Not "follow". See the header.
      redirect: "manual",
      headers: { "User-Agent": "rip-packs-city/avatar-media", Accept: "image/*" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    // Timeout or transport fault. 502 so the <img onError> falls through to the
    // monogram rather than showing a broken-image glyph.
    return new NextResponse(null, { status: 502 })
  }

  // A 3xx here is the redirect case the allowlist cannot follow safely.
  //
  // ⚠ CURRENTLY REDUNDANT, KEPT DELIBERATELY, AND SAYING SO IS THE POINT.
  // Removing it is a SURVIVING mutation: `Response.ok` is by definition 200-299,
  // so an un-followed 3xx already falls into the `!upstream.ok` branch below and
  // still 502s. It stays as a statement of intent, and because the thing that
  // makes it redundant is one word — `redirect: "manual"` above — which a future
  // edit could flip to "follow" without ever touching this line. The assertion
  // that is genuinely load-bearing is the one pinning that option.
  if (upstream.status >= 300 && upstream.status < 400) {
    return new NextResponse(null, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(null, { status: 502 })
  }

  // ⚠ ALLOWLIST, NOT `startsWith("image/")`. That test admits image/svg+xml,
  // and an SVG served from our origin is a document that can run script with
  // our session — stored XSS delivered as a profile picture.
  const declaredType = (upstream.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (!PROXY_CONTENT_TYPES.includes(declaredType)) {
    upstream.body.cancel().catch(() => {})
    return new NextResponse(null, { status: 415 })
  }

  const declaredLength = Number(upstream.headers.get("content-length") ?? "")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
    upstream.body.cancel().catch(() => {})
    return new NextResponse(null, { status: 502 })
  }

  return new NextResponse(upstream.body, {
    headers: {
      // OUR type from the allowlist, never the upstream string verbatim — so a
      // parameterised or spoofed header cannot smuggle a different type through.
      "Content-Type": declaredType,
      // Belt and braces with the allowlist above: never let a sniffed type
      // override what we declared.
      "X-Content-Type-Options": "nosniff",
      // ⚠ NOT `immutable`, unlike ipfs-media. A CID names its bytes forever; an
      // avatar URL does not — the same URL can be re-uploaded, and CDN hashes
      // expire. Long enough at the edge to amortise crawler traffic,
      // revalidating in the background so a changed image is not pinned for a
      // year.
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      // The upstream host is an implementation detail; do not leak it onward.
      "Referrer-Policy": "no-referrer",
    },
  })
}
