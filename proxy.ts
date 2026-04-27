import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

const ALLOWED_ORIGINS = [
  "https://rip-packs-city.vercel.app",
  "https://rippackscity.com",
  "https://www.rippackscity.com",
  "http://localhost:3000",
];

const CORS_API_PATHS = ["/api/fmv", "/api/sniper-feed", "/api/health"];

// Collection-prefixed pages were previously auth-gated. Now they're public:
// every browse/market/analytics/sniper/badges/sets/packs/overview/collection
// page renders with full SSR data for anonymous traffic so search crawlers
// (and humans without an account) can index + use them. Personalization
// features inside those pages stay client-gated (e.g. Save-to-Watchlist,
// Set-Alert, Buy buttons render "Sign in to save" CTAs when auth.uid() is
// null). Profile editor, trophy management, and per-user write APIs remain
// gated below via the requiresAuth check.

// ── Rate limiting (in-memory, per-IP) ────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

function getRateLimitKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}

let lastCleanup = Date.now();

// ── Security headers applied to every response ──────────────────────────────
function applySecurityHeaders(response: NextResponse) {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://assets.nbatopshot.com https://assets.nflallday.com https://media.nflallday.com https://assets.laligagolazos.com https://assets.disneypinnacle.com https://ipfs.io https://cloudflare-ipfs.com https://storage.googleapis.com https://*.supabase.co",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co https://public-api.nbatopshot.com https://public-api.nflallday.com https://public-api.laligagolazos.com https://api2.flowty.io https://rest-mainnet.onflow.org https://access-mainnet.onflow.org https://pinnacle-proxy.tdillonbond.workers.dev https://topshot-proxy.tdillonbond.workers.dev wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  return response;
}

// ── Route gating — does this path require a signed-in user? ──────────────────
// Gate:
//   • /profile (exact, the dashboard — /profile/[username] is the public profile page)
//   • /profile/edit (the bio editor that POSTs to /api/profile/bio)
// Everything else — collection browse/market/analytics/sniper/etc., public
// profiles, share pages, API routes, _next, the auth callback — is open.
// Auth-only API handlers call requireUser() themselves so latency stays off
// the public API hot paths.
function requiresAuth(pathname: string): boolean {
  if (pathname === "/profile" || pathname === "/profile/") return true;
  if (pathname === "/profile/edit" || pathname === "/profile/edit/") return true;
  return false;
}

// ── Supabase SSR client factory (used only on gated paths) ──────────────────
function makeSupabase(req: NextRequest, res: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll().map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set({ name, value, ...options });
          });
        },
      },
    }
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Periodic cleanup
  if (Date.now() - lastCleanup > 300_000) {
    cleanupRateLimitMap();
    lastCleanup = Date.now();
  }

  // ── CORS handling for public API paths ──────────────────────────────────
  const isCorsApiRoute = CORS_API_PATHS.some((p) => pathname.startsWith(p));

  if (isCorsApiRoute) {
    const origin = request.headers.get("origin") || "";
    const isAllowed = ALLOWED_ORIGINS.includes(origin) || !origin;

    if (request.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": isAllowed ? origin || "*" : "",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
  }

  // ── Rate limiting for all /api/ routes ──────────────────────────────────
  if (pathname.startsWith("/api/")) {
    // Skip rate limiting for authenticated bot/pipeline requests
    const authHeader = request.headers.get("authorization") || "";
    const isBotRequest = authHeader === `Bearer ${process.env.INGEST_SECRET_TOKEN}`;

    if (
      !isBotRequest &&
      !pathname.startsWith("/api/cron") &&
      !pathname.startsWith("/api/ingest")
    ) {
      const clientKey = getRateLimitKey(request);
      if (isRateLimited(clientKey)) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Max 30 requests per minute." },
          {
            status: 429,
            headers: { "Retry-After": "60" },
          }
        );
      }
    }
  }

  // ── Build response with security headers ────────────────────────────────
  const response = NextResponse.next();

  // CORS headers for public API paths
  if (isCorsApiRoute) {
    const origin = request.headers.get("origin") || "";
    const isAllowed = ALLOWED_ORIGINS.includes(origin) || !origin;
    if (isAllowed && origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
    }
  }

  // ── Auth gate for collection tools + /profile editor ─────────────────────
  if (requiresAuth(pathname)) {
    const supabase = makeSupabase(request, response);
    const { data } = await supabase.auth.getUser();

    if (!data?.user) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname + search);
      return applySecurityHeaders(NextResponse.redirect(loginUrl));
    }
  }

  applySecurityHeaders(response);

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|img/).*)"],
};
