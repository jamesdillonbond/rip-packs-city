// app/api/public/team-logo/[league]/[id]/route.ts
//
// An NBA / WNBA team logo, rasterized to PNG and served same-origin:
//   GET /api/public/team-logo/nba/1610612748
//
// WHY (2026-09-29). Team pages drew their logo straight from cdn.nba.com / cdn.wnba.com. Chrome
// fails that request with net::ERR_HTTP2_PROTOCOL_ERROR — reproduced in installed Chrome 153 from
// Trevor's residential connection, in bundled Chromium, and with an ordinary Chrome user agent —
// while a server-side HTTP/1.1 fetch of the same URL answers 200 image/svg+xml. So the logo never
// painted for a Chrome visitor. Fetching it here and serving it from our origin removes the
// browser↔CDN leg.
//
// ⛔ WHY RASTERIZED, NOT PROXIED. The CDN only publishes SVG (the .png path answers 403), and an SVG
// served from OUR origin is same-origin and navigable: a stored-XSS surface, which is why
// lib/media/avatar-proxy.ts refuses SVG outright. A PNG carries no script, so sharp renders it.
//
// ⚠ SSRF: the upstream URL is built only from a two-value league allowlist and an all-digits id.

import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"

export const runtime = "nodejs"
export const maxDuration = 20

const UPSTREAM: Record<string, (id: string) => string> = {
  nba: (id) => `https://cdn.nba.com/logos/nba/${id}/global/L/logo.svg`,
  wnba: (id) => `https://cdn.wnba.com/logos/wnba/${id}/global/L/logo.svg`,
}
const ID_RE = /^\d{6,12}$/
const SIZE = 256
const MAX_SVG_BYTES = 512 * 1024

function notFound(): NextResponse {
  // Uncached, so a transient upstream failure is retried; TeamLogo falls back to initials on error.
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ league: string; id: string }> }) {
  const { league, id } = await params
  const build = UPSTREAM[league]
  if (!build || !ID_RE.test(id)) return notFound()

  try {
    const res = await fetch(build(id), { signal: AbortSignal.timeout(10_000) })
    const type = res.headers.get("content-type") ?? ""
    if (!res.ok || !type.startsWith("image/svg")) {
      console.warn(`[team-logo] upstream league=${league} id=${id} status=${res.status} type=${type || "none"}`)
      return notFound()
    }
    const svg = Buffer.from(await res.arrayBuffer())
    if (svg.byteLength > MAX_SVG_BYTES) return notFound()

    const png = await sharp(svg, { density: 300 })
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()

    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    })
  } catch (err) {
    console.warn(`[team-logo] error league=${league} id=${id} ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
    return notFound()
  }
}
