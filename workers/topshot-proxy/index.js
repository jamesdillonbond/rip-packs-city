export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!authHeader || authHeader !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.text();
    const upstream = await fetch("https://public-api.nbatopshot.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
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
