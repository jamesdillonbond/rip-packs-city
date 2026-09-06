// proxy.ts
//
// Next.js 16 root middleware (the "proxy.ts" convention replaces the legacy
// "middleware.ts" filename in Next.js 16). Site-wide auth + allow-list gate.
//
// Order of operations on every matched request:
//   1. CORS preflight (OPTIONS) for the public-CORS API paths.
//   2. Bypass-token check — if Authorization: Bearer <X> OR ?token=<X> carries
//      INGEST_SECRET_TOKEN or CRON_SECRET, short-circuit ALL further middleware
//      logic. Keeps cron-job.org and internal pipeline jobs reachable
//      (/api/seed-wallet-refresh, /api/ingest, /api/listing-cache*,
//      /api/sales-indexer*, /api/flowty-tx-scanner, /api/fmv-recalc, etc.),
//      regardless of whether the cron is configured with a header or a query
//      param.
//   3. Per-IP rate limiting on /api/* (existing behaviour — preserved).
//   4. Public-bypass paths (homepage, /login, /early-access, /auth, /admin,
//      the marketing-surface API routes, /_next, static assets).
//   5. Authenticated Supabase session check (else → /login?next=<path>).
//   6. Allow-list cache (cookie) → service-role check_email_allowed RPC.
//      On revocation: signOut + /login?error=access_revoked.
//
// The allow-list cookie `rpc_al_check` carries { email, expiresAt } JSON for
// 60s. It is httpOnly + sameSite=lax + secure but NOT cryptographically
// signed — worst case if a user tampers, they buy at most 60s of stale
// access; the next miss-the-cache hit catches them via the RPC. The `email`
// match guard prevents using one user's cached cookie under another user's
// session.

import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { CANDY_MLB_PUBLIC, PANINI_PUBLIC } from "@/lib/launch-flags"

const ALLOWED_ORIGINS = [
  "https://rip-packs-city.vercel.app",
  "https://rippackscity.com",
  "https://www.rippackscity.com",
  "http://localhost:3000",
]

const CORS_API_PATHS = ["/api/fmv", "/api/sniper-feed", "/api/health"]

const ALLOWLIST_COOKIE = "rpc_al_check"
const ALLOWLIST_TTL_SECONDS = 60

// Static assets that bypass auth at the in-middleware level.
//
// ⚠ AN EXACT SET, NOT A PATTERN, AND THAT IS THE WHOLE POINT. Until 2026-08-13
// this was an unanchored suffix test — `/\.(?:png|jpe?g|svg|webp|ico|css|js)$/i`
// — which matched ANY path ending in one of those extensions, including a gated
// route whose trailing segment a visitor controls.
//
// ✅ CONFIRMED LIVE, on evidence that survives a control: anonymously,
// `GET /api/mcp/keys/<uuid>` answers 307 → /login, while the same path with a
// `.png` suffix answers **405 Method Not Allowed**. A 405 cannot come from this
// wall — the wall's answer is the 307 — so the suffixed request reached the
// handler. That is the whole finding, and it is enough to justify the fix.
//
// ⛔ IT IS DEFENSE-IN-DEPTH, NOT A CONFIRMED BREACH, and two separate sessions
// first recorded it as a breach off the same bad inference. Both reported that
// `GET /topshot.png` (and later `/profile/edit.css`) "served a gated page to an
// anonymous visitor". Neither did. The bypass buys the next hop, and the next hop
// was already public BY DESIGN — `/[collection]/overview` since the 2026-07-17
// un-gate, `/profile/[username]` always. The controls settle it: with NO
// extension and NO bypass, `/totally-bogus-slug/overview` returns the same page,
// and `/profile/zzz-no-such-user-9931` returns MORE bytes than the "leak" did.
// **A 200 next to a 307 proves nothing until you show the 200 needed the bypass.**
// Every gated dynamic route the suffix currently reaches carries its own auth
// check — good habits plus luck, not architecture. Fix the wall anyway; that is
// what defense in depth means.
//
// ⛔ DO NOT "fix" this by anchoring the regex to a single root segment
// (`/^\/[^/]+\.(?:png|...)$/`). That was tried first and it is NOT sufficient:
// the collection pages live at the URL ROOT (`/[collection]`), the same
// namespace as the root static assets, so `/topshot.png` still matches. Only an
// exact allowlist separates the two, because nothing about the SHAPE of the path
// distinguishes an asset from a collection slug.
//
// Cost of this design: a new file dropped into `public/` root is gated until it
// is added here. That is the correct trade for a namespace shared with a dynamic
// route — prefer putting new assets under `/img/`, which the matcher at the
// bottom of this file already excludes from the proxy entirely.
//
// ⚠ NARROWING THIS FROM A SUFFIX TEST TO A SET REMOVES `.js`/`.css` FROM THE
// PUBLIC SET, so the question "what else did the regex keep reachable?" has to be
// answered before shipping, not after. Measured 2026-08-15, and the one real
// candidate came back CLEAR: `@vercel/analytics` and `@vercel/speed-insights` are
// both mounted in `app/layout.tsx` and load `/_vercel/{insights,speed-insights}/
// script.js` — paths that match neither the `/_next/` check below nor the
// matcher's exclusions, and which the old regex published by side effect. They
// are NOT affected, because Vercel serves them at the platform edge and this
// proxy never runs on them. The discriminator is `applySecurityHeaders`: live,
// `/window.svg` and `/login` come back with `X-Frame-Options: DENY` +
// `X-Content-Type-Options: nosniff` while both `/_vercel/*` scripts carry
// NEITHER header — proof of non-interception, where a 200 alone proves nothing
// (a 302 to /login also answers 200). No allowlist entry is added for them on
// purpose: a line that never executes reads as protection and is not.
//
// Everything else in `public/` is already accounted for: `*.json`, `offline.html`
// and the `fonts/OFL-*.txt` licenses do not match the old regex either, so they
// were gated before this change and stay gated after it. Sweep with
// `find public -type f | sed 's/.*\.//' | sort -u` when adding an asset type.
const STATIC_ROOT_ASSETS = new Set([
  "/rip-packs-city-logo.png",
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
  "/favicon.ico",
])

// The vendored brand fonts under `public/fonts`.
//
// ⚠ THIS WAS MISSING UNTIL 2026-08-13 AND IT WAS A LIVE PRODUCT BUG. The matcher
// at the bottom of this file does not exclude `/fonts/`, and `ttf` was not one of
// the extensions in `STATIC_EXT_RX` (the suffix test that preceded
// `STATIC_ROOT_ASSETS` above — the name is kept here only as history; do not go
// looking for it), so every request for a vendored font ran the auth
// gate, failed `isPublicPath`, and was 302'd to /login. Two SERVER-SIDE
// consumers fetch these files over HTTP with no session — the OG profile card
// (`runtime = "edge"`, so it CANNOT read them off disk) and the trophy-case PDF
// — and a followed redirect hands both an HTML document at status 200. satori
// then throws `Unsupported OpenType signature <!DO` (the first four bytes of
// `<!DOCTYPE`) from inside the ImageResponse STREAM, after GET has returned,
// where that route's try/catch cannot reach it; that reddened CI on 2026-08-13,
// and the PDF had been silently unbranded since it shipped.
//
// ⚠ DELIBERATELY NARROWER THAN ADDING THE EXTENSIONS TO THE OLD `STATIC_EXT_RX`,
// which is what the first version of this fix did. That regex matched ANY path
// ending in the extension, so it would also have published a gated route whose
// trailing dynamic segment a visitor controls (`/whatever/<user-supplied>.ttf`).
// ⚠ THE ORIGINAL VERSION OF THIS NOTE THEN SAID "the existing entries carry that
// property for `js|css|png|…` already; there is no reason to widen the class
// further" — TRUE WHEN WRITTEN, AND IT WAS DESCRIBING A HOLE IN THE AUTH WALL AS
// AN ACCEPTED COST. Two days later that hole was confirmed reachable (the 405
// above). The precedent was the bug. Reasoning
// "the neighbouring rule is already this loose" argues for fixing the neighbour,
// never for matching it. Directory AND extension, both required, single level.
const FONT_ASSET_RX = /^\/fonts\/[^/]+\.(?:ttf|otf|woff2?)$/i

