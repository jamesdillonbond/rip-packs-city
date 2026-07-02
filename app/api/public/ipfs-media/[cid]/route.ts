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
// immutable edge cache. IPFS content is content-addressed (immutable per CID),
// so the first request warms the Vercel edge and every subsequent load is a
// fast, cached same-origin hit — no ipfs.io round-trip. Same pattern as the
// badge-image / pinnacle-image proxies. Anon-public via proxy.ts (/api/public).
//
// GET /api/public/ipfs-media/<cid>

import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// CIDv0 (Qm… base58btc, 46 chars) or CIDv1 (b… base32, lowercase). The CID is
// echoed into the upstream path, so this allowlist regex is the SSRF guard —
// alnum only, no slashes/dots/query that could redirect the fetch elsewhere.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})$/;
const UPSTREAM = "https://ipfs.io/ipfs/";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cid: string }> },
): Promise<NextResponse> {
  const { cid: raw } = await params;
  const cid = decodeURIComponent(raw ?? "").trim();
  if (!CID_RE.test(cid)) {
    return new NextResponse(null, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${cid}`, {
      headers: { "User-Agent": "rip-packs-city/ipfs-media" },
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    // Gateway timeout/fault — 502 so the <img> onError can advance to the next
    // candidate / placeholder.
    return new NextResponse(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(null, { status: upstream.status || 502 });
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
