import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  const flowId = request.nextUrl.searchParams.get('flowId') ?? ''
  const width = request.nextUrl.searchParams.get('width') ?? '180'
  if (!flowId || !/^[a-zA-Z0-9_-]{1,80}$/.test(flowId)) {
    return new NextResponse(null, { status: 400 })
  }
  const upstream = await fetch(
    `https://assets.nbatopshot.com/media/${flowId}/image?width=${width}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )
  if (!upstream.ok) {
    return new NextResponse(null, { status: upstream.status })
  }
  const blob = await upstream.arrayBuffer()
  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg'
  return new NextResponse(blob, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  })
}
