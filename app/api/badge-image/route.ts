import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Real badge artwork proxy. Two upstream sources, selected by ?src:
//   (default / topshot) → https://nbatopshot.com/img/momentTags/static/<camelSlug>.svg
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
      upstreamUrl = `https://nbatopshot.com/img/momentTags/static/${name}.svg`
    }
  }

  if (!upstreamUrl) {
    return new NextResponse(null, { status: 400 })
  }

  const upstream = await fetch(upstreamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!upstream.ok) {
    return new NextResponse(null, { status: upstream.status })
  }
  const svg = await upstream.text()
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  })
}
