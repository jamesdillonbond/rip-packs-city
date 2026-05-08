// app/api/public/log/empty-sniper/route.ts
//
// Diagnostic beacon for the "iPhone sniper feed empty" report (beta_feedback_inbox #402).
// Sniper page client fires this once per session when the empty-state renders, so we can
// distinguish:
//   - server returned zero deals (upstream issue)
//   - server returned deals but visibleDeals filter zeroed them (filter bug)
//   - fetch never resolved (auth/cookie/CORS/ITP)
// Sits under /api/public/* so proxy.ts doesn't gate it — iPhone Safari with broken
// session cookies can still beacon. Origin-locked to rippackscity.com to keep random
// scrapers out; payload only ever lands in Vercel runtime logs (no DB writes).
//
// Search Vercel logs for `[empty-sniper-beacon]` to find these.

import { NextRequest, NextResponse } from "next/server"

const ALLOWED_ORIGIN_HOSTS = new Set([
  "www.rippackscity.com",
  "rippackscity.com",
  "rip-packs-city.vercel.app",
  "localhost:3000",
])

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin") ?? ""
  let originHost = ""
  try {
    if (origin) originHost = new URL(origin).host
  } catch {
    /* malformed Origin = reject */
  }
  if (!originHost || !ALLOWED_ORIGIN_HOSTS.has(originHost)) {
    return NextResponse.json({ ok: false, error: "origin" }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "json" }, { status: 400 })
  }

  // Truncate fields server-side so a single beacon can't dump unbounded text into logs.
  const cap = (v: unknown, n: number) =>
    typeof v === "string" ? v.slice(0, n) : v

  const payload = {
    ua: cap(body.ua, 400),
    viewport: body.viewport,
    screen: body.screen,
    pixelRatio: body.pixelRatio,
    collection: cap(body.collection, 64),
    feedKey: cap(body.feedKey, 400),
    fetchStatus: body.fetchStatus,
    fetchError: cap(body.fetchError, 200),
    serverDealsCount: body.serverDealsCount,
    visibleDealsCount: body.visibleDealsCount,
    tsCount: body.tsCount,
    flowtyCount: body.flowtyCount,
    hasOwnerKey: body.hasOwnerKey,
    filters: body.filters,
    pageUrl: cap(body.pageUrl, 400),
    clientTs: body.clientTs,
  }

  console.log(`[empty-sniper-beacon] ${JSON.stringify(payload)}`)

  return new NextResponse(null, { status: 204 })
}
