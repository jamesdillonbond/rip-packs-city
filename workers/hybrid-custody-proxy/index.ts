// hybrid-custody-proxy — fronts Flow Access REST API for HybridCustody
// account-linking detection. Three routes:
//
//   POST /events  → /v1/events?type=...&start_height=...&end_height=...
//                   Body: { type: string, start_height: number, end_height: number }
//                   Flow's REST API caps each call at 250 blocks per range.
//
//   POST /script  → /v1/scripts (Cadence script execution).
//                   Body: { script: <base64-cadence>, arguments: [<base64-json-cdc>] }
//                   Pass-through; the body shape already matches Flow's spec.
//
//   GET  /head    → returns { height: number } from /v1/blocks?height=sealed.
//
// Auth: Authorization: Bearer <env.PROXY_SECRET>. Worker stores the secret as
// PROXY_SECRET (set with `wrangler secret put PROXY_SECRET --name hybrid-custody-proxy`).
// The clients (events ingester + backfill) send the same INGEST_SECRET_TOKEN value
// in the Authorization header — single rotation surface.
//
// Whitelisted event types (defense-in-depth: don't let arbitrary callers hammer
// Flow Access for any event type they like through our worker):
//   A.d8a7e05a7ac670c0.HybridCustody.AccountUpdated
//   A.d8a7e05a7ac670c0.HybridCustody.OwnershipGranted
//   A.d8a7e05a7ac670c0.HybridCustody.AccountSealed
//   A.d8a7e05a7ac670c0.HybridCustody.ChildAccountPublished

interface Env {
  PROXY_SECRET: string;
}

const FLOW_REST = "https://rest-mainnet.onflow.org";
const HC_ADDR = "0xd8a7e05a7ac670c0";
const ALLOWED_EVENT_TYPES = new Set([
  `A.${HC_ADDR.replace(/^0x/, "")}.HybridCustody.AccountUpdated`,
  `A.${HC_ADDR.replace(/^0x/, "")}.HybridCustody.OwnershipGranted`,
  `A.${HC_ADDR.replace(/^0x/, "")}.HybridCustody.AccountSealed`,
  `A.${HC_ADDR.replace(/^0x/, "")}.HybridCustody.ChildAccountPublished`,
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function passthroughResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function authOk(request: Request, env: Env): boolean {
  if (!env.PROXY_SECRET) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === env.PROXY_SECRET;
}

async function handleEvents(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }
  const { type, start_height, end_height } = (body ?? {}) as Record<string, unknown>;
  if (typeof type !== "string" || !ALLOWED_EVENT_TYPES.has(type)) {
    return jsonResponse({ error: "event_type_not_allowed", type }, 400);
  }
  const start = Number(start_height);
  const end = Number(end_height);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return jsonResponse({ error: "invalid_height_range", start_height, end_height }, 400);
  }
  if (end - start > 249) {
    return jsonResponse(
      { error: "range_too_large", max_span: 249, requested_span: end - start },
      400,
    );
  }

  const upstream = new URL(`${FLOW_REST}/v1/events`);
  upstream.searchParams.set("type", type);
  upstream.searchParams.set("start_height", String(start));
  upstream.searchParams.set("end_height", String(end));

  const res = await fetch(upstream.toString(), { method: "GET" });
  const text = await res.text();
  return passthroughResponse(text, res.status);
}

async function handleScript(request: Request): Promise<Response> {
  // Pass body through untouched — Flow's /v1/scripts spec already expects
  // { script: <b64>, arguments: [<b64>...] }.
  const text = await request.text();
  if (!text) return jsonResponse({ error: "empty_body" }, 400);
  const res = await fetch(`${FLOW_REST}/v1/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  });
  const upstreamText = await res.text();
  return passthroughResponse(upstreamText, res.status);
}

async function handleHead(): Promise<Response> {
  const upstream = new URL(`${FLOW_REST}/v1/blocks`);
  upstream.searchParams.set("height", "sealed");
  const res = await fetch(upstream.toString(), { method: "GET" });
  if (!res.ok) {
    return jsonResponse({ error: "upstream_failed", status: res.status }, 502);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return jsonResponse(
      { error: "json_parse_failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  const arr = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
  const header = arr[0]?.header as Record<string, unknown> | undefined;
  const heightStr = header?.height;
  const height = Number(heightStr);
  if (!Number.isFinite(height) || height <= 0) {
    return jsonResponse({ error: "head_height_missing", upstream: arr[0] ?? null }, 502);
  }
  return jsonResponse({ height }, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!authOk(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/g, "").toLowerCase();
    const method = request.method.toUpperCase();

    if (path === "/events" && method === "POST") return handleEvents(request);
    if (path === "/script" && method === "POST") return handleScript(request);
    if (path === "/head" && method === "GET") return handleHead();

    return jsonResponse({ error: "route_not_found", path, method }, 404);
  },
};
