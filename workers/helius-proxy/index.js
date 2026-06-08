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
    if (!authHeader || authHeader !== env.HELIUS_PROXY_SECRET) {
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