// ── Rate limiting (in-memory, per-IP) ────────────────────────────────────────
// ⚠ These Maps are MODULE-SCOPE, i.e. PER-LAMBDA-INSTANCE on serverless. The
// effective global ceiling is therefore (max × warm instances), not `max`.
// This is a burst cap that bounds a single hot IP; it is NOT a global limit.
// A real global limit needs shared state (KV/Redis/Upstash) — tracked as the
// follow-on to this change. Do not read these numbers as absolute guarantees.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const pageRateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60

// Page routes get their own, more generous ceiling and their own counter, so
// page traffic never consumes the API budget (or vice versa). Next.js prefetch
// fires an RSC request per hovered link, so a real reader skimming a catalog
// page legitimately bursts well past the 60/min API budget — 60 here would
// throw 429s at humans. 120/min ≈ 2 req/s sustained, which no human browsing
// session reaches but which does bound an unauthenticated crawler hammering a
// single IP (the 2026-08-06 crawl ran ~38 req/min sustained on one route with
// nothing in front of it).
const PAGE_RATE_LIMIT_MAX_REQUESTS = 120

// ── API budget shaping (2026-09-06) ──────────────────────────────────────────
// Measured on a 510-page QA sweep from ONE IP: the 60/min API budget was spent
// by `/api/profile/me` (17× 429), `/api/telemetry` (7×), `/api/track-funnel`
// (5×) and `/api/public/pinnacle-image` (3×) — i.e. by the per-page chrome
// and by IMAGES, not by anything a person types. A Pinnacle render page alone
// issues 4–5 proxied images + 3 chrome calls, so a collector opening ~6 such
// pages in a minute would start seeing blank art and a dead profile pill —
// and a SIGNED-IN dashboard user, whose page polls, was under the same 60.
//
//   • Media proxies get their own counter and a 10× ceiling: an image is one
//     tile, not one API call, and a 429 there renders as a broken thumbnail
//     that no error surface reports (the client-only failure class, #34/#37).
//   • A signed-in reader gets 4× the anonymous API ceiling, mirroring the page
//     limiter's "a signed-in reader is never throttled" posture without going
//     fully unmetered on a mutable surface.
// Still per-lambda, still a burst cap, still not a global limit (see above).
const MEDIA_PROXY_PREFIXES = [
  "/api/public/pinnacle-image",
  "/api/public/ipfs-media",
  "/api/public/avatar-media",
  "/api/badge-image",
  "/api/moment-thumbnail",
  "/api/og",
] as const
const mediaRateLimitMap = new Map<string, { count: number; resetAt: number }>()
const MEDIA_RATE_LIMIT_MAX_REQUESTS = 600
const SIGNED_IN_API_RATE_LIMIT_MAX_REQUESTS = 240

export function isMediaProxyPath(pathname: string): boolean {
  return MEDIA_PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

/** The API burst ceiling that applies to this request (exported for the test). */
export function apiRateLimitFor(pathname: string, signedIn: boolean): { max: number; bucket: "media" | "api" } {
  if (isMediaProxyPath(pathname)) return { max: MEDIA_RATE_LIMIT_MAX_REQUESTS, bucket: "media" }
  return { max: signedIn ? SIGNED_IN_API_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS, bucket: "api" }
}

// Page routes worth metering: DB-backed public surfaces that render server-side.
// Keyed on the SECOND path segment for /<collection>/<page> (segment 0 is the
// collection slug), plus three top-level surfaces matched by prefix.
const RATE_LIMITED_COLLECTION_PAGES = new Set([
  "collection",
  "edition",
  "player",
  "team",
  "set",
  "series",
  "pack",
  "moment",
])

export function isRateLimitedPageRoute(pathname: string): boolean {
  if (pathname.startsWith("/profile/")) return true
  if (pathname.startsWith("/moment/")) return true
  if (pathname === "/special-serial-owners") return true

  const segments = pathname.split("/").filter(Boolean)
  return segments.length >= 2 && RATE_LIMITED_COLLECTION_PAGES.has(segments[1])
}

// Cheap, cookie-only signed-in heuristic — deliberately NOT a session lookup.
// Supabase SSR writes `sb-<project-ref>-auth-token[.N]`. We only need to know
// whether to EXEMPT this request from the anonymous page cap; the real auth
// gate still runs downstream, so a false positive here costs nothing more than
// a skipped rate-limit check for someone holding a stale auth cookie.
export function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"))
}

function getRateLimitKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  )
}

function isRateLimited(
  key: string,
  map: Map<string, { count: number; resetAt: number }> = rateLimitMap,
  max: number = RATE_LIMIT_MAX_REQUESTS
): boolean {
  const now = Date.now()
  const entry = map.get(key)
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  entry.count++
  return entry.count > max
}

function cleanupRateLimitMap() {
  const now = Date.now()
  for (const map of [rateLimitMap, pageRateLimitMap, mediaRateLimitMap]) {
    for (const [key, entry] of map) {
      if (now > entry.resetAt) {
        map.delete(key)
      }
    }
  }
}

let lastCleanup = Date.now()

// ── Bypass-token helper ────────────────────────────────────────────────────
// Returns true iff EITHER:
//   • Authorization: Bearer <X> where X matches INGEST_SECRET_TOKEN or
//     CRON_SECRET, OR
//   • ?token=<X> where X matches the same.
// NEVER logs the token value. Returns false silently for any other shape —
// missing/wrong header and missing/wrong query param all fall through to the
// normal middleware path so attackers can't probe for a valid token via
// response-shape diffing. Does NOT consume or strip either input — downstream
// routes still see the original Authorization header and ?token= query param
// for their own re-validation.
function tokenMatches(token: string): boolean {
  if (!token) return false
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && token === ingest) return true
  if (cron && token === cron) return true
  return false
}

function hasValidBypassToken(request: NextRequest): boolean {
  // Header form
  const authHeader = request.headers.get("authorization") || ""
  if (authHeader.startsWith("Bearer ")) {
    if (tokenMatches(authHeader.slice(7))) return true
  }
  // Query-param form
  const queryToken = request.nextUrl.searchParams.get("token") || ""
  if (queryToken && tokenMatches(queryToken)) return true
  return false
}

