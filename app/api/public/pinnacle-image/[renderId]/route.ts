// app/api/public/pinnacle-image/[renderId]/route.ts
//
// Gate-free Pinnacle image resolver. The Dapper asset CDN
// (assets.disneypinnacle.com) serves only SIGNED, short-lived URLs and 403s any
// unsigned/datacenter request — so we cannot store a durable bare image URL.
// Instead this route fetches a FRESH signed media URL from the studio-platform
// GraphQL server-side (reachable from our egress) and 302-redirects the browser
// to it. The browser then loads the signed asset exactly as the official site
// does. Cached at the edge for < the signature TTL.
//
// Per-pin identity is render_id (e.g. OEV1-SOUL-JGAR-S2) — the true Pinnacle
// catalog key. Public route (under /api/public, anon-bypassed in proxy.ts).
//
// GET /api/public/pinnacle-image/<renderId>          -> front.png (Front_Transparent)
// GET /api/public/pinnacle-image/<renderId>?v=quarter -> main.png  (Front_Quarter_Transparent)

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
// render_id is an uppercase alnum + dash slug; reject anything else (SSRF guard).
const RENDER_ID_RE = /^[A-Za-z0-9-]{3,64}$/;
const CACHE_SECONDS = 1800; // 30m, comfortably under the signature TTL (hours)

const MEDIA_QUERY = `
query PinnacleImage($rid: String!) {
  searchPinnacleEditions(searchInput: { first: 1, filters: [{ render_id: { in: [$rid] } }] }) {
    edges { node { render_id medias { name url } } }
  }
}`;

async function resolveSignedUrl(
  renderId: string,
  wantQuarter: boolean,
): Promise<string | null> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-image",
    },
    body: JSON.stringify({ query: MEDIA_QUERY, variables: { rid: renderId } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { searchPinnacleEditions?: { edges?: Array<{ node?: { medias?: Array<{ name: string; url: string }> } }> } };
    errors?: unknown[];
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) return null;
  const medias = json.data?.searchPinnacleEditions?.edges?.[0]?.node?.medias ?? [];
  if (medias.length === 0) return null;
  const primary = wantQuarter ? "Front_Quarter_Transparent" : "Front_Transparent";
  const fallbackOrder = wantQuarter
    ? ["Front_Quarter_Transparent", "Front_Transparent", "Front_Cropped"]
    : ["Front_Transparent", "Front_Quarter_Transparent", "Front_Cropped"];
  for (const name of [primary, ...fallbackOrder]) {
    const m = medias.find((x) => x.name === name && x.url);
    if (m) return m.url;
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ renderId: string }> },
): Promise<NextResponse> {
  const { renderId: raw } = await params;
  const renderId = decodeURIComponent(raw ?? "").trim();
  if (!RENDER_ID_RE.test(renderId)) {
    return NextResponse.json({ error: "invalid render_id" }, { status: 400 });
  }
  const wantQuarter = req.nextUrl.searchParams.get("v") === "quarter";

  let url: string | null = null;
  try {
    url = await resolveSignedUrl(renderId, wantQuarter);
  } catch {
    url = null;
  }
  if (!url) {
    // No image resolvable (unknown render_id or upstream fault). 404 so the
    // <img> onError can fall back to a placeholder tile.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.redirect(url, {
    status: 302,
    headers: {
      "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
    },
  });
}
