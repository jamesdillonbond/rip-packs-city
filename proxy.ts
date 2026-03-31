import { NextRequest, NextResponse } from "next/server";

const ALLOWED_ORIGINS = [
  "https://rip-packs-city.vercel.app",
  "https://rippackscity.com",
  "https://www.rippackscity.com",
  "http://localhost:3000",
];

const API_PATHS = ["/api/fmv", "/api/sniper-feed", "/api/health"];

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (Date.now() - lastCleanup > 300_000) {
    cleanupRateLimitMap();
    lastCleanup = Date.now();
  }

  const isApiRoute = API_PATHS.some((p) => pathname.startsWith(p));

  if (isApiRoute) {
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

    if (!pathname.startsWith("/api/cron") && !pathname.startsWith("/api/ingest")) {
      const clientKey = getRateLimitKey(request);
      if (isRateLimited(clientKey)) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Max 30 requests per minute." },
          {
            status: 429,
            headers: {
              "Retry-After": "60",
              "Access-Control-Allow-Origin": isAllowed ? origin : "",
            },
          }
        );
      }
    }

    const response = NextResponse.next();

    if (isAllowed && origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
    }

    return response;
  }

  const response = NextResponse.next();

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|img/).*)"],
};