// ── Public-bypass logic ─────────────────────────────────────────────────────
// Paths listed here skip both the session check and the allow-list check.
// Order doesn't matter — first match wins. `method` is consulted only by the
// handful of entries that mix safe (GET/HEAD) and mutating (POST/PATCH/DELETE)
// handlers under one path.
//
// Exported SOLELY so __tests__/proxy-is-public-path.test.ts can pin the
// public/gated boundary as a (pathname, method) table — this is the app's
// security wall, and every incident in the ledger where a "gated" surface was
// anon-reachable (or a launch flag silently no-op'd) is a bug in THIS function.
// Next.js middleware only consumes the `proxy` + `config` exports, so an extra
// named export changes no runtime behaviour.
export function isPublicPath(pathname: string, method: string): boolean {
  // ── Panini WC Prizm surfaces — gated iff `PANINI_PUBLIC` is false (live since 2026-08-01) ──
  // Gates the page (/insights/panini-squeeze), its public JSON
  // (/api/public/insights/panini-squeeze) and its OG card (/api/og/insights/panini-squeeze) — all match
  // `…/panini`. Returning false routes them to the auth + allow-list gate, so only signed-in allow-listed
  // users can preview. Authed cron/ingest is unaffected (bearer-token bypass runs before this in proxy()).
  // GO-LIVE = flip PANINI_PUBLIC to `true` in lib/launch-flags.ts — ONE line, which simultaneously
  // un-gates these three routes, adds the sitemap slug, adds the /insights hub card, drops the layout
  // robots:noindex and arms the smoke check. Do NOT delete this line; the flag is what makes the
  // launch atomic. (Before 2026-07-28 this was a bare regex with no flag behind it, so flipping
  // PANINI_PUBLIC would have silently changed nothing — the trap this wiring removes.)
  if (!PANINI_PUBLIC && /^\/(?:insights|api\/public\/insights|api\/og\/insights)\/panini/.test(pathname))
    return false
  // ── Candy MLB ICONs (chain two, Solana) — gated iff `CANDY_MLB_PUBLIC` is false (live since 2026-07-31) ──
  // Gates /insights/candy-mlb + /api/public/insights/candy-mlb + /api/og/insights/candy-mlb.
  // GO-LIVE = flip CANDY_MLB_PUBLIC to `true` in lib/launch-flags.ts — ONE line, which
  // simultaneously un-gates these three routes, adds the sitemap slug, adds the /insights hub
  // card, drops the layout robots:noindex and arms the smoke check. Do NOT delete this line;
  // the flag is what makes the launch atomic. `candy_mlb.is_active` and the registry's
  // `published` flag are SEPARATE switches — see docs/candy-go-live-flip-2026-07-25.md.
  if (!CANDY_MLB_PUBLIC && /^\/(?:insights|api\/public\/insights|api\/og\/insights)\/candy/.test(pathname))
    return false
  // Exact-match singletons
  // `/` (root) is public: it serves the marketing landing (HomePageMarketing)
  // to anonymous visitors so the canonical URL converts instead of bouncing
  // straight to /login. Signed-in users are redirected to /dashboard inside
  // the page component itself. This reverses the earlier closed-beta lockdown
  // as a deliberate funnel decision (2026-05-30) — the front door now shows
  // the value prop + links to the free /insights wedge surfaces.
  if (pathname === "/") return true
  if (pathname === "/favicon.ico") return true
  if (pathname === "/robots.txt") return true
  // ⚠ `/llms.txt` (the AI-crawler sibling of robots.txt, shipped in `public/`)
  // was 302'ing to /login — `.txt` is not a static-allowlist extension and there
  // was no exact entry, so the one file whose entire purpose is to be fetched by
  // an anonymous crawler was the one file they could not read. Found by sweeping
  // `public/` for extensions the allowlist does not cover, after the same
  // omission was traced as the cause of the /fonts/*.ttf outage. Kept as an
  // EXACT path rather than allowlisting `.txt`, which would also publish the OFL
  // license files by side effect rather than by decision.
  if (pathname === "/llms.txt") return true
  if (pathname === "/sitemap.xml") return true
  // Segment children of the sitemap index (generateSitemaps, 2026-07-11):
  // /sitemap/0.xml … /sitemap/4.xml must be anon-fetchable or Googlebot gets
  // 302→/login on every child the index advertises.
  if (/^\/sitemap\/\d+\.xml$/.test(pathname)) return true

  // ── Marketing / auth surface pages ───────────────────────────────────
  // /login + subpaths
  if (pathname === "/login" || pathname.startsWith("/login/")) return true
  // /early-access + subpaths
  if (pathname === "/early-access" || pathname.startsWith("/early-access/")) return true
  // /pricing — conversion funnel must be reachable unauth'd so prospects
  // can see what Pro unlocks before signing up.
  if (pathname === "/pricing" || pathname.startsWith("/pricing/")) return true
  // /about — marketing surface
  if (pathname === "/about" || pathname.startsWith("/about/")) return true
  // /blog + subpaths — force-static long-form marketing content built for SEO.
  // Linked from the public TopNav, so anon clicks must not bounce to /login.
  // Read-only static; sitemap lists the index + posts. (2026-06-08)
  if (pathname === "/blog" || pathname.startsWith("/blog/")) return true
  // /privacy + /terms — legal pages. Must be publicly readable (and crawlable;
  // app/sitemap.ts lists them) — without this anon visitors + Googlebot get
  // 302→/login on the privacy policy / terms of service. (2026-05-31)
  if (pathname === "/privacy" || pathname.startsWith("/privacy/")) return true
  if (pathname === "/terms" || pathname.startsWith("/terms/")) return true
  // /legal/* — legal-disclosure pages (e.g. /legal/fmv-methodology). Linked from
  // the public SiteFooter on every surface AND from the /pricing page ("How is
  // FMV calculated?"), so anon visitors + Googlebot must read them without a
  // 302→/login. Read-only static content; same risk profile as /privacy + /terms.
  // (2026-06-08)
  if (pathname === "/legal" || pathname.startsWith("/legal/")) return true
  // /auth + subpaths (covers /auth/confirm and similar)
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return true
  // /admin pages — enforce their own RPC_ADMIN_TOKEN bearer auth at the page
  // / route-handler level, so they bypass the user-session middleware. Note:
  // this covers /admin/allow-list, /admin/feedback, etc.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true

  // ── API routes that anon clients are allowed to hit ──────────────────
  // /api/auth + subpaths (sign-in flow)
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true
  // /api/early-access + subpaths (waitlist intake)
  if (pathname === "/api/early-access" || pathname.startsWith("/api/early-access/")) return true
  // /api/admin — has its own RPC_ADMIN_TOKEN bearer check
  if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) return true
  // /api/cron — external cron services hit these with CRON_SECRET
  if (pathname === "/api/cron" || pathname.startsWith("/api/cron/")) return true
  // /api/public/* — explicitly anon-safe routes (e.g. /api/public/profile/<u>
  // for the demo profile lookup the homepage links to)
  if (pathname === "/api/public" || pathname.startsWith("/api/public/")) return true
  // /api/wallet-search — exact path only; the marketing search box hits it
  if (pathname === "/api/wallet-search") return true
  // /api/teams/follow — per-league favorite toggle on the team hub. Public at
  // the proxy so the anon mount-check (GET -> {authed:false}) resolves without a
  // login bounce; the route ITSELF enforces auth (getUser -> 401) on POST/DELETE
  // and writes through the user's RLS session, so this adds no anon write access.
  if (pathname === "/api/teams/follow") return true
  // /api/rewards/track — the ONLY client-triggerable earn (fixed event string
  // mapped server-side to a daily-capped rule). Fired fire-and-forget from two
  // PUBLIC surfaces (the /insights/squeeze board on mount; the profile share
  // buttons), whose own comments assume an anon caller "just gets a 401".
  // Without this bypass the anonymous POST was 307d to /login, which rejects
  // POST with 405 — measured live 2026-08-28 in a clean anonymous browser:
  // every anon squeeze view logged `POST /login?next=%2Fapi%2Frewards%2Ftrack 405`.
  // The route ITSELF enforces auth (requireUser -> 401 JSON) and awards only to
  // the session-resolved user id, so this adds no anon write access — same
  // shape as /api/teams/follow above. The /api/ rate limiter still applies.
  if (pathname === "/api/rewards/track") return true
  // /api/track-click — fire-and-forget outbound-click logger. Anon visitors on
  // the public /insights surfaces (and the marketing home) fire it when they
  // click an outbound marketplace / View Listing link, so it must bypass the
  // auth gate. The route clamps + validates every field server-side; the
  // proxy /api/ rate limiter (60/min/IP) still applies.
  if (pathname === "/api/track-click") return true
  // /api/track-funnel — fire-and-forget top-of-funnel logger (home / share /
  // insights views + wallet-pastes). Anon visitors on the marketing home and
  // public surfaces fire it, so it must bypass the auth gate. The route
  // allowlists event_type + clamps every field server-side; the proxy /api/
  // rate limiter (60/min/IP) still applies.
  if (pathname === "/api/track-funnel") return true
  // /api/telemetry — fire-and-forget feature beacon behind lib/telemetry/track.ts.
  // Anon visitors fire it on public surfaces (found live on /insights/pack-sniper),
  // and without this bypass the unauthenticated POST is caught by the session gate,
  // 302'd to /login, and /login rejects POST with 405 — so the beacon is dropped and
  // the ENTIRE anonymous telemetry stream is lost. Positive control at the time of
  // the fix: usage_events held 10 `user:%` rows and ZERO `anon` rows over 14 days.
  // The route resolves the caller server-side (session -> wallet, else `user:<id>`,
  // else "anon"), clamps feature to 80 chars and metadata to 4 KB, writes only
  // usage_events, and ALWAYS returns 204 with a null body — so it is not an oracle.
  // The proxy /api/ rate limiter (60/min/IP) still applies: it runs BEFORE this
  // public-bypass block and exempts only /api/cron, /api/ingest and bot-token calls.
  // Same risk profile as track-click / track-funnel / subscribe above.
  if (pathname === "/api/telemetry") return true
  // /api/subscribe + subpaths — anon email / early-access capture (POST) plus
  // the email-link verify / unsubscribe GETs. The marketing home and /insights
  // lead-capture band hit POST /api/subscribe unauthenticated.
  if (pathname === "/api/subscribe" || pathname.startsWith("/api/subscribe/")) return true
  // /api/support-chat + subpaths — concierge is intentionally public so
  // unsigned visitors can ask questions and convert
  if (pathname === "/api/support-chat" || pathname.startsWith("/api/support-chat/")) return true
  // /api/og + subpaths — social-share crawlers (Twitter / Slack / Discord
  // / iMessage) need the OG card endpoints unauthenticated to render
  // preview cards. Without this they see a 307→/login redirect and pull a
  // generic Vercel auth thumbnail instead of the branded RPC card.
  if (pathname === "/api/og" || pathname.startsWith("/api/og/")) return true
  // /api/badge-image — GET-only edge proxy that serves the official Top Shot
  // badge SVGs (7-slug allowlist, no user data). The public /moment + entity
  // detail pages render real badge artwork via <img src="/api/badge-image?...">;
  // without this anon visitors (and the BadgeIcon/BadgeRow client surfaces when
  // logged out) get 307→/login and a broken image instead of the badge. Same
  // read-only asset-proxy risk profile as /api/og. (2026-06-15)
  if (pathname === "/api/badge-image") return true
  // /api/moment-thumbnail — the SAME shape as /api/badge-image above, missed when that one was
  // opened on 2026-06-15. GET-only edge proxy of `assets.nbatopshot.com` (a public CDN), no
  // session, no cookies, `flowId` validated against /^[a-zA-Z0-9_-]{1,80}$/ as its SSRF guard,
  // 8 s bound, soft-fails to 502 for an <img onError>. Decorative image bytes, nothing else.
  //
  // ⚠ MEASURED 2026-09-04 on the PUBLIC collection tab (/nba-top-shot/collection?q=<user>, which
  // the feature-tab regex below opens to anon): **26 of 374 tiles were broken**, every one an
  // `<img src="/api/moment-thumbnail?...">` that 307'd to /login and rendered **21 KB of login
  // HTML as an image**. Only 26 because most tiles carry a direct CDN URL and this endpoint is
  // the fallback for Moments that do not — so the failure is invisible on a spot check and
  // permanent for the Moments that need it.
  //
  // Fourth instance of this class today after badge-taxonomy/profile-me, the Pinnacle sniper feed
  // and pack-listings. The pairing test is the ratchet: an anon-public page must not call an API
  // that is not.
  //
  // ⛔ GET/HEAD ONLY, unlike the badge-image line above. That one is method-blind; this is not,
  // because there is no reason for a read-only asset proxy to accept a POST through the gate and
  // "the route only exports GET so a POST would 405 anyway" is a claim about the route, not about
  // the gate. Strict here costs nothing.
  if ((method === "GET" || method === "HEAD") && pathname === "/api/moment-thumbnail") return true
  // /api/health — uptime/smoke probes hit this anonymously
  if (pathname === "/api/health") return true
  // /api/bots/* — the Telegram + Discord bot webhooks. They authenticate every
  // request themselves (Telegram: the echoed X-Telegram-Bot-Api-Secret-Token
  // header == TELEGRAM_WEBHOOK_SECRET; Discord: Ed25519 signature verify against
  // DISCORD_PUBLIC_KEY), so they must bypass the user-session gate — the inbound
  // caller is a bot platform, not a signed-in RPC user. (2026-06-16)
  if (pathname === "/api/bots/telegram" || pathname === "/api/bots/discord") return true
  // /api/alerts/channels/verify-email — GET target of the alert-email
  // confirmation link, clicked from a mail client with no RPC session cookie.
  // Security rests on the one-time, 15-min-TTL code bound to (owner,email) at
  // creation. EXACT path only — /api/alerts/channels and /api/alerts/subscriptions
  // stay session-gated. (2026-06-16)
  if (pathname === "/api/alerts/channels/verify-email") return true
  // /api/fmv/demo — GET-only public FMV demo (5 real samples + API usage docs,
  // 1hr CDN cache, service-role read, no user data). Documented as a public
  // no-auth endpoint; linking it (pricing page, docs, social) must not bounce
  // to /login. The authenticated single/batch /api/fmv stays gated. (2026-06-13)
  if (pathname === "/api/fmv/demo") return true
  // /api/collection-snapshot — GET-only, wallet-keyed read backing the public
  // /share/<wallet> card (Total FMV + top moments). The /share server
  // component fetches this server-side WITHOUT a user cookie, so without this
  // bypass it 307→/login and every share card renders the empty "not found"
  // state — defeating the wallet-paste funnel that lands anon here. Read-only,
  // service-role-backed (wallet_moments_cache + fmv_snapshots), no write
  // handler exists, no user-private data beyond the public collection snapshot.
  if (
    pathname === "/api/collection-snapshot" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/teams — league reference data, served to anon visitors and the
  // CDN-cached server-component fetch from /profile/[username].
  if (pathname === "/api/teams") return true
  // /api/leaderboard/teams — public favorite-team fan counts; same caller
  // shape as /api/teams (anon + server-fetched).
  if (pathname === "/api/leaderboard/teams") return true
  // /api/profile/teams — GET reads any user's selected favorite teams
  // (public, by ownerKey); POST mutates user_favorite_teams for the signed-
  // in caller and MUST stay auth-gated. HEAD is included because it's a
  // semantic GET without body (curl -I, CDN warmers).
  if (
    pathname === "/api/profile/teams" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/profile/trophy-slabs — GET ?username=<u> is the public read backed
  // by the SECDEF get_trophy_slab_data_by_username RPC granted to anon;
  // GET ?mine=1 is owner-scoped and self-gates inside the handler (401 on
  // no session). The route only exports GET so an exact-path allowlist is
  // sufficient. Without this entry, anon visitors to /profile/<u> see a
  // perpetual loading skeleton because the trophy-slab fetch 307→/login.
  if (pathname === "/api/profile/trophy-slabs") return true
  // /api/profile/trophy-case/pdf — GET ?username=<u> exports the SAME public
  // trophy-case data as /api/profile/trophy-slabs (same anon-granted SECDEF
  // RPC) as a branded downloadable PDF. GET/HEAD-only read; nothing beyond
  // what /profile/<u> already shows anonymously. (2026-07-07)
  if (
    pathname === "/api/profile/trophy-case/pdf" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/profile/portfolio-history — GET reads portfolio_snapshots by
  // ownerKey OR derives daily FMV totals from fmv_snapshots by wallet
  // (both anon-safe). POST upserts a daily snapshot and MUST stay
  // auth-gated. Same GET/HEAD-only carve-out as /api/profile/teams.
  if (
    pathname === "/api/profile/portfolio-history" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/profile/{collection-breakdown,top-movers,tier-breakdown} — GET reads
  // a target collector's PUBLIC holdings by ?ownerKey=<username> (resolved
  // through profile_bio, same as teams/portfolio-history). Holdings are public
  // on a collector showcase; without this carve-out anon visitors to
  // /profile/<u> get empty cards (the fetch 307→/login) and Top Movers reads
  // empty. All three are GET-only routes (no write handler). NOTE: cost-basis-
  // summary is intentionally NOT here — spend/P-L is private (owner-only,
  // stays auth-gated).
  if (
    (pathname === "/api/profile/collection-breakdown" ||
      pathname === "/api/profile/top-movers" ||
      pathname === "/api/profile/tier-breakdown") &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/profile/market-pulse — GET-only aggregate floor/index reader,
  // scoped by ?collectionId. Anon-safe; no write handler exists.
  if (pathname === "/api/profile/market-pulse") return true
  // /api/nba/fast-break/optimize — public Fast Break optimizer endpoint.
  // Backed by SECDEF optimize_fast_break_lineup RPC granted to anon, so
  // the route handler does not need a user session. Used by the public
  // /nba/fast-break page and the home-page widget. (Cache-Control:
  // public, max-age=900 lives on the route response.)
  if (pathname === "/api/nba/fast-break/optimize") return true

  // ── Public Fast Break optimizer surface ──────────────────────────────
  // /nba/fast-break is the public, SEO-targeted Fast Break lineup
  // optimizer. Anyone (signed-in or not) can reach it.
  if (pathname === "/nba/fast-break" || pathname.startsWith("/nba/fast-break/")) return true

  // ── Public insights surface ──────────────────────────────────────────
  // /insights/* is the no-auth-friction public intelligence surface
  // (squeeze board, rookie index, pack reality) launched per the
  // 2026-05-29 4-week launch plan. Anyone (signed-in or not) can reach
  // these pages — they are the wedge content driving Twitter / Reddit
  // distribution. Backing JSON lives under /api/public/insights/* which
  // is already covered by the /api/public/* bypass above.
  if (pathname === "/insights" || pathname.startsWith("/insights/")) return true

  // ── Public per-collection overview landing ───────────────────────────
  // /<collection>/overview is the per-collection landing the marketing home's
  // collection tiles (HomePageMarketing) and the (collections) 404 fallback
  // link to. It's a read-only summary surface: KPIs + top sales + top sniper
  // deals from /api/collection-stats (collection-level aggregate, no
  // user-private data) plus static About copy. The wallet-lookup CTA on it
  // pushes to the auth-gated /dashboard, so connecting a wallet still requires
  // sign-in — but anon visitors get a compelling per-collection landing
  // instead of bouncing to /login at the first click. GET/HEAD only; the
  // in-app feature pages (/collection, /sniper, /sets, /market, /packs,
  // /analytics) stay behind the funnel. (2026-05-31)
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/[^/]+\/overview$/.test(pathname)
  ) {
    return true
  }
  // /api/collection-stats — GET-only collection-level aggregate (edition
  // count, FMV confidence %, 24h volume, top sales, top sniper deals) backing
  // the public /<collection>/overview landing above. Service-role read, no
  // wallet/user data, no write handler. Without this the anon overview page
  // renders its graceful "couldn't load stats" error state.
  if (
    pathname === "/api/collection-stats" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/marketplace-status — GET-only collection-scoped marketplace health
  // (?collection=<slug>), 5-min CDN-cached, no user data. Backs the honest
  // informational banner on the public /<collection>/overview (e.g. "UFC
  // migrated to Aptos — trade is historical"). Without this, anon visitors get
  // a silent gap where that context should be. (2026-06-13)
  if (
    pathname === "/api/marketplace-status" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }
  // /api/insider-signals — the COLLECTION-SCOPED GET (?collection=<slug>) is
  // public market-intelligence (squeeze/volume/whale alerts via the SECDEF
  // get_insider_signals_top_n RPC, no user data) backing the overview's
  // InsiderSignalsPanel — the funnel's wedge content. The route itself still
  // requires a session on its legacy no-param pool read. (2026-06-13)
  if (
    pathname === "/api/insider-signals" &&
    (method === "GET" || method === "HEAD")
  ) {
    return true
  }

  // ── Public moment / edition detail pages ─────────────────────────────
  // /moment/<id> resolves flow_id | moment_uuid | edition_uuid through
  // the SECDEF get_moment_detail RPC. Linked from Trophy Slab QR codes,
  // Insider Signals cards, and (in Phase 2) Fast Break lineup rows.
  // Public so social-share links work without an account.
  if (pathname === "/moment" || pathname.startsWith("/moment/")) return true
  if (pathname === "/api/moment" || pathname.startsWith("/api/moment/")) return true
  // /pinnacle/moment/<id> — Pinnacle-specific per-edition detail page
  // (Pinnacle uses pinnacle_editions, separate from the shared editions
  // table the /moment route reads). Linked from /insights/pinnacle-
  // scarcity per-row drill-downs. Same public-share rationale.
  if (pathname.startsWith("/pinnacle/moment/")) return true

  // ── Public entity detail pages ───────────────────────────────────────
  // /<collection>/{edition,set,player,team,series,pack}/<slug> — the
  // read-only, indexable per-entity detail surfaces (Phase 1B–1F). They are
  // backed by the same service-role detail RPCs as /moment, carry no
  // user-private data, and app/sitemap.ts already advertises ~20.5K of these
  // URLs to crawlers — so they must be reachable anonymously or Googlebot
  // gets 302→/login (the SEO thesis these pages exist for). GET/HEAD only.
  // Singular segments only: this opens /…/set/<slug> but NOT the in-app
  // /…/sets, /…/packs, /…/market, /…/sniper feature pages (those stay behind
  // the funnel). Unknown collection segments fall through to notFound() in
  // the page, so no data leaks even on a bogus prefix. (2026-05-30)
  //
  // `moment` added 2026-07-25: /<collection>/moment/<id> is the shape a developer
  // or crawler guesses, but it was the one entity segment missing here, so every
  // such url 307'd anonymous traffic to /login (live: /nfl-all-day/moment/374,
  // /disney-pinnacle/moment/GEN-DPIN-SIMB-S0). The route is a pure resolver — it
  // only redirects to /moment/<id> or /<collection>/overview and renders nothing
  // — and both of its destinations are already public above, so this leaks no
  // data it wasn't already serving; it just stops the bounce.
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/[^/]+\/(?:edition|set|player|team|series|pack|moment)\//.test(pathname)
  ) {
    return true
  }
  // /api/entity/* — GET-only offset pagination backing the entity-detail
  // grids ("Load more" on set/player/series/team editions). Read-only,
  // service-role-backed RPCs (get_set_editions, get_team_top_editions, …);
  // no write handlers. Without this, anon "Load more" fetches 302→/login.
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/api/entity" || pathname.startsWith("/api/entity/"))
  ) {
    return true
  }
  // /api/search — the global catalog search backing the header search bar.
  // GET-only, read-only, service-role-backed (rpc_search_catalog), no write
  // handler. It indexes ONLY data that is already anonymously readable: the
  // collection tabs were un-gated 2026-07-17 and the player/set/team/edition
  // pages it links to are in the sitemap, so this adds no data exposure — it
  // makes already-public content findable. Gating it would leave anonymous
  // visitors a search box that 302s to /login on every keystroke.
  if ((method === "GET" || method === "HEAD") && pathname === "/api/search") {
    return true
  }
  // GET /api/profile/follows — the follow-state probe behind the Follow button
  // on the anon-readable /profile/<username> page.
  //
  // Without this the proxy 302s anon to /login and the button receives ~50KB of
  // login HTML at status 200 on every anonymous profile view. The button
  // survives it (r.json() throws and its catch falls back to the sign-in CTA),
  // so this is a waste-and-honesty fix rather than a broken-UI one: it lets the
  // route return the { authed: false } it was written to return.
  //
  // Safe because the route gates ITSELF, per form: the ?username= probe reveals
  // only whether the CURRENT viewer follows someone (anon → authed:false, no
  // data), and the listing form (no query param) still calls requireUser() and
  // 401s. isPublicPath sees no query string, so both forms bypass the proxy and
  // the route's own guard is what protects the listing. GET/HEAD only — the
  // POST/DELETE writers stay fully gated here.
  if ((method === "GET" || method === "HEAD") && pathname === "/api/profile/follows") {
    return true
  }

  // ── Public share cards ───────────────────────────────────────────────
  // /share/<wallet> — the wallet-keyed, read-only collection-snapshot card
  // (Total FMV hero + top moments). It's the public landing the marketing
  // home routes anon wallet-paste to, and the target of shared links — both
  // break if anon gets 302→/login. Read-only, service-role-backed via
  // /api/collection-snapshot; same share rationale as /profile/<u> and
  // /moment. GET/HEAD only (the page is a server component, no mutations).
  // (robots.txt still disallows /share/ so Google doesn't index per-wallet
  // cards — that's an indexing decision, independent of anon reachability.)
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/share" || pathname.startsWith("/share/"))
  ) {
    return true
  }

  // ── Public profile pages ─────────────────────────────────────────────
  // /profile/<username> — shareable read-only profile cards. /profile/edit
  // is the signed-in user's own bio editor and stays auth-gated. The
  // dynamic route is hit by anonymous visitors clicking a shared link, so
  // sending them to /login defeats the share flow.
  // ⚠ BARE `/profile` — EXACT MATCH, added 2026-08-29 (register R36). The
  // prefix test below does NOT cover it (`"/profile".startsWith("/profile/")`
  // is false), so this path fell through to the gate and 302'd to /login. It is
  // now served by `app/profile/page.tsx`, a SERVER component that redirects a
  // signed-in visitor to /dashboard and renders a public, no-account wallet
  // lookup for everyone else.
  // ⛔ THIS WIDENS THE PUBLIC SURFACE BY EXACTLY ONE PATH STRING and by design
  // cannot widen it further: it is `===`, not a prefix, so it cannot reach
  // `/profile/edit`, `/dashboard`, or anything else. The page itself renders
  // NOTHING user-specific on the anonymous branch — that is what makes the
  // un-gate safe, and `__tests__/proxy-profile-entry-is-public-but-nothing-else.test.ts`
  // pins both halves so a later prefix "tidy-up" cannot quietly open /profile/edit.
  if (pathname === "/profile") return true

  if (
    pathname.startsWith("/profile/") &&
    pathname !== "/profile/edit" &&
    !pathname.startsWith("/profile/edit/")
  ) {
    return true
  }

  // ── Public feature-tab surfaces (un-gate 2026-07-17, soft launch) ─────
  // Open the read-only feature tabs + their service-role-backed read APIs to
  // anonymous visitors. This walls PERSONALIZATION, not CONTENT: cost-basis /
  // P&L, saved wallets, watchlist, portfolio export, wallet-cache WRITES, and
  // every mutation API stay behind sign-in (they are NOT enumerated here, so the
  // fail-closed allow-by-explicit-list model keeps gating them). Scoped to the 5
  // PUBLISHED Flow collection slugs only — Panini/Candy tabs stay gated (no
  // multi-chain pre-launch). GET/HEAD only for the pages; the in-app writes and
  // /dashboard/* personalization surfaces remain behind the funnel.
  // Anon-safety of every read API below was audited 2026-07-17: all are
  // service-role-backed reads over PUBLIC market / on-chain-holdings data (the
  // same holdings already exposed anonymously via /share + /profile +
  // /api/collection-snapshot), with no session-scoped or private-cost data.
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/(?:nba-top-shot|nfl-all-day|laliga-golazos|disney-pinnacle|ufc)\/(?:collection|market|sniper|sets|packs|pack-sniper|challenges|hot-floors|play|analytics)$/.test(pathname)
  ) {
    return true
  }
  // ⚠ ORDER IS LOAD-BEARING: this block must stay BELOW the feature-tab regex
  // above. __tests__/public-wallet-surface-contract.test.ts extracts "the public
  // collection-page regex" by matching the FIRST /^\/(?:nba-top-shot|… literal in
  // this file, and both regexes open with those five slugs — put this one first
  // and that test reads the roots as the tab list and fails on a missing tab.
  // The bare collection root (`/nba-top-shot`) is a server redirect to that
  // same `/overview` page (app/(collections)/[collection]/page.tsx does nothing
  // else) — but it was gated here, so the redirect never ran for an anonymous
  // visitor: every entity page's breadcrumb ("Home › NBA Top Shot › …") and its
  // BreadcrumbList JSON-LD link the collection name to `/<collection>`, and the
  // 2026-09-04 sweep measured all five roots 307-ing to /login for the SEO
  // traffic those pages exist for. Published slugs only, GET/HEAD only — the
  // same set the feature tabs above open; Panini/Candy roots stay gated.
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/(?:nba-top-shot|nfl-all-day|laliga-golazos|disney-pinnacle|ufc)$/.test(pathname)
  ) {
    return true
  }
  // GET/HEAD read APIs backing those tabs. wallet-cache is GET-only here (its
  // POST calls upsert_wmc_batch — a write — and stays gated).
  //
  // 2026-07-26: /api/pinnacle-wallet was MISSING from this set while
  // /disney-pinnacle/collection sat in the public PAGE regex above — so an
  // anonymous visitor could load the wedge surface, paste a wallet, and get
  // bounced to /login by the only API the page calls. Its exact Top Shot
  // analogue (/api/collection-moments) was already public, and it is the same
  // anon-safety class the 2026-07-17 audit cleared: GET-only, service-role read
  // over public market + on-chain holdings data, nothing session-scoped. Same
  // conversion-leak shape as /overview pointing anonymous users at the
  // auth-gated /dashboard.
  const PUBLIC_READ_APIS = new Set([
    "/api/market", "/api/sniper-feed", "/api/packs", "/api/edition-stats",
    "/api/sets", "/api/sets-db", "/api/recent-sales", "/api/collection-moments",
    "/api/collection-series", "/api/badges", "/api/relative-deals",
    "/api/tier-pricing-benchmarks", "/api/edition-history", "/api/market-analytics",
    "/api/marketplace-breakdown", "/api/pinnacle-sniper", "/api/pinnacle-wallet",
    // 2026-09-04: the two remaining anon-307s on anon-public pages, found by loading each
    // collection's /sniper and /packs signed-out in a real browser.
    //
    // `/api/pinnacle-sniper-feed` is LITERALLY `export { GET } from "../pinnacle-sniper/route"` —
    // the same handler, one line above on this list, gated only under its alias name. Anonymous
    // /disney-pinnacle/sniper (anon-public by the feature-tab regex below) called it, got 307 →
    // /login, and rendered "FMV coverage unavailable — discount and FMV show once the feed loads"
    // permanently. Not a degraded read: a page waiting for a response that can never arrive.
    //
    // `/api/pack-listings` is GET-only, takes no session (no getCurrentUser/cookies), validates
    // `collection` against SUPPORTED_PACK_COLLECTIONS, and returns 2-minute-cached PUBLIC Dapper
    // marketplace pack listings — the same anon-safety class as /api/sniper-feed and /api/market
    // already here. /nba-top-shot/packs and /nfl-all-day/packs still render 500 rows without it
    // (the table is server-rendered), so this one costs a wasted login-HTML download and a console
    // error per anon load rather than a broken page — the same class as the badge-taxonomy and
    // profile/me fixes of 2026-09-03.
    //
    // ⚠ NOT added: `/api/golazos-sniper-feed` and `/api/allday-pack-listings`. Both also 307, and
    // both were left alone because no anon-public page calls them — /laliga-golazos/sniper fires
    // ZERO 307s and renders 54 rows, verified live. Widening the allowlist for a route with no
    // caller is how the surface grows without anyone deciding to grow it.
    "/api/pinnacle-sniper-feed", "/api/pack-listings",
    "/api/allday-set-progress",
    "/api/ufc-set-progress", "/api/topshot/challenge-plan", "/api/topshot/challenges",
    "/api/wallet-summary", "/api/seeded-wallets", "/api/owned-flow-ids",
    "/api/wallet/edition-counts", "/api/wallet-cache", "/api/ready",
    // 2026-09-04: the route itself answers `{ user: null }` for anon by design
    // ("never 401s — so public pages can call this unconditionally"), but the
    // proxy 307'd it to /login first, so every anonymous insights/profile/home
    // load downloaded the login HTML once and `.json()` threw. Session-derived
    // data only ever leaves for a signed-in caller (getCurrentUser gates it).
    "/api/profile/me",
  ])
  if ((method === "GET" || method === "HEAD") && PUBLIC_READ_APIS.has(pathname)) {
    return true
  }
  // Analytics read routes (/api/analytics + its subtree) — all GET-only
  // ecosystem aggregates (sales / fmv / packs / sets / pulse / loans / wallet-
  // scoped by address param), no private or session-derived data (audited).
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/api/analytics" || pathname.startsWith("/api/analytics/"))
  ) {
    return true
  }
  // Batch read-compute endpoints that use POST purely to carry a request body
  // (stateless reads — FMV lookup, best-offers, edition-floor, pack-EV compute).
  // No user data; the 60/min/IP limiter still applies to anon.
  //
  // ⚠ This comment used to assert "No writes" outright, and that was FALSE for
  // /api/edition-floor: its caller-controlled `?persist=1` / `{persist:true}`
  // ran a SERVICE_ROLE delete-then-insert over today's `fmv_snapshots` rows for
  // up to 50 editions, reachable with no auth at all (deep-audit R2). The flag
  // now requires the operator bearer secret; the read path is genuinely
  // read-only. Opening a route here does NOT make its handler read-only —
  // verify every write path in the handler before adding a path to this list,
  // because a confident safety comment is what kept this one from being read.
  //
  // 2026-09-04: /api/badge-taxonomy joins the list — a POST that only carries a
  // `titles[]` body to a service-role read of the static badge taxonomy (module-
  // cached, no user data, no write path). Anonymous collection/sniper/profile
  // pages call it for every badge chip; before this line each call was
  // 307 → POST /login → 405 (7 console errors per anon sniper load, measured),
  // and the badge art/tooltips never arrived for signed-out visitors.
  if (
    (pathname === "/api/fmv" ||
      pathname === "/api/best-offers" ||
      pathname === "/api/edition-floor" ||
      pathname === "/api/pack-ev" ||
      pathname === "/api/badge-taxonomy") &&
    (method === "GET" || method === "HEAD" || method === "POST")
  ) {
    return true
  }

  // ── Framework + static ───────────────────────────────────────────────
  if (pathname === "/_next" || pathname.startsWith("/_next/")) return true
  if (STATIC_ROOT_ASSETS.has(pathname)) return true
  if (FONT_ASSET_RX.test(pathname)) return true

  return false
}

