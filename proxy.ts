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

const ALLOWED_ORIGINS = [
  "https://rip-packs-city.vercel.app",
  "https://rippackscity.com",
  "https://www.rippackscity.com",
  "http://localhost:3000",
]

const CORS_API_PATHS = ["/api/fmv", "/api/sniper-feed", "/api/health"]

const ALLOWLIST_COOKIE = "rpc_al_check"
const ALLOWLIST_TTL_SECONDS = 60

// Static asset file extensions that bypass auth at the in-middleware level.
const STATIC_EXT_RX = /\.(?:png|jpe?g|svg|webp|ico|css|js)$/i

// ── Rate limiting (in-memory, per-IP) ────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60

function getRateLimitKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  )
}

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_MAX_REQUESTS
}

function cleanupRateLimitMap() {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key)
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
function isPublicPath(pathname: string, method: string): boolean {
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
  if (pathname === "/sitemap.xml") return true

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
  // /api/health — uptime/smoke probes hit this anonymously
  if (pathname === "/api/health") return true
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
  if (
    (method === "GET" || method === "HEAD") &&
    /^\/[^/]+\/(?:edition|set|player|team|series|pack)\//.test(pathname)
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
  if (
    pathname.startsWith("/profile/") &&
    pathname !== "/profile/edit" &&
    !pathname.startsWith("/profile/edit/")
  ) {
    return true
  }

  // ── Framework + static ───────────────────────────────────────────────
  if (pathname === "/_next" || pathname.startsWith("/_next/")) return true
  if (STATIC_EXT_RX.test(pathname)) return true

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
      "img-src 'self' data: blob: https://assets.nbatopshot.com https://asset-preview.nbatopshot.com https://assets.nflallday.com https://asset-preview.nflallday.com https://media.nflallday.com https://assets.laligagolazos.com https://asset-preview.laligagolazos.com https://assets.disneypinnacle.com https://asset-preview.disneypinnacle.com https://asset-preview.ufcstrike.com https://ipfs.io https://cloudflare-ipfs.com https://storage.googleapis.com https://*.supabase.co",
      "media-src 'self' data: blob: https://assets.nbatopshot.com https://asset-preview.nbatopshot.com https://assets.nflallday.com https://asset-preview.nflallday.com https://media.nflallday.com https://assets.laligagolazos.com https://asset-preview.laligagolazos.com https://assets.disneypinnacle.com https://asset-preview.disneypinnacle.com https://asset-preview.ufcstrike.com https://ipfs.io https://cloudflare-ipfs.com https://storage.googleapis.com",
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
      if (isRateLimited(clientKey)) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Max 60 requests per minute." },
          { status: 429, headers: { "Retry-After": "60" } }
        )
      }
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
