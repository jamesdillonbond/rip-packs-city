// dune-proxy — fronts the Dune Analytics Query Results API for the TopShot
// ownership-index sync (Pipeline A). Dune's API key must never ship to Vercel
// edge logs, so the worker holds it and Vercel calls the worker with its own
// Bearer secret — an independent rotation surface (see CLAUDE.md "Worker auth
// surfaces (3 rotation domains)": this is a 4th, NEVER sharing TS_PROXY_SECRET /
// INGEST_SECRET_TOKEN / SPORK_PROXY_SECRET).
//
//   GET /results?query_id=<id>&limit=<n>&offset=<n>
//        → https://api.dune.com/api/v1/query/<id>/results?limit=&offset=
//        Injects header X-Dune-API-Key: <env.DUNE_API_KEY>. Pass-through JSON.
//        Dune paginates: the response carries next_offset / next_uri when more
//        rows remain; the caller (sync route) walks offset until exhausted.
//
//   GET /health → { ok: true } (no upstream; for a wrangler-deploy smoke).
//
// Auth: Authorization: Bearer <env.DUNE_PROXY_SECRET>.
// Secrets (write-only after creation):
//   wrangler secret put DUNE_PROXY_SECRET --name dune-proxy
//   wrangler secret put DUNE_API_KEY      --name dune-proxy

interface Env {
  DUNE_PROXY_SECRET: string;
  DUNE_API_KEY: string;
}

const DUNE_API = "https://api.dune.com/api/v1";
const MAX_LIMIT = 1000; // Dune Query Results API page cap

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function passthrough(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function authOk(request: Request, env: Env): boolean {
  if (!env.DUNE_PROXY_SECRET) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === env.DUNE_PROXY_SECRET;
}

async function handleResults(url: URL, env: Env): Promise<Response> {
  if (!env.DUNE_API_KEY) return jsonResponse({ error: "dune_api_key_unset" }, 500);

  const queryId = url.searchParams.get("query_id");
  if (!queryId || !/^\d+$/.test(queryId)) {
    return jsonResponse({ error: "query_id must be a numeric Dune query id" }, 400);
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get("limit") ?? "1000")));
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const upstream = new URL(`${DUNE_API}/query/${queryId}/results`);
  upstream.searchParams.set("limit", String(limit));
  upstream.searchParams.set("offset", String(offset));

  const res = await fetch(upstream.toString(), {
    method: "GET",
    headers: { "X-Dune-API-Key": env.DUNE_API_KEY },
  });
  const text = await res.text();
  return passthrough(text, res.status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/g, "").toLowerCase();
    const method = request.method.toUpperCase();

    if (path === "/health" && method === "GET") return jsonResponse({ ok: true }, 200);

    if (!authOk(request, env)) return jsonResponse({ error: "unauthorized" }, 401);

    if (path === "/results" && method === "GET") return handleResults(url, env);

    return jsonResponse({ error: "route_not_found", path, method }, 404);
  },
};
