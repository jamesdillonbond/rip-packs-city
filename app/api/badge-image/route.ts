import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Real badge artwork proxy. Two upstream sources, selected by ?src:
//   (default / topshot) → www.nbatopshot.com/cdn-cgi/image/.../img/momentTags/animated/<camelSlug>.gif (returns webp)
//   allday              → https://assets.nflallday.com/static/images/badgesV3/<kebab-slug>.svg
// Each upstream has its own slug allowlist (the slug is echoed into the path, so
// the allowlist is the injection guard). Both CDNs require a browser UA. Served
// same-origin so no CSP host needs whitelisting. Anon-public via proxy.ts.
//
// NFL All Day source + slugs verified live off dapper.market 2026-06-29 (the
// slug is the Atlas badge `slug`, already stored in badge_editions.set_play_tags).

const TOPSHOT_SLUGS = new Set([
  'rookieYear','topShotDebut','rookiePremiere','rookieOfTheYear',
  'rookieMint','championshipYear','threeStars',
])

const ALLDAY_SLUGS = new Set([
  'all-day-debut','rookie-year','rookie-mint','challenge-reward',
  'championship-year','dynamic-moment','hall-of-fame','crafted-reward',
])

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name') ?? ''
  const src = request.nextUrl.searchParams.get('src') ?? 'topshot'

  let upstreamUrl: string | null = null
  if (src === 'allday') {
    if (name && ALLDAY_SLUGS.has(name)) {
      upstreamUrl = `https://assets.nflallday.com/static/images/badgesV3/${name}.svg`
    }
  } else {
    if (name && TOPSHOT_SLUGS.has(name)) {
      upstreamUrl = `https://www.nbatopshot.com/cdn-cgi/image/width=96,height=96,quality=80,format=webp//img/momentTags/animated/${name}.gif`
    }
  }

  if (!upstreamUrl) {
    return new NextResponse(null, { status: 400 })
  }

  const upstream = await fetch(upstreamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!upstream.ok) {
    return new NextResponse(null, { status: upstream.status })
  }
  // Binary passthrough — Top Shot art is now webp (Cloudflare-resized animated
  // GIF), NFL All Day art is SVG; both are served through as-is by content-type.
  const buf = await upstream.arrayBuffer()
  const contentType = upstream.headers.get('content-type') ?? 'image/webp'
  return new NextResponse(buf, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  })
}
