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
// GET /api/public/pinnacle-image/<renderId>?v=thumb   -> front_cropped.png (Front_Cropped)
//   For LIST thumbnails (Market, Sniper). Measured 2026-09-26 on one render:
//   Front_Cropped 284,505 bytes vs Front_Transparent 1,144,333 — ~4x lighter,
//   and the tighter crop fills a small tile. Falls back to the full renders.
//
// FALLBACK (2026-11-15): a render Dapper's edition search has no record of (the catalog's
// `flow-chain` / `pinnacle-edition-page` rows) is read from Pinnacle's own edition page,
// which embeds the same signed asset URLs — see lib/pinnacle/edition-page-media.ts.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { allSignedMediaFromEditionPage, type EditionPageMedia } from "@/lib/pinnacle/edition-page-media";
import { expOfSignedUrl, readSignedMedia, writeSignedMedia } from "@/lib/pinnacle/signed-media-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
// render_id is an uppercase alnum + dash slug; reject anything else (SSRF guard).
const RENDER_ID_RE = /^[A-Za-z0-9-]{3,64}$/;
const CACHE_SECONDS = 1800; // 30m, comfortably under the signature TTL (hours)
// A request slower than this logs its legs: the OG builder's art budget is 4.5 s for ALL of its
// fallbacks (lib/og/img-data.ts), so anything near it costs a share card its art.
const SLOW_LEG_MS = 3000;
// Serve a stored signature only while it has at least this long left; under it, re-resolve.
const STORE_SERVE_MIN_LEFT_S = 1800;
// 2026-11-25 (evening): a stored signature served with less than this left is re-resolved AFTER the
// response, so a pin with steady traffic never reaches the cold path. Signatures live ~24 h, so this
// costs at most one background page read per viewed pin per ~16 h; a pin nobody views costs nothing.
const STORE_REFRESH_AHEAD_S = 8 * 3600;

const MEDIA_QUERY = `
query PinnacleImage($rid: String!) {
  searchPinnacleEditions(searchInput: { first: 1, filters: [{ render_id: { in: [$rid] } }] }) {
    edges { node { render_id medias { name url } } }
  }
}`;

type Variant = "front" | "quarter" | "thumb";

// Preference order per variant; the first media present wins.
const MEDIA_ORDER: Record<Variant, string[]> = {
  front: ["Front_Transparent", "Front_Quarter_Transparent", "Front_Cropped"],
  quarter: ["Front_Quarter_Transparent", "Front_Transparent", "Front_Cropped"],
  thumb: ["Front_Cropped", "Front_Transparent", "Front_Quarter_Transparent"],
};

async function resolveSignedUrl(
  renderId: string,
  variant: Variant,
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
  for (const name of MEDIA_ORDER[variant]) {
    const m = medias.find((x) => x.name === name && x.url);
    if (m) return m.url;
  }
  return null;
}

// Fallback (2026-11-15): renders Dapper's edition search has no record of (catalog rows
// sourced from the chain or Pinnacle's edition pages — 55 renders, 843 held pins, all 404
// before this) are read from Pinnacle's own edition page, which embeds the signed asset
// URLs the official site loads. The edition id comes from OUR catalog (digits only), and
// the host is fixed, so nothing request-supplied reaches the fetch URL.
const EDITION_PAGE = "https://disneypinnacle.com/edition/";
const EDITION_ID_RE = /^[0-9]{1,9}$/;

async function resolveFromEditionPage(
  renderId: string,
): Promise<Partial<Record<Variant, EditionPageMedia>> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_catalog")
    .select("edition_id")
    .eq("render_id", renderId)
    .maybeSingle();
  if (error) return null;
  const editionId = String(data?.edition_id ?? "");
  if (!EDITION_ID_RE.test(editionId)) return null;
  const res = await fetch(EDITION_PAGE + editionId, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; rip-packs-city/pinnacle-image)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return allSignedMediaFromEditionPage(await res.text(), renderId);
}

interface Resolved {
  url: string | null;
  exp: number | null;
  source: "gql" | "edition-page" | "none";
  legs: string[];
  /** The other variants the same edition-page read carried (stored too; never served here). */
  siblings: Partial<Record<Variant, EditionPageMedia>>;
}

