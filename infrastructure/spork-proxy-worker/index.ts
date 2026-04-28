// spork-proxy worker
// Forwards Flow REST API requests to historical access nodes on port 8070.
// Used by Supabase edge functions to scan pre-current-spork blockchain history.

export interface Env {}

const SPORK_NODES: Record<string, string> = {
  mainnet24: "http://access-001.mainnet24.nodes.onflow.org:8070",
  mainnet25: "http://access-001.mainnet25.nodes.onflow.org:8070",
  mainnet26: "http://access-001.mainnet26.nodes.onflow.org:8070",
  mainnet27: "http://access-001.mainnet27.nodes.onflow.org:8070",
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Health check
    if (path === "/" || path === "/health") {
      return json({ ok: true, worker: "spork-proxy", sporks: Object.keys(SPORK_NODES) })
    }

    // Match /spork/{name}/... or /{name}/... — both supported
    const match =
      path.match(/^\/spork\/([^\/]+)(\/.*)$/) ??
      path.match(/^\/([^\/]+)(\/.*)$/)
    if (!match) return json({ error: "expected path /spork/{spork}/v1/..." }, 400)

    const sporkName = match[1]
    const restPath = match[2]
    const nodeBase = SPORK_NODES[sporkName]
    if (!nodeBase) {
      return json(
        { error: `unknown spork: ${sporkName}`, available: Object.keys(SPORK_NODES) },
        400
      )
    }

    const upstreamUrl = `${nodeBase}${restPath}${url.search}`

    try {
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: { "User-Agent": "spork-proxy/1.0" },
        signal: AbortSignal.timeout(25_000),
      })
      const body = await upstream.text()
      return new Response(body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
          "Access-Control-Allow-Origin": "*",
          "X-Spork": sporkName,
        },
      })
    } catch (e) {
      return json(
        {
          error: "upstream fetch failed",
          upstream: upstreamUrl,
          message: (e as Error).message,
        },
        502
      )
    }
  },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}