// ── Security headers applied to every response ──────────────────────────────
function applySecurityHeaders(response: NextResponse) {
  response.headers.set("X-Frame-Options", "DENY")
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  )
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  )
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://assets.nbatopshot.com https://asset-preview.nbatopshot.com https://assets.nflallday.com https://asset-preview.nflallday.com https://media.nflallday.com https://assets.laligagolazos.com https://asset-preview.laligagolazos.com https://assets.disneypinnacle.com https://asset-preview.disneypinnacle.com https://asset-preview.ufcstrike.com https://ipfs.dapperlabs.com https://gateway.pinata.cloud https://ipfs.io https://storage.googleapis.com https://cdn.nba.com https://cdn.wnba.com https://*.supabase.co https://arweave.net https://*.arweave.net",
      "media-src 'self' data: blob: https://assets.nbatopshot.com https://asset-preview.nbatopshot.com https://assets.nflallday.com https://asset-preview.nflallday.com https://media.nflallday.com https://assets.laligagolazos.com https://asset-preview.laligagolazos.com https://assets.disneypinnacle.com https://asset-preview.disneypinnacle.com https://asset-preview.ufcstrike.com https://ipfs.dapperlabs.com https://gateway.pinata.cloud https://ipfs.io https://storage.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co https://public-api.nbatopshot.com https://public-api.nflallday.com https://public-api.laligagolazos.com https://api2.flowty.io https://rest-mainnet.onflow.org https://access-mainnet.onflow.org https://pinnacle-proxy.tdillonbond.workers.dev https://topshot-proxy.tdillonbond.workers.dev https://*.ingest.us.sentry.io https://*.sentry.io wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  )
  return response
}

