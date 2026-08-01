import { describe, it, expect, vi, afterEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// proxy.ts — the site-wide public/gated boundary, pinned as a table.
//
// `isPublicPath(pathname, method)` is the app's entire security wall: it decides,
// for every matched request, whether the request skips the Supabase session +
// allow-list gate (public) or must sign in (gated). It is ~395 lines of branching
// allowlist logic, it changes often (the un-gate soft launch, the Candy/Panini
// staging, the per-tab carve-outs), and it lived at 0% test coverage — it sits at
// the repo root, so NEITHER the primary (lib/** + app/api/**/route.ts) nor the
// component coverage gate measures it.
//
// The ledger is full of the incident class a table like this catches:
//   · a "gated" Panini/Candy dataset that was actually anon-readable,
//   · a launch flag with zero consumers that would have silently no-op'd,
//   · a public PAGE whose only backing API was still gated (pinnacle-wallet).
// Every one of those is a wrong answer from THIS function. The table below is the
// contract; a diff that flips any row is a visible, reviewable security change.
//
// Complementary to __tests__/{panini,candy}-launch-flag-contract.test.ts: those
// pin the flag WIRING at the source/sitemap/robots level; this pins the runtime
// ROUTING decision the flag ultimately controls.
// ─────────────────────────────────────────────────────────────────────────────

import { isPublicPath } from "@/proxy"

type Row = [path: string, method: string, expected: boolean, why?: string]

// GET rows unless a method is given. `expected` is what isPublicPath must return
// TODAY (both launch flags false — the shipped state).
const TABLE: Row[] = [
  // ── Exact-match singletons + framework/static ──────────────────────────────
  ["/", "GET", true, "marketing landing / funnel front door"],
  ["/favicon.ico", "GET", true],
  ["/robots.txt", "GET", true],
  ["/sitemap.xml", "GET", true],
  ["/sitemap/0.xml", "GET", true, "generateSitemaps child"],
  ["/sitemap/4.xml", "GET", true],
  ["/sitemap/x.xml", "GET", false, "non-numeric child is NOT the sitemap regex"],
  ["/_next/static/chunk.js", "GET", true],
  ["/logo.png", "GET", true, "static asset extension"],
  ["/app.css", "GET", true],

  // ── Marketing / auth surface pages ─────────────────────────────────────────
  ["/login", "GET", true],
  ["/login/reset", "GET", true],
  ["/early-access", "GET", true],
  ["/pricing", "GET", true],
  ["/about", "GET", true],
  ["/blog", "GET", true],
  ["/blog/why-fmv", "GET", true],
  ["/privacy", "GET", true],
  ["/terms", "GET", true],
  ["/legal", "GET", true],
  ["/legal/fmv-methodology", "GET", true],
  ["/auth", "GET", true],
  ["/auth/confirm", "GET", true],
  ["/admin", "GET", true, "self-gates via RPC_ADMIN_TOKEN"],
  ["/admin/feedback", "GET", true],

  // ── Anon-safe API routes ────────────────────────────────────────────────────
  ["/api/auth/callback", "GET", true],
  ["/api/early-access", "POST", true],
  ["/api/admin/rewards", "POST", true, "self-gates via bearer token"],
  ["/api/cron/warm", "POST", true],
  ["/api/public/profile/whale", "GET", true],
  ["/api/wallet-search", "GET", true, "exact path"],
  ["/api/wallet-search/extra", "GET", false, "wallet-search is exact-match only"],
  ["/api/teams/follow", "POST", true, "route self-enforces auth on write"],
  ["/api/track-click", "POST", true],
  ["/api/track-funnel", "POST", true],
  ["/api/subscribe", "POST", true],
  ["/api/support-chat", "POST", true],
  ["/api/support-chat/feedback", "POST", true],
  ["/api/og/default", "GET", true],
  ["/api/badge-image", "GET", true],
  ["/api/health", "GET", true],
  ["/api/bots/telegram", "POST", true],
  ["/api/bots/discord", "POST", true],
  ["/api/alerts/channels/verify-email", "GET", true, "one-time coded email link"],
  ["/api/fmv/demo", "GET", true],

  // ── Method-sensitive: safe read public, mutation gated under same path ──────
  ["/api/collection-snapshot", "GET", true],
  ["/api/collection-snapshot", "POST", false],
  ["/api/profile/teams", "GET", true],
  ["/api/profile/teams", "POST", false, "favorite-team write stays gated"],
  ["/api/profile/trophy-case/pdf", "GET", true],
  ["/api/profile/trophy-case/pdf", "POST", false],
  ["/api/profile/portfolio-history", "GET", true],
  ["/api/profile/portfolio-history", "POST", false, "daily-snapshot write gated"],
  ["/api/profile/collection-breakdown", "GET", true],
  ["/api/profile/collection-breakdown", "POST", false],
  ["/api/profile/top-movers", "GET", true],
  ["/api/profile/tier-breakdown", "GET", true],

  // ── Public wedge surfaces ────────────────────────────────────────────────────
  ["/nba/fast-break", "GET", true],
  ["/api/nba/fast-break/optimize", "GET", true],
  ["/insights", "GET", true],
  ["/insights/rookie-index", "GET", true],
  ["/moment/12345", "GET", true],
  ["/api/moment/12345", "GET", true],
  ["/pinnacle/moment/GEN-DPIN-SIMB-S0", "GET", true],

  // ── Per-collection overview + its backing API ───────────────────────────────
  ["/nba-top-shot/overview", "GET", true],
  ["/nba-top-shot/overview", "POST", false, "GET/HEAD only"],
  ["/api/collection-stats", "GET", true],
  ["/api/collection-stats", "POST", false],
  ["/api/marketplace-status", "GET", true],
  ["/api/insider-signals", "GET", true],

  // ── Public entity detail pages (GET/HEAD, singular segments only) ────────────
  ["/nba-top-shot/edition/some-slug", "GET", true],
  ["/nfl-all-day/set/some-set", "GET", true],
  ["/laliga-golazos/player/some-player", "GET", true],
  ["/nba-top-shot/edition/some-slug", "POST", false],
  ["/api/entity/set-editions", "GET", true],
  ["/api/entity/set-editions", "POST", false],

  // ── Share cards + public profiles ────────────────────────────────────────────
  ["/share/0xabc", "GET", true],
  ["/share/0xabc", "POST", false],
  ["/profile/whale", "GET", true],
  ["/profile/edit", "GET", false, "own bio editor stays gated"],
  ["/profile/edit/anything", "GET", false],

  // ── Un-gated feature tabs (5 published slugs, GET/HEAD only) ─────────────────
  ["/nba-top-shot/collection", "GET", true],
  ["/nfl-all-day/market", "GET", true],
  ["/ufc/sniper", "GET", true],
  ["/disney-pinnacle/collection", "GET", true],
  ["/nba-top-shot/collection", "POST", false, "tab pages are read-only"],

  // ── PUBLIC_READ_APIS (GET/HEAD) + their write forms ─────────────────────────
  ["/api/market", "GET", true],
  ["/api/sniper-feed", "GET", true],
  ["/api/pinnacle-wallet", "GET", true, "backs the public Pinnacle collection tab"],
  ["/api/wallet-cache", "GET", true],
  ["/api/wallet-cache", "POST", false, "POST=upsert_wmc_batch write, stays gated"],
  ["/api/market", "POST", false],
  ["/api/analytics", "GET", true],
  ["/api/analytics/sales", "GET", true],
  ["/api/analytics/sales", "POST", false],

  // ── POST-body stateless read-computes (GET/HEAD/POST all public) ─────────────
  ["/api/fmv", "GET", true],
  ["/api/fmv", "POST", true],
  ["/api/fmv", "DELETE", false, "only GET/HEAD/POST are carved out"],
  ["/api/best-offers", "POST", true],
  ["/api/edition-floor", "POST", true],
  ["/api/pack-ev", "POST", true],

  // ── Gated: private / personalization / mutation surfaces ─────────────────────
  ["/dashboard", "GET", false],
  ["/dashboard/wallets", "GET", false],
  ["/api/profile/cost-basis-summary", "GET", false, "spend/P&L is owner-only"],
  ["/api/watchlist", "GET", false],
  ["/api/saved-wallets", "GET", false],
  ["/some-random-unlisted-page", "GET", false],
  ["/api/some-unlisted-mutation", "POST", false],
]

describe("isPublicPath — the public/gated boundary (both launch flags false)", () => {
  it.each(TABLE)("%s [%s] → public=%s", (path, method, expected) => {
    expect(isPublicPath(path, method)).toBe(expected)
  })
})

describe("staged surfaces stay gated AND override the general bypass", () => {
  // These are the ledger's highest-cost bug class: a staged surface that leaks
  // because a broad `/insights/*` or `/api/public/*` bypass runs before (or
  // instead of) the flag gate. The Panini/Candy gates MUST win over those
  // bypasses while the flag is false.
  // Panini stays staged (PANINI_PUBLIC false). Candy went LIVE on 2026-07-31
  // (CANDY_MLB_PUBLIC=true), so its three surfaces are asserted public below.
  const stagedRows: Array<[string, string]> = [
    ["/insights/panini-squeeze", "the /insights/* bypass would otherwise allow this"],
    ["/api/public/insights/panini-squeeze", "the /api/public/* bypass would otherwise allow this"],
    ["/api/og/insights/panini-squeeze", "the /api/og/* bypass would otherwise allow this"],
  ]
  it.each(stagedRows)("%s is GATED while its flag is false (%s)", (path) => {
    expect(isPublicPath(path, "GET")).toBe(false)
  })

  // Candy is live — with the real flag on, all three candy surfaces are public.
  // The mocked both-directions proof lives in the flip describe block below.
  const liveCandyRows: string[] = [
    "/insights/candy-mlb",
    "/api/public/insights/candy-mlb",
    "/api/og/insights/candy-mlb",
  ]
  it.each(liveCandyRows)("%s is PUBLIC now that Candy is live", (path) => {
    expect(isPublicPath(path, "GET")).toBe(true)
  })

  it("a NON-staged /insights sibling is still public (the gate is scoped, not a blanket)", () => {
    expect(isPublicPath("/insights/rookie-index", "GET")).toBe(true)
    expect(isPublicPath("/api/public/insights/rookie-index", "GET")).toBe(true)
    expect(isPublicPath("/api/og/insights/rookie-index", "GET")).toBe(true)
  })
})

describe("launch-flag flip actually un-gates the routing decision (not just source)", () => {
  // The panini/candy contract tests assert the source contains `!PANINI_PUBLIC &&`;
  // this proves the FLIP changes the runtime answer — closing the "silent no-op"
  // class behaviourally. Re-imports proxy with the flag module mocked true.
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock("@/lib/launch-flags")
  })

  it("PANINI_PUBLIC=true makes the panini surfaces public", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: false, PANINI_PUBLIC: true }))
    vi.resetModules() // proxy is statically imported above (cached) — force a fresh eval bound to the mock
    const { isPublicPath: freshIsPublic } = await import("@/proxy")
    expect(freshIsPublic("/insights/panini-squeeze", "GET")).toBe(true)
    expect(freshIsPublic("/api/public/insights/panini-squeeze", "GET")).toBe(true)
    // ...and Candy stays gated — the two flags are independent.
    expect(freshIsPublic("/insights/candy-mlb", "GET")).toBe(false)
  })

  it("CANDY_MLB_PUBLIC=true makes the candy surfaces public", async () => {
    vi.doMock("@/lib/launch-flags", () => ({ CANDY_MLB_PUBLIC: true, PANINI_PUBLIC: false }))
    vi.resetModules() // proxy is statically imported above (cached) — force a fresh eval bound to the mock
    const { isPublicPath: freshIsPublic } = await import("@/proxy")
    expect(freshIsPublic("/insights/candy-mlb", "GET")).toBe(true)
    expect(freshIsPublic("/insights/panini-squeeze", "GET")).toBe(false)
  })
})