// The live upstreams, in order: GraphQL, then Pinnacle's edition page. Never throws.
async function resolveFresh(renderId: string, variant: Variant): Promise<Resolved> {
  const legs: string[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  try {
    const url = await resolveSignedUrl(renderId, variant);
    legs.push(`gql:${url ? "ok" : "miss"}:${Date.now() - t0}ms`);
    if (url) return { url, exp: expOfSignedUrl(url), source: "gql", legs, siblings: {} };
  } catch (e) {
    legs.push(`gql:error(${e instanceof Error ? e.name : "unknown"}):${Date.now() - t0}ms`);
  }
  const t1 = Date.now();
  try {
    const page = await resolveFromEditionPage(renderId);
    const hit = page?.[variant];
    // Keep 5 min spare; a signature with a minute or less of that left is no answer.
    const ok = hit != null && hit.exp - now() - 300 > 60;
    legs.push(`edition-page:${ok ? "ok" : "miss"}:${Date.now() - t1}ms`);
    const siblings: Partial<Record<Variant, EditionPageMedia>> = {};
    for (const [k, m] of Object.entries(page ?? {}) as Array<[Variant, EditionPageMedia]>) {
      if (k !== variant && m.exp - now() > STORE_SERVE_MIN_LEFT_S) siblings[k] = m;
    }
    if (ok) return { url: hit.url, exp: hit.exp, source: "edition-page", legs, siblings };
    return { url: null, exp: null, source: "none", legs, siblings };
  } catch (e) {
    legs.push(`edition-page:error(${e instanceof Error ? e.name : "unknown"}):${Date.now() - t1}ms`);
  }
  return { url: null, exp: null, source: "none", legs, siblings: {} };
}

async function storeResolved(renderId: string, variant: Variant, r: Resolved): Promise<void> {
  const writes: Array<Promise<boolean>> = [];
  if (r.url && r.exp != null && r.source !== "none") {
    writes.push(writeSignedMedia(renderId, variant, r.url, r.exp, r.source));
  }
  for (const [k, m] of Object.entries(r.siblings) as Array<[Variant, EditionPageMedia]>) {
    writes.push(writeSignedMedia(renderId, k, m.url, m.exp, "edition-page"));
  }
  await Promise.all(writes);
}

// Run `task` after the response. Outside a request scope (unit tests) `after` throws: run it inline
// detached instead — a refresh is best-effort either way and never changes this response.
function afterResponse(task: () => Promise<void>): void {
  const guarded = () => task().catch(() => undefined);
  try {
    after(guarded);
  } catch {
    void guarded();
  }
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
  const v = req.nextUrl.searchParams.get("v");
  const variant: Variant = v === "quarter" ? "quarter" : v === "thumb" ? "thumb" : "front";

  // 2026-11-25: the signed-url STORE comes first. Root cause of Pinnacle share cards losing their art:
  // the GraphQL leg has answered 530 since ~11-17 (fails in ≤251 ms), so every image was read from
  // disneypinnacle.com's ~270 KB edition page, whose tail reaches the 10 s timeout in the evening
  // (Vercel external-API metrics: max 10,001 ms in 4 of 24 hours; p95 ~1 s). Vercel's image optimizer
  // gives up on a local source at ~7 s (three 11-25 OG renders died 7.05 s in, MODULE_NOT_FOUND on
  // /_next/image) and the OG builder's art budget is 4.5 s. A signature lives ~24 h, so serving the
  // stored one takes the page off the path for every request but the first of the day per pin.
  const now = () => Math.floor(Date.now() / 1000);
  const stored = await readSignedMedia(renderId, variant);
  if (stored && stored.exp - now() > STORE_SERVE_MIN_LEFT_S) {
    if (stored.exp - now() < STORE_REFRESH_AHEAD_S) {
      afterResponse(async () => {
        const r = await resolveFresh(renderId, variant);
        await storeResolved(renderId, variant, r);
      });
    }
    return redirectTo(stored.url, Math.min(CACHE_SECONDS, stored.exp - now() - 300), "store");
  }

  // Which leg answered and how long each took: a miss or a slow request logs every leg.
  const t0 = Date.now();
  const fresh = await resolveFresh(renderId, variant);
  const legs = fresh.legs;
  let source: "gql" | "edition-page" | "store-stale" | "none" = fresh.source;
  let url: string | null = fresh.url;
  const exp: number | null = fresh.exp;
  // Cache for CACHE_SECONDS unless a fallback signature expires sooner (keep 5 min spare).
  let cacheSeconds = CACHE_SECONDS;
  if (url && source === "edition-page" && exp != null) {
    cacheSeconds = Math.min(CACHE_SECONDS, exp - now() - 300);
  }
  // Every upstream failed: a stored signature with at least 6 min left still beats a placeholder.
  if (!url && stored && stored.exp - now() > 360) {
    url = stored.url;
    cacheSeconds = Math.min(CACHE_SECONDS, stored.exp - now() - 300);
    source = "store-stale";
  }
  const totalMs = Date.now() - t0;
  if (!url || totalMs > SLOW_LEG_MS) {
    console.warn(`[pinnacle-image] ${renderId} ${variant} source=${source} total=${totalMs}ms ${legs.join(" ")}`);
  }
  if (!url) {
    // No image resolvable (unknown render_id or upstream fault). 404 so the
    // <img> onError can fall back to a placeholder tile.
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "x-pinnacle-image-source": source } });
  }
  // Remember a FRESH signature and the sibling variants the same page read carried (never re-write
  // one we just served from the store).
  if (source === "gql" || source === "edition-page") {
    await storeResolved(renderId, variant, fresh);
  } else {
    await storeResolved(renderId, variant, { ...fresh, url: null });
  }
  return redirectTo(url, cacheSeconds, source);
}

function redirectTo(url: string, cacheSeconds: number, source: string): NextResponse {
  return NextResponse.redirect(url, {
    status: 302,
    headers: {
      "Cache-Control": `public, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`,
      "x-pinnacle-image-source": source,
    },
  });
}
