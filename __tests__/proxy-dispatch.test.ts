import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// proxy.ts — the async proxy() dispatch chain, driven end-to-end.
//
// The sibling suites pin the two PURE decision functions:
//   · proxy-is-public-path.test.ts  → isPublicPath(pathname, method)
//   · proxy-page-rate-limit.test.ts → isRateLimitedPageRoute + hasAuthCookie
//
// But the request-handling flow that CONSUMES those decisions — the actual
// security wall Next.js runs on every request — was itself undriven:
//   1. CORS preflight (OPTIONS) on the public-CORS API paths,
//   2. the INGEST_SECRET_TOKEN / CRON_SECRET bypass (header AND ?token= forms),
//   3. the per-IP 429 rate limiters (API + expensive-page),
//   4. the public-path passthrough (must NOT touch Supabase),
//   5. the unauthenticated → /login?next= redirect,
//   6. the allow-list ladder: cookie-cache hit, RPC-error fail-CLOSED,
//      revoked → signOut + /login?error=access_revoked, allowed → cookie write.
//
// Every ledger allow-list incident (fail-open on RPC error, a revoked user
// keeping access via a stale cookie, one user's cookie honored under another
// session) is a wrong answer from THIS function, not from isPublicPath. This
// file is the runtime contract for the gate; a diff that flips any assertion
// here is a visible, reviewable security change.
//
// The Supabase SSR + service-role clients are mocked (createServerClient /
// createClient) so getUser / check_email_allowed / signOut are driven from
// hoisted state — the same seam api-auth-callback.test.ts uses.
// ─────────────────────────────────────────────────────────────────────────────

const st = vi.hoisted(() => ({
  user: null as { email?: string } | null,
  rpc: { data: null as unknown, error: null as unknown },
  signOutCalls: 0,
  signOutThrows: false,
}))

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: st.user }, error: null }),
      signOut: async () => {
        st.signOutCalls++
        if (st.signOutThrows) throw new Error("signout boom")
        return { error: null }
      },
    },
  }),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (_fn: string, _args: unknown) => st.rpc,
  }),
}))

import { proxy } from "@/proxy"

// A distinct source IP per case keeps the module-scope rate-limit Maps from
// bleeding one test's request count into the next.
let ipCounter = 0
function req(
  path: string,
  {
    method = "GET",
    headers = {},
    cookies = {},
    ip,
  }: {
    method?: string
    headers?: Record<string, string>
    cookies?: Record<string, string>
    ip?: string
  } = {}
): NextRequest {
  const h: Record<string, string> = {
    "x-forwarded-for": ip ?? `10.0.0.${++ipCounter}`,
    ...headers,
  }
  const cookiePairs = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
  if (cookiePairs) h["cookie"] = cookiePairs
  return new NextRequest("https://www.rippackscity.com" + path, {
    method,
    headers: h,
  })
}

