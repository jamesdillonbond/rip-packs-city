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
    if (!authHeader || authHeader !== env.PROXY_SECRET) {
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
