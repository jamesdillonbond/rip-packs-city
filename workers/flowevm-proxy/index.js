export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("flowevm-proxy ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!env.PROXY_SECRET || !authHeader || !safeEqual(authHeader, env.PROXY_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.text();
    const upstream = await fetch("https://mainnet.evm.nodes.onflow.org", {
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

// Constant-time compare (security audit 2026-10-25, R138f).
function safeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
