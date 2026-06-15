import { NextRequest, NextResponse } from "next/server"

// TEMPORARY probe — verifies the live Top Shot public-api GQL schema for the
// special-serial owner-resolution build (A1). Strong-key gated; to be REMOVED
// once the searchMintedMoments unblock is confirmed. TS public-api is public
// data; this is a thin passthrough through the topshot-proxy worker.
// ?route= selects the proxy worker route (topshot | topshot-browser |
// topshot-marketplace) so we can test the browser-fingerprinted routes.
export const maxDuration = 30

const PROBE_KEY = "rpcprobe_9f3a2c7b8e1d4655a0c9f2e7b3148d6a"
const TS_PROXY_URL = process.env.TS_PROXY_URL || "https://topshot-proxy.tdillonbond.workers.dev/topshot"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

function proxyUrlForRoute(route: string): string {
  // Replace the last path segment of the configured proxy URL with `route`.
  return TS_PROXY_URL.replace(/\/[^/]*$/, "/" + route)
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("k") !== PROBE_KEY) {
    return NextResponse.json({ error: "nope" }, { status: 401 })
  }
  const route = req.nextUrl.searchParams.get("route") || "topshot"
  let body: { query?: string; variables?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }
  if (!body.query) return NextResponse.json({ error: "query required" }, { status: 400 })

  const url = proxyUrlForRoute(route)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: body.query, variables: body.variables ?? {} }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
    const raw = await res.text()
    return NextResponse.json({ status: res.status, route, proxy_url: url, body: raw.slice(0, 8000) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), route, proxy_url: url }, { status: 500 })
  }
}
