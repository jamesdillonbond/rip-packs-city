// Disney Pinnacle GQL proxy — Cloudflare Workers bypass the IP blocks that
// prevent Vercel from reaching public-api.disneypinnacle.com directly.
//
// Routes:
//   POST /graphql        → public-api.disneypinnacle.com/graphql (GQL passthrough)
//   GET  /render/<rid>   → signed Pinnacle render bytes (asset-CDN passthrough)
// Auth:  X-Proxy-Secret header must match env.PROXY_SECRET (both routes)
//
// Why the GET route exists: assets.disneypinnacle.com serves only SIGNED,
// short-lived render URLs and 403s ALL datacenter egress (Vercel, Supabase edge,
// this repo's every server surface). Cloudflare Workers egress is the one lane
// that may pass the CDN's filter — if it does, this route lets server-generated
// surfaces (trophy-case PDF, OG cards) embed Pinnacle art hands-off. It resolves
// a FRESH signed URL in-worker via the studio-platform GQL, then streams the
// asset bytes back. NOT public — it's a paid-egress amplifier, so it carries the
// same X-Proxy-Secret gate as the POST route.
//
// STEP 0 (verify the premise on first deploy): if the smoke below returns 403,
// Cloudflare Workers egress is ALSO blocked → the whole passthrough is moot; note
// it in the ledger and keep the browser-harvest fill for pinnacle_render_cache.
//
// Smoke test after deploy:
//   POST GQL:
//   curl https://pinnacle-proxy.tdillonbond.workers.dev/graphql -X POST \
//     -H 'Content-Type: application/json' -H 'X-Proxy-Secret: <secret>' \
//     -d '{"query": "{ __typename }"}'
//   GET render (expect PNG magic bytes, ~2.9MB for a 2880×2880 front render):
//   curl https://pinnacle-proxy.tdillonbond.workers.dev/render/LEV2-LION-CARE-S6 \
//     -H 'X-Proxy-Secret: <secret>' -o simba.png

const UPSTREAM = "https://public-api.disneypinnacle.com/graphql";
const STUDIO_GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";

// render_id is an uppercase alnum + dash slug; reject anything else (SSRF guard,
// mirrors app/api/public/pinnacle-image/[renderId]/route.ts).
const RENDER_ID_RE = /^[A-Za-z0-9-]{3,64}$/;
const RENDER_CACHE_TTL = 1800; // 30m, comfortably under the signature TTL (hours)

const MEDIA_QUERY = `
query PinnacleImage($rid: String!) {
  searchPinnacleEditions(searchInput: { first: 1, filters: [{ render_id: { in: [$rid] } }] }) {
    edges { node { render_id medias { name url } } }
  }
}`;

// Resolve a fresh signed asset URL for a render_id via the studio-platform GQL.
// Media-pick logic mirrors the pinnacle-image route exactly.
async function resolveSignedUrl(renderId, wantQuarter) {
  const res = await fetch(STUDIO_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-render",
    },
    body: JSON.stringify({ query: MEDIA_QUERY, variables: { rid: renderId } }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (Array.isArray(json.errors) && json.errors.length > 0) return null;
  const medias = json?.data?.searchPinnacleEditions?.edges?.[0]?.node?.medias ?? [];
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

async function handleRender(request, env, url) {
  const authHeader = request.headers.get("X-Proxy-Secret");
  if (!authHeader || authHeader !== env.PROXY_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const renderId = decodeURIComponent(url.pathname.slice("/render/".length)).trim();
  if (!RENDER_ID_RE.test(renderId)) {
    return new Response("Invalid render_id", { status: 400 });
  }
  const wantQuarter = url.searchParams.get("v") === "quarter";

  let signed = null;
  try {
    signed = await resolveSignedUrl(renderId, wantQuarter);
  } catch {
    signed = null;
  }
  if (!signed) {
    // Unknown render_id or upstream GQL fault.
    return new Response("Not found", { status: 404 });
  }

  let assetRes;
  try {
    assetRes = await fetch(signed, {
      headers: {
        Accept: "image/png,image/*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      cf: { cacheTtl: RENDER_CACHE_TTL, cacheEverything: true },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }
  if (!assetRes.ok) {
    // 403 here on first deploy = CF Workers egress is ALSO CDN-blocked (STEP 0
    // failed) → the passthrough premise is moot. Surface the real upstream code.
    return new Response(`Upstream ${assetRes.status}`, { status: assetRes.status });
  }

  return new Response(assetRes.body, {
    status: 200,
    headers: {
      "Content-Type": assetRes.headers.get("Content-Type") || "image/png",
      "Cache-Control": `public, s-maxage=${RENDER_CACHE_TTL}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/render/")) {
      return handleRender(request, env, url);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!authHeader || authHeader !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.text();
    const upstreamRes = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
      body,
    });

    const data = await upstreamRes.text();
    return new Response(data, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
