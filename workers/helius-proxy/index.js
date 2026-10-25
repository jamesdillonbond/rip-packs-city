// helius-proxy — fronts a keyed Solana DAS endpoint for the Candy MLB ingest.
// Callers: lib/chains/solana/das.ts, scripts/candy-discovery.mjs (getAsset,
// getAssetsByOwner, getAssetsByGroup as of 2026-10-25).

// Read-only DAS methods (R138d). Add one here before a caller starts using it.
const ALLOWED_METHODS = new Set([
  "getAsset",
  "getAssetBatch",
  "getAssets",
  "getAssetsByOwner",
  "getAssetsByGroup",
  "getAssetsByCreator",
  "getAssetsByAuthority",
  "searchAssets",
  "getSignaturesForAsset",
]);

// Constant-time compare (security audit 2026-10-25, R138f).
function safeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function jsonError(status, error, extra) {
  return new Response(JSON.stringify({ error, ...(extra || {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("helius-proxy ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    // Own auth surface — HELIUS_PROXY_SECRET, never shared with
    // TS_PROXY_SECRET / INGEST_SECRET_TOKEN (see CLAUDE.md worker auth surfaces).
    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!env.HELIUS_PROXY_SECRET || !authHeader || !safeEqual(authHeader, env.HELIUS_PROXY_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // The full keyed DAS endpoint lives in a worker secret so the upstream
    // API key never ships in this source or to the client. Provider-agnostic:
    // works for a Helius `?api-key=` URL, Triton, or QuickNode DAS endpoint.
    const upstreamUrl = env.HELIUS_RPC_URL;
    if (!upstreamUrl) {
      return new Response("HELIUS_RPC_URL not configured", { status: 500 });
    }
    // Forward as raw text — JSON-RPC payloads can be batch arrays, not just
    // single objects (DAS getAssetsByGroup / getAssetsByOwner / getAsset).
    const body = await request.text();
    // Only read-only DAS methods may reach the keyed endpoint (security audit
    // 2026-10-25, R138d) — before this, a holder of the proxy secret could send
    // ANY JSON-RPC method (sendTransaction, heavy getProgramAccounts…) on our key.
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonError(400, "invalid_json");
    }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (calls.length === 0 || calls.length > 50) return jsonError(400, "invalid_batch");
    const blocked = calls
      .map((c) => (c && typeof c === "object" ? c.method : undefined))
      .filter((m) => typeof m !== "string" || !ALLOWED_METHODS.has(m));
    if (blocked.length > 0) {
      return jsonError(403, "method_not_allowed", { allowed: [...ALLOWED_METHODS] });
    }
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "rip-packs-city/1.0",
      },
      body,
    });
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
