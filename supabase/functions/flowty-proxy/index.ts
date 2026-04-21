import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Lightweight Flowty proxy — forwards a single collection page request.
// Called by Vercel API routes that are blocked by Flowty's IP restrictions.
// Auth: Bearer ${FLOWTY_PROXY_TOKEN}

const FLOWTY_PROXY_TOKEN = Deno.env.get("FLOWTY_PROXY_TOKEN")
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
const FLOWTY_BASE = "https://api2.flowty.io/collection";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
};

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${FLOWTY_PROXY_TOKEN}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body: { contractAddress: string; contractName: string; payload: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { contractAddress, contractName, payload } = body;
  if (!contractAddress || !contractName) {
    return new Response(JSON.stringify({ error: "contractAddress and contractName required" }), { status: 400 });
  }

  try {
    const upstream = await fetch(`${FLOWTY_BASE}/${contractAddress}/${contractName}`, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(12000),
    });

    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 502 });
  }
});