beforeEach(() => {
  st.user = null
  st.rpc = { data: null, error: null }
  st.signOutCalls = 0
  st.signOutThrows = false
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.CRON_SECRET = "cron-secret"
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("proxy() — security headers", () => {
  it("stamps the hardening headers on a public-path passthrough", async () => {
    const res = await proxy(req("/"))
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=63072000")
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
  })
})

describe("proxy() — CORS preflight", () => {
  it("answers OPTIONS on a public-CORS API path with 204 + echoed allowed origin", async () => {
    const res = await proxy(
      req("/api/fmv", {
        method: "OPTIONS",
        headers: { origin: "https://www.rippackscity.com" },
      })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.rippackscity.com")
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
  })

  it("does not echo a disallowed origin on preflight", async () => {
    const res = await proxy(
      req("/api/health", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("")
  })
})

describe("proxy() — bypass token short-circuit", () => {
  it("passes through on a matching Authorization: Bearer INGEST_SECRET_TOKEN without touching Supabase", async () => {
    st.user = null // even with no session, the bypass wins
    const res = await proxy(
      req("/api/ingest", { headers: { authorization: "Bearer ingest-secret" } })
    )
    // Passthrough (NextResponse.next) → no redirect; security headers present.
    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("passes through on a matching ?token= CRON_SECRET query param", async () => {
    const res = await proxy(req("/api/fmv-recalc?token=cron-secret", { method: "POST" }))
    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("does NOT bypass on a wrong token — a gated path still redirects to /login", async () => {
    st.user = null
    const res = await proxy(
      req("/dashboard", { headers: { authorization: "Bearer wrong" } })
    )
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })
})

describe("proxy() — rate limiting", () => {
  it("returns 429 once an anon IP exceeds the /api/ burst cap", async () => {
    const ip = "203.0.113.9"
    let last: Response | null = null
    // 60 is the cap; the 61st must trip.
    for (let i = 0; i < 61; i++) {
      last = await proxy(req("/api/market", { ip }))
    }
    expect(last!.status).toBe(429)
    const body = await last!.json()
    expect(body.error).toContain("Rate limit")
    expect(last!.headers.get("Retry-After")).toBe("60")
  })

  it("does NOT rate-limit /api/cron or /api/ingest (bot lanes)", async () => {
    const ip = "203.0.113.10"
    let last: Response | null = null
    for (let i = 0; i < 65; i++) {
      last = await proxy(req("/api/cron/anything?token=cron-secret", { ip }))
    }
    // bypass-token path returns passthrough, never 429
    expect(last!.status).not.toBe(429)
  })

  it("returns 429 once an anon IP exceeds the expensive-PAGE cap", async () => {
    const ip = "203.0.113.11"
    let last: Response | null = null
    // page cap is 120; the 121st trips.
    for (let i = 0; i < 121; i++) {
      last = await proxy(req("/nba-top-shot/edition/257:8867", { ip }))
    }
    expect(last!.status).toBe(429)
    expect(last!.headers.get("Cache-Control")).toBe("no-store")
  })

  it("does NOT meter a page request that carries an auth cookie", async () => {
    const ip = "203.0.113.12"
    st.user = { email: "member@x.com" }
    st.rpc = { data: true, error: null }
    let last: Response | null = null
    for (let i = 0; i < 130; i++) {
      last = await proxy(
        req("/nba-top-shot/collection", {
          ip,
          cookies: { "sb-proj-auth-token": "tok" },
        })
      )
    }
    // /collection is a public page, so it never reaches the auth gate; the point
    // is only that the signed-in-cookie exemption keeps it off the 429 path.
    expect(last!.status).not.toBe(429)
  })
})

describe("proxy() — unauthenticated gate", () => {
  it("redirects a gated path to /login?next=<path+search> when there is no session", async () => {
    st.user = null
    const res = await proxy(req("/dashboard/watchlist?tab=fmv"))
    expect(res.status).toBe(307)
    const loc = res.headers.get("location") ?? ""
    expect(loc).toContain("/login")
    expect(loc).toContain("next=")
    expect(decodeURIComponent(loc)).toContain("/dashboard/watchlist?tab=fmv")
  })
})

describe("proxy() — an anonymous fetch() to a gated API path gets 401, a navigation still gets the redirect (2026-09-06)", () => {
  it("answers 401 JSON to a signed-out fetch (sec-fetch-dest: empty) on /api/*", async () => {
    st.user = null
    const res = await proxy(req("/api/profile/saved-wallets?ownerKey=0xabc", { headers: { "sec-fetch-dest": "empty" } }))
    expect(res.status).toBe(401)
    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(await res.json()).toMatchObject({ error: "unauthorized" })
  })

  it("a signed-out NAVIGATION to a gated API path keeps the /login?next= redirect", async () => {
    st.user = null
    const res = await proxy(req("/api/profile/saved-wallets?ownerKey=0xabc", { headers: { "sec-fetch-dest": "document" } }))
    expect(res.status).toBe(307)
    expect(res.headers.get("location") ?? "").toContain("/login")
  })

  it("a signed-out fetch to a gated PAGE (not /api) keeps the redirect — pages are for navigations", async () => {
    st.user = null
    const res = await proxy(req("/dashboard/watchlist", { headers: { "sec-fetch-dest": "empty" } }))
    expect(res.status).toBe(307)
  })

  it("a fetch WITHOUT the header (old client) keeps the redirect", async () => {
    st.user = null
    const res = await proxy(req("/api/profile/saved-wallets?ownerKey=0xabc"))
    expect(res.status).toBe(307)
  })
})

describe("proxy() — allow-list ladder", () => {
  it("fails CLOSED on an RPC error → /login?error=allowlist_unavailable", async () => {
    st.user = { email: "member@x.com" }
    st.rpc = { data: null, error: { message: "db down" } }
    const res = await proxy(req("/dashboard"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("error=allowlist_unavailable")
  })

  it("signs out + redirects access_revoked when the RPC returns not-allowed", async () => {
    st.user = { email: "revoked@x.com" }
    st.rpc = { data: false, error: null }
    const res = await proxy(req("/dashboard"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("error=access_revoked")
    expect(st.signOutCalls).toBe(1)
  })

  it("still redirects access_revoked even if signOut throws (best-effort)", async () => {
    st.user = { email: "revoked@x.com" }
    st.rpc = { data: false, error: null }
    st.signOutThrows = true
    const res = await proxy(req("/dashboard"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("error=access_revoked")
  })

  it("passes an allowed user through and writes the rpc_al_check cache cookie", async () => {
    st.user = { email: "member@x.com" }
    st.rpc = { data: true, error: null }
    const res = await proxy(req("/dashboard"))
    expect(res.headers.get("location")).toBeNull()
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("rpc_al_check=")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("honors a valid cache cookie WITHOUT calling the RPC", async () => {
    st.user = { email: "member@x.com" }
    // If the RPC were consulted it would revoke; a passthrough proves the
    // cookie short-circuited it.
    st.rpc = { data: false, error: null }
    const cookieVal = encodeURIComponent(
      JSON.stringify({ email: "member@x.com", expiresAt: Date.now() + 30_000 })
    )
    const res = await proxy(
      req("/dashboard", { cookies: { rpc_al_check: cookieVal } })
    )
    expect(res.headers.get("location")).toBeNull()
    expect(st.signOutCalls).toBe(0)
  })

  it("ignores a cache cookie whose email does not match the session (falls to RPC)", async () => {
    st.user = { email: "real@x.com" }
    st.rpc = { data: false, error: null } // RPC will now revoke
    const cookieVal = encodeURIComponent(
      JSON.stringify({ email: "someone-else@x.com", expiresAt: Date.now() + 30_000 })
    )
    const res = await proxy(
      req("/dashboard", { cookies: { rpc_al_check: cookieVal } })
    )
    expect(res.headers.get("location")).toContain("error=access_revoked")
  })

  it("ignores an expired cache cookie (falls to RPC, which allows)", async () => {
    st.user = { email: "member@x.com" }
    st.rpc = { data: true, error: null }
    const cookieVal = encodeURIComponent(
      JSON.stringify({ email: "member@x.com", expiresAt: Date.now() - 1 })
    )
    const res = await proxy(
      req("/dashboard", { cookies: { rpc_al_check: cookieVal } })
    )
    expect(res.headers.get("location")).toBeNull()
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("rpc_al_check=")
  })

  it("ignores a malformed cache cookie (falls to RPC)", async () => {
    st.user = { email: "member@x.com" }
    st.rpc = { data: true, error: null }
    const res = await proxy(
      req("/dashboard", { cookies: { rpc_al_check: "not-json" } })
    )
    expect(res.headers.get("location")).toBeNull()
  })
})

describe("a backslash in the path is a 404 before anything else runs (2026-09-03)", () => {
  // Bots requested /api/og/insights%5C and the encoded backslash reached the
  // pages router as a 500 "Cannot find module" — four hits in one health pass.
  it("404s the URL-encoded form, on a public path, without touching auth or rate limits", async () => {
    const res = await proxy(req("/api/og/insights%5C"))
    expect(res.status).toBe(404)
  })

  it("404s a decoded backslash in the pathname too", async () => {
    const res = await proxy(req("/insights/pack-drops" + encodeURIComponent("\\") + "x"))
    expect(res.status).toBe(404)
  })

  it("NEGATIVE CONTROL: the same public path without the backslash passes through", async () => {
    const res = await proxy(req("/api/og/insights"))
    expect(res.status).not.toBe(404)
  })
})
