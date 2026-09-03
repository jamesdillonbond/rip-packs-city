import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Same bound, same reasoning, as app/api/badge-image and
// app/api/public/ipfs-media/[cid]: well under the platform's own initial-response
// cutoff, so the abort fires before the platform kills the function and the
// soft-fail below is actually reachable.
const UPSTREAM_TIMEOUT_MS = 8_000

export async function GET(request: NextRequest) {
  const flowId = request.nextUrl.searchParams.get('flowId') ?? ''
  const width = request.nextUrl.searchParams.get('width') ?? '180'
  if (!flowId || !/^[a-zA-Z0-9_-]{1,80}$/.test(flowId)) {
    return new NextResponse(null, { status: 400 })
  }
  // ⚠ Unbounded and uncaught until 2026-09-03 — the same shape as
  // app/api/badge-image, and outside `og-fetches-are-bounded`'s walk for the
  // same reason. A thumbnail is decorative; a 500 is not.
  let upstream: Response
  try {
    upstream = await fetch(
      `https://assets.nbatopshot.com/media/${flowId}/image?width=${width}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
    )
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown'
    console.log(
      `[moment-thumbnail] upstream fetch failed flowId=${flowId} name=${name} reason=${name === 'TimeoutError' ? 'abort_timeout' : 'transport'}`,
    )
    return new NextResponse(null, { status: 502 })
  }
  if (!upstream.ok) {
    // The CDN answered and said no — pass its status through unchanged.
    return new NextResponse(null, { status: upstream.status })
  }
  const blob = await upstream.arrayBuffer()
  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg'
  return new NextResponse(blob, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable, stale-while-revalidate=86400',
    },
  })
}