// ── Supabase SSR client (anon key, reads/refreshes auth cookies) ────────────
function makeSupabase(req: NextRequest, res: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll().map((c) => ({ name: c.name, value: c.value }))
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set({ name, value, ...options })
          })
        },
      },
    }
  )
}

// ── Service-role client used solely for the allow-list RPC ─────────────────
// `check_email_allowed` is restricted to service-role and cannot be called
// from the user-scoped anon SSR client.
function makeAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

type AllowCacheEntry = { email: string; expiresAt: number }

function readAllowCookie(request: NextRequest): AllowCacheEntry | null {
  const raw = request.cookies.get(ALLOWLIST_COOKIE)?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<AllowCacheEntry>
    if (typeof parsed.email !== "string") return null
    if (typeof parsed.expiresAt !== "number") return null
    return { email: parsed.email, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function writeAllowCookie(response: NextResponse, email: string) {
  const expiresAt = Date.now() + ALLOWLIST_TTL_SECONDS * 1000
  response.cookies.set({
    name: ALLOWLIST_COOKIE,
    value: JSON.stringify({ email, expiresAt }),
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: ALLOWLIST_TTL_SECONDS,
  })
}

function clearAllowCookie(response: NextResponse) {
  response.cookies.set({
    name: ALLOWLIST_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  })
}

// Carry any cookies queued on `source` over onto `target` so signOut /
// auth-refresh writes survive a redirect.
function carryCookies(target: NextResponse, source: NextResponse) {
  source.cookies.getAll().forEach((c) => {
    target.cookies.set({
      name: c.name,
      value: c.value,
      ...(c.path !== undefined ? { path: c.path } : {}),
      ...(c.domain !== undefined ? { domain: c.domain } : {}),
      ...(c.maxAge !== undefined ? { maxAge: c.maxAge } : {}),
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
      ...(c.secure !== undefined ? { secure: c.secure } : {}),
      ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
    })
  })
}

// CORS-on-success header writer (factored so the bypass and the gated-pass
// paths share identical handling).
function applyCorsHeaders(request: NextRequest, response: NextResponse, isCorsApiRoute: boolean) {
  if (!isCorsApiRoute) return
  const origin = request.headers.get("origin") || ""
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || !origin
  if (isAllowed && origin) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Vary", "Origin")
  }
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // ── A backslash in the path is never a page ──────────────────────────────
  // Bots request things like `/api/og/insights%5C`; the URL-encoded backslash
  // decodes to a path segment no route can own and reached the pages router as
  // a 500 "Cannot find module" (4 hits in the 2026-09-03 health pass). A 404
  // here costs nothing and keeps the error groups honest. Checked on the raw
  // URL as well as the decoded pathname so neither encoding slips through.
  if (pathname.includes("\\") || /%5c/i.test(request.url)) {
    return new NextResponse(null, { status: 404 })
  }

  // Periodic in-memory rate-limit map cleanup.
  if (Date.now() - lastCleanup > 300_000) {
    cleanupRateLimitMap()
    lastCleanup = Date.now()
  }

  const isCorsApiRoute = CORS_API_PATHS.some((p) => pathname.startsWith(p))

  // ── CORS preflight handling for public API paths ────────────────────────
  if (isCorsApiRoute && request.method === "OPTIONS") {
    const origin = request.headers.get("origin") || ""
    const isAllowed = ALLOWED_ORIGINS.includes(origin) || !origin
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": isAllowed ? origin || "*" : "",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    })
  }

  // ── Bypass-token short-circuit (header OR query param) ──────────────────
  // Cron-job.org and internal pipeline jobs hit /api/seed-wallet-refresh,
  // /api/ingest, /api/listing-cache*, /api/sales-indexer*, /api/fmv-recalc,
  // /api/flowty-tx-scanner, etc. with INGEST_SECRET_TOKEN (or CRON_SECRET for
  // generic crons). Production cron config is mixed: some send the secret as
  // an Authorization: Bearer header, others as a ?token=… query param.
  // Without this short-circuit the auth gate redirects every cron call to
  // /login and the data pipeline silently dies within ~30 min. Runs BEFORE
  // rate limiting, public-path check, and any session lookup. Neither input
  // is consumed or stripped — downstream route handlers still see and
  // re-validate them for defense-in-depth.
  if (hasValidBypassToken(request)) {
    const passResponse = NextResponse.next()
    applyCorsHeaders(request, passResponse, isCorsApiRoute)
    return applySecurityHeaders(passResponse)
  }

  // ── Rate limiting for /api/ routes ──────────────────────────────────────
  // Existing behaviour preserved. Bot/cron requests carrying valid tokens
  // already returned above, so this only constrains anonymous + user traffic.
  if (pathname.startsWith("/api/")) {
    const authHeader = request.headers.get("authorization") || ""
    const isBotRequest = authHeader === `Bearer ${process.env.INGEST_SECRET_TOKEN}`
    if (
      !isBotRequest &&
      !pathname.startsWith("/api/cron") &&
      !pathname.startsWith("/api/ingest")
    ) {
      const clientKey = getRateLimitKey(request)
      const { max, bucket } = apiRateLimitFor(pathname, hasAuthCookie(request))
      if (isRateLimited(clientKey, bucket === "media" ? mediaRateLimitMap : rateLimitMap, max)) {
        return NextResponse.json(
          { error: `Rate limit exceeded. Max ${max} requests per minute.` },
          { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }
        )
      }
    }
  } else if (
    // ── Rate limiting for expensive PAGE routes (2026-08-07) ──────────────
    // The limiter above was /api/-only, so every server-rendered, DB-backed
    // page route was unmetered. Measured 2026-08-06: ~78k page requests /12h
    // from the post-2026-08-01 AI-crawler unblock, none of it rate limited,
    // against a Micro instance — the proximate cause of the pooler exhaustion,
    // the 504s on the cron layer, and the statement-timeout 500s on pack pages.
    //
    // Scope is deliberately narrow:
    //   • GET/HEAD only — never meter a mutation.
    //   • Anonymous only — a signed-in reader is never throttled.
    //   • Enumerated DB-backed surfaces only — /, /login, /pricing etc. are
    //     cheap or static and stay unmetered.
    // Bot/cron traffic with a valid token already short-circuited above.
    //
    // ⚠ Do NOT "fix" crawler load by re-adding a blanket AI-crawler block to
    // app/robots.ts. That block was removed 2026-08-01 as a deliberate traffic
    // decision (Trevor); re-adding it is a traffic call, not cleanup.
    (request.method === "GET" || request.method === "HEAD") &&
    isRateLimitedPageRoute(pathname) &&
    !hasAuthCookie(request)
  ) {
    const clientKey = getRateLimitKey(request)
    if (isRateLimited(clientKey, pageRateLimitMap, PAGE_RATE_LIMIT_MAX_REQUESTS)) {
      // Plain-text, explicitly uncacheable: a 429 must never be stored by the
      // CDN and replayed to the next visitor as if it were the page.
      return new NextResponse("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60", "Cache-Control": "no-store" },
      })
    }
  }

  // ── Public-bypass paths skip auth + allow-list ──────────────────────────
  if (isPublicPath(pathname, request.method)) {
    const passResponse = NextResponse.next()
    applyCorsHeaders(request, passResponse, isCorsApiRoute)
    return applySecurityHeaders(passResponse)
  }

  // ── Site-wide auth gate ─────────────────────────────────────────────────
  const response = NextResponse.next()
  const supabase = makeSupabase(request, response)
  const { data: userData } = await supabase.auth.getUser()
  const user = userData?.user

  if (!user) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("next", pathname + search)
    const redirectResp = NextResponse.redirect(loginUrl)
    carryCookies(redirectResp, response)
    return applySecurityHeaders(redirectResp)
  }

  const userEmail = (user.email || "").toLowerCase()

  // ── Allow-list: cache check first, then RPC fallback ────────────────────
  const cached = readAllowCookie(request)
  const cacheValid =
    !!cached &&
    cached.email.toLowerCase() === userEmail &&
    cached.expiresAt > Date.now()

  if (!cacheValid) {
    const admin = makeAdminClient()
    const { data: allowedRaw, error: rpcError } = await admin.rpc("check_email_allowed", {
      p_email: userEmail,
    })

    if (rpcError) {
      // Fail-closed — RPC unavailable shouldn't grant access. Bounce to
      // /login with a distinct error so the page can show "service
      // temporarily down" instead of "your access was revoked".
      console.error("[proxy] check_email_allowed error", rpcError)
      const loginUrl = new URL("/login", request.url)
      loginUrl.searchParams.set("error", "allowlist_unavailable")
      const redirectResp = NextResponse.redirect(loginUrl)
      carryCookies(redirectResp, response)
      clearAllowCookie(redirectResp)
      return applySecurityHeaders(redirectResp)
    }

    if (allowedRaw !== true) {
      // Revoked or never approved — sign them out server-side, clear the
      // cached allow-list cookie, and bounce to /login?error=access_revoked.
      try {
        await supabase.auth.signOut()
      } catch {
        // Ignore — we're redirecting either way; the auth cookies will be
        // cleared at next sign-in even if this fails here.
      }
      const loginUrl = new URL("/login", request.url)
      loginUrl.searchParams.set("error", "access_revoked")
      const redirectResp = NextResponse.redirect(loginUrl)
      carryCookies(redirectResp, response)
      clearAllowCookie(redirectResp)
      return applySecurityHeaders(redirectResp)
    }

    writeAllowCookie(response, userEmail)
  }

  applyCorsHeaders(request, response, isCorsApiRoute)
  return applySecurityHeaders(response)
}

// Permissive matcher — the in-function `isPublicPath` check carries the
// authoritative bypass logic. The matcher below excludes the highest-volume
// static prefixes purely as a perf optimization so the function isn't even
// invoked for them.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|img/).*)"],
}
