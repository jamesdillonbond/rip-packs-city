import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

const VALID_SLUGS = new Set([
  'rookieYear','topShotDebut','rookiePremiere','rookieOfTheYear',
  'rookieMint','championshipYear','threeStars'
])

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name') ?? ''
  console.log('[badge-image] url=', request.url, 'name=', name)
  if (!name || !VALID_SLUGS.has(name)) {
    return new NextResponse(null, { status: 400 })
  }
  const upstream = await fetch(
    `https://nbatopshot.com/img/momentTags/static/${name}.svg`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )
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
