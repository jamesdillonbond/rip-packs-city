// app/api/public/ipfs-media/[cid]/route.ts
//
// Gate-free IPFS media proxy. UFC Strike (and any legacy ipfs.io-served) edition
// art/video is stored as an extensionless public-gateway URL
// (https://ipfs.io/ipfs/<cid>). The public ipfs.io gateway is slow and flaky —
// a UFC hero is a ~4 MB full-res RGBA PNG, so the browser <img>/<video> often
// gives up before it paints, leaving an empty black box (QA sweep 2026-07-02).
//
// This route fetches the CID server-side (our egress reaches ipfs.io reliably)
// and streams it back same-origin with the correct content-type and a long,
// immutable edge cache. Anon-public via proxy.ts (/api/public).
//
// SIZE CEILING (2026-07-27) — the edge cache silently refuses large responses.
// This route's original header claimed "the first request warms the Vercel edge
// and every subsequent load is a fast, cached same-origin hit". That is true for
// images and FALSE for video, because the objects exceed Vercel's maximum
// cacheable response size. Measured against production, same URL three times:
//
//   4.03 MB image/png  -> MISS, HIT,  HIT   (cached, amortised)
//   16.75 MB video/mp4 -> MISS, MISS, MISS  (never cached)
//   23.27 MB video/mp4 -> MISS, MISS, MISS  (never cached)
//
// The delivered header also comes back with `s-maxage` STRIPPED on the oversize
// responses. So every single video view cost a full 16-23 MB of Fast Data
// Transfer, forever, with zero amortisation — 10,786 editions carry an IPFS
// video URL (Top Shot 10,270, UFC 516), and that is the Fast Data Transfer
// alert. Above MAX_PROXY_BYTES we now 302 to the upstream gateway instead, so
// Vercel transfers zero bytes for objects it could never have cached. The
// redirect is CSP-safe: proxy.ts already allows https://ipfs.io in BOTH
// `img-src` and `media-src`. It is also SSRF-safe — CID_RE has already validated
// the CID, so the redirect target is built from the same allowlisted token as
// the fetch.
//
// GET /api/public/ipfs-media/<cid>

import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// CIDv0 (Qm… base58btc, 46 chars) or CIDv1 (b… base32, lowercase). The CID is
// echoed into the upstream path, so this allowlist regex is the SSRF guard —
// alnum only, no slashes/dots/query that could redirect the fetch elsewhere.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})$/;
const UPSTREAM = "https://ipfs.io/ipfs/";

// Objects at or below this stream through us and cache at the edge; above it we
// redirect. 8 MB sits between the largest size proven to cache (4.03 MB) and the
// smallest proven not to (16.75 MB), leaving margin under Vercel's ceiling.
const MAX_PROXY_BYTES = 8 * 1024 * 1024;

// Upstream fetch timeout. Deliberately well UNDER the platform's own 25s
// initial-response cutoff: this was 25_000, i.e. exactly the platform limit, so
// the platform always won the race and killed the function with
// `504 [error/serverless-middleware] … did not return an initial response
// within 25s` BEFORE the catch below could run. That made the 502 fallback —
// and the <img onError> candidate-advance chain it exists to trigger —
// unreachable dead code for precisely the slow-gateway case it was written for
// (205 such 504s in one 40-minute window on 2026-07-27). At 8s the abort fires
// first, so the soft-fail path actually works.
const UPSTREAM_TIMEOUT_MS = 8_000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cid: string }> },
): Promise<NextResponse> {
  const { cid: raw } = await params;
  const cid = decodeURIComponent(raw ?? "").trim();
  if (!CID_RE.test(cid)) {
    return new NextResponse(null, { status: 400 });
  }

  const upstreamUrl = `${UPSTREAM}${cid}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { "User-Agent": "rip-packs-city/ipfs-media" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // Gateway timeout/fault — 502 so the <img> onError can advance to the next
    // candidate / placeholder.
    return new NextResponse(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(null, { status: upstream.status || 502 });
  }

  // Oversize: hand the client straight to the gateway. Cancel our own body so
  // the bytes are never pulled through this function. A missing/unparseable
  // content-length (chunked upstream) falls through to the streaming path —
  // the old behaviour — rather than guessing.
  const declaredLength = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BYTES) {
    upstream.body.cancel().catch(() => {});
    return NextResponse.redirect(upstreamUrl, 302);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": contentType,
      // CID is immutable — cache hard at the edge + browser.
      "Cache-Control": "public, max-age=86400, s-maxage=31536000, immutable",
    },
  });
}
