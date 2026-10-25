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
//   POST /execute?query_id=<id>
//        → https://api.dune.com/api/v1/query/<id>/execute
//        Triggers a fresh run so /results returns current data, not a stale
//        cached snapshot. Returns { execution_id, state }.
//
//   GET /status?execution_id=<id>
//        → https://api.dune.com/api/v1/execution/<id>/status
//        Poll target: state QUERY_STATE_COMPLETED means /results is now fresh.
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
  /** Optional comma list that REPLACES DEFAULT_ALLOWED_QUERY_IDS. */
  DUNE_ALLOWED_QUERY_IDS?: string;
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

// Constant-time compare (security audit 2026-10-25, R138f).
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function authOk(request: Request, env: Env): boolean {
  if (!env.DUNE_PROXY_SECRET) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), env.DUNE_PROXY_SECRET);
}

// Only the queries RPC actually runs may spend our Dune credits (security audit
// 2026-10-25, R138c). Before this, any numeric query_id — anyone's public Dune
// query — could be executed and paged on our key by a holder of the proxy secret.
//   7899011 — Top Shot ownership index (sync-topshot-ownership-dune)
//   8027085 — sales seller recovery   (sync-sales-seller-recovery-dune)
//   8030177 — sales ingest recovery   (sync-sales-ingest-dune; route kept, schedule retired)
// Adding a query means adding its id here or
// setting the DUNE_ALLOWED_QUERY_IDS var (comma list), which REPLACES this list.
const DEFAULT_ALLOWED_QUERY_IDS = ["7899011", "8027085", "8030177"];

function allowedQueryIds(env: Env): Set<string> {
  const raw = (env.DUNE_ALLOWED_QUERY_IDS ?? "").trim();
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)) : DEFAULT_ALLOWED_QUERY_IDS;
  return new Set(ids);
}

function queryIdError(queryId: string | null, env: Env): Response | null {
  if (!queryId || !/^\d+$/.test(queryId)) {
    return jsonResponse({ error: "query_id must be a numeric Dune query id" }, 400);
  }
  if (!allowedQueryIds(env).has(queryId)) {
    return jsonResponse({ error: "query_id_not_allowed" }, 403);
  }
  return null;
}

async function handleResults(url: URL, env: Env): Promise<Response> {
  if (!env.DUNE_API_KEY) return jsonResponse({ error: "dune_api_key_unset" }, 500);

  const queryId = url.searchParams.get("query_id");
  const qErr = queryIdError(queryId, env);
  if (qErr || !queryId) return qErr ?? jsonResponse({ error: "query_id required" }, 400);

  // Guard NaN like offset below: Number("foo") is NaN and Math.min/max propagate
  // it, so an unparseable ?limit forwarded `limit=NaN` to Dune → 400 instead of
  // falling back to the default page size.
  const limitRaw = Number(url.searchParams.get("limit") ?? "1000");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw))) : MAX_LIMIT;
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

async function handleExecute(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.DUNE_API_KEY) return jsonResponse({ error: "dune_api_key_unset" }, 500);

  const queryId = url.searchParams.get("query_id");
  const qErr = queryIdError(queryId, env);
  if (qErr || !queryId) return qErr ?? jsonResponse({ error: "query_id required" }, 400);

  // Forward an OPTIONAL JSON body to Dune's execute endpoint so callers can run a
  // parameterized query (e.g. { query_parameters: { set_ids: "230,253,254" } }).
  // A body-less POST behaves exactly as before (runs the query with saved defaults),
  // so this is backward-compatible. Only allowed execute fields are forwarded;
  // nothing else from the caller body is echoed upstream. (Since 2026-10-25 only
  // query_parameters is forwarded; see the note on `performance` below.)
  let body: string | undefined;
  try {
    const raw = await request.text();
    if (raw && raw.trim().length > 0) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      if (parsed && typeof parsed === "object") {
        if (parsed.query_parameters && typeof parsed.query_parameters === "object") {
          out.query_parameters = parsed.query_parameters;
        }
        // `performance` is deliberately NOT forwarded (R138c): "large" bills more
        // credits per run and no RPC caller sets it.
      }
      if (Object.keys(out).length > 0) body = JSON.stringify(out);
    }
  } catch {
    /* malformed body -> ignore, run with saved defaults */
  }

  const res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: "POST",
    headers: {
      "X-Dune-API-Key": env.DUNE_API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  return passthrough(text, res.status);
}

async function handleStatus(url: URL, env: Env): Promise<Response> {
  if (!env.DUNE_API_KEY) return jsonResponse({ error: "dune_api_key_unset" }, 500);

  const execId = url.searchParams.get("execution_id");
  if (!execId || !/^[A-Za-z0-9_-]{1,80}$/.test(execId)) {
    return jsonResponse({ error: "execution_id required" }, 400);
  }

  const res = await fetch(`${DUNE_API}/execution/${execId}/status`, {
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
    if (path === "/execute" && method === "POST") return handleExecute(request, url, env);
    if (path === "/status" && method === "GET") return handleStatus(url, env);

    return jsonResponse({ error: "route_not_found", path, method }, 404);
  },
};
