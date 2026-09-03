import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Real badge artwork proxy. Two upstream sources, selected by ?src:
//   (default / topshot) → assets.nbatopshot.com/static/momentTags/static/<camelSlug>.svg
//                         (2026-07-07: the old www.nbatopshot.com/cdn-cgi/.../momentTags/animated/<slug>.gif
//                         path is DEAD — 302→apex→404 for every slug. The static SVG path is what
//                         the live TS moment page renders; verified via nbatopshot.com/moment/25510.)
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
  // 2026-07-10 badge-audit parity: Challenge Reward + the "Leaderboard Reward"
  // badge (v2's chip still loads the internal codename asset codenameMercury.svg).
  'challengeReward','codenameMercury',
])

// Upstream fetch timeout, and the reason it is 8s rather than "the platform
// limit". `app/api/public/ipfs-media/[cid]` learned this the expensive way: its
// bound was set to the platform's own 25s initial-response cutoff, so the
// platform always won the race and killed the function BEFORE the catch could
// run — making the soft-fail path unreachable dead code for exactly the slow-
// upstream case it was written for (205 such 504s in one 40-minute window,
// 2026-07-27). A bound only helps if it fires FIRST.
const UPSTREAM_TIMEOUT_MS = 8_000

const ALLDAY_SLUGS = new Set([
  'all-day-debut','rookie-year','rookie-mint','challenge-reward',
  'championship-year','dynamic-moment','hall-of-fame','crafted-reward',
  // 2026-07-11: official special-serial badge art (what nflallday.com renders
  // next to #1 / jersey / last serials) — used by SpecialSerialGlyph.
  'first-serial','player-number','perfect-serial',
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
      upstreamUrl = `https://assets.nbatopshot.com/static/momentTags/static/${name}.svg`
    }
  }

  if (!upstreamUrl) {
    return new NextResponse(null, { status: 400 })
  }

  // ⚠ THIS FETCH WAS UNBOUNDED AND UNCAUGHT until 2026-09-03, and both halves
  // mattered. Live runtime errors for the 24h to 2026-09-03 05:43Z carry a group
  // of **463 `TimeoutError: The operation was aborted due to timeout` across 69
  // users** whose routes include this one — the bare rejection escaping the
  // handler, which is a 500 rather than a status an `<img onError>` can act on.
  //
  // ⭐ THE POINT IS NOT THAT THIS FILE WAS MISSED — IT IS *WHY*.
  // `__tests__/og-fetches-are-bounded.test.ts` drove exactly this class to zero
  // on 2026-08-29 (30 bare calls across 28 files) and then froze the ban to the
  // files where the class had been found: `app/api/og/**` and `lib/og/**`. This
  // route is `app/api/badge-image`, so it was outside that walk BY CONSTRUCTION
  // — the third time in this repo a guard's glob has excluded the next instance
  // (see `scripts/check-unbounded-server-reads.mjs`, which records the same
  // shape for the Supabase-read class).
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    // 502, never a throw: the badge is decorative, and a status lets the caller's
    // `onError` fall back to no badge instead of rendering a broken image.
    //
    // ⚠ NAMING WHICH FAILURE IT WAS is the whole value of the log line —
    // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError",
    // anything else is a genuine transport fault, and raising the bound only
    // helps the first kind.
    const name = err instanceof Error ? err.name : 'unknown'
    console.log(
      `[badge-image] upstream fetch failed src=${src} name=${name} reason=${name === 'TimeoutError' ? 'abort_timeout' : 'transport'}`,
    )
    return new NextResponse(null, { status: 502 })
  }
  if (!upstream.ok) {
    // Distinct from the branch above: the CDN ANSWERED and said no. Its status
    // is passed through unchanged, because it is the CDN's answer and no timeout
    // change can move it.
    return new NextResponse(null, { status: upstream.status })
  }
  // Binary passthrough — both sources are SVG now; served through as-is by
  // content-type.
  //
  // ⚠ THE BODY READ NEEDS ITS OWN CATCH, AND THE `try` ABOVE DOES NOT COVER IT.
  // The abort signal attached to the fetch stays live for the response body, so
  // a deadline that elapses — or a connection reset — DURING `arrayBuffer()`
  // rejects here, outside every catch in this handler, and escapes as a 500.
  // That is the same defect this route's header describes, one statement later:
  // a bound whose failure is a throw rather than a status.
  //
  // ⓘ Found on 2026-09-03 by grepping the SHAPE after the sibling
  // `/api/public/ipfs-media` was measured doing it at scale — 426 uncaught
  // TimeoutErrors across 60 users in 24 h, from a signal that outlived the
  // headers. This route buffers rather than streams, so the window is far
  // smaller and no live instance is claimed here; the branch is unreachable-
  // looking, not unreachable. CLAUDE.md's rule is to grep for the EXPRESSION,
  // not the file.
  let buf: ArrayBuffer
  try {
    buf = await upstream.arrayBuffer()
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown'
    console.log(
      `[badge-image] upstream body failed src=${src} name=${name} reason=${name === 'TimeoutError' ? 'abort_body' : 'transport_body'}`,
    )
    return new NextResponse(null, { status: 502 })
  }
  const contentType = upstream.headers.get('content-type') ?? 'image/webp'
  return new NextResponse(buf, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  })
}
