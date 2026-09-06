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
// TODAY. None of these rows touch the Candy/Panini staged paths, so every
// expectation here is independent of the launch flags (both live as of
// 2026-08-01); the flag-gated paths are asserted in their own blocks below.
const TABLE: Row[] = [
  // ── Exact-match singletons + framework/static ──────────────────────────────
  ["/", "GET", true, "marketing landing / funnel front door"],
  ["/favicon.ico", "GET", true],
  ["/robots.txt", "GET", true],
  // ⚠ /llms.txt is the AI-crawler sibling of robots.txt and shipped in public/,
  // but `.txt` is not a static-allowlist extension — so the one file whose whole
  // purpose is to be read by an anonymous crawler was 302'ing to /login.
  ["/llms.txt", "GET", true, "AI-crawler descriptor, shipped in public/"],
  ["/foo/llms.txt", "GET", false, "exact path only — not any .txt anywhere"],
  ["/sitemap.xml", "GET", true],
  ["/sitemap/0.xml", "GET", true, "generateSitemaps child"],
  ["/sitemap/4.xml", "GET", true],
  ["/sitemap/x.xml", "GET", false, "non-numeric child is NOT the sitemap regex"],
  ["/_next/static/chunk.js", "GET", true],
  // ⚠ THESE TWO ROWS ASSERTED THE VULNERABILITY AS THE CONTRACT until 2026-08-15.
  // They read as "static asset extension" but neither file exists: the real logo
  // is /rip-packs-city-logo.png and the app ships no root /app.css. What they
  // actually pinned was the unanchored suffix test that let ANY path ending in
  // one of those extensions skip the auth wall. A row whose stated reason
  // ("static asset extension") differs from what it proves ("any path ending in
  // .png is public") is how a hole in the wall survives review.
  ["/logo.png", "GET", false, "not a real asset — an exact allowlist, not a suffix"],
  ["/app.css", "GET", false, "not a real asset — see /topshot.png below"],
  ["/rip-packs-city-logo.png", "GET", true, "the real logo, fetched server-side with no session"],
  ["/window.svg", "GET", true, "real public/ root asset"],
  // ⚠ Fonts were unreachable until 2026-08-13 — `.ttf` is not a STATIC_EXT_RX
  // extension and nothing exempted /fonts/, so every request was 302'd to
  // /login. Two server-side consumers fetch them over HTTP with no session: the
  // OG profile card (edge runtime, cannot read disk) and the trophy-case PDF. A
  // followed redirect handed both an HTML document at status 200, which satori
  // rejects by THROWING out of the response stream.
  ["/fonts/BarlowCondensed-Black.ttf", "GET", true, "the real vendored display font"],
  ["/fonts/ShareTechMono-Regular.ttf", "GET", true, "the real vendored mono font"],
  ["/fonts/x.otf", "GET", true],
  ["/fonts/x.woff", "GET", true],
  ["/fonts/x.woff2", "GET", true],
  // ⚠ DIRECTORY **AND** EXTENSION, both required — deliberately narrower than
  // adding the extensions to STATIC_EXT_RX, which matches any path ending in
  // one and would therefore publish a gated route whose trailing dynamic
  // segment a visitor controls.
  ["/dashboard/report.ttf", "GET", false, "font extension outside /fonts stays gated"],
  ["/api/profile/trophy.woff2", "GET", false, "a gated API path cannot be unlocked by its extension"],
  // ⚠ NOT asserted here, and the omission is deliberate: `/profile/x.woff2` IS
  // public — because `/profile/` is a public surface already, not because of
  // anything below. A first draft used it as the negative case and the table
  // correctly reddened. Pick a genuinely gated prefix, or the row proves the
  // opposite of what it claims.
  ["/fonts", "GET", false, "the directory itself is not public"],
  ["/fonts/list", "GET", false, "no font extension — still gated"],
  ["/fonts/a/b.ttf", "GET", false, "single level only — no nested traversal"],
  ["/fonts/x.ttf.json", "GET", false, "the extension must END the path"],

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
  // ⚠ Both callers (SqueezeBoardClient, ShareProfileButtons) fire this anonymously
  // on PUBLIC surfaces and document that anon "just gets a 401". Until 2026-08-28
  // the proxy 307d the POST to /login, which 405s POST — the pinned 401 branch in
  // api-rewards-track.test.ts was unreachable in production.
  ["/api/rewards/track", "POST", true, "route self-enforces auth (requireUser -> 401)"],
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

  // ── Shareable profile surfaces ───────────────────────────────────────────────
  // ⚠ These exist to be fetched by a CRAWLER with no session. If the wall ever
  // swallows one, it does not 404 — `proxy.ts` 302s to /login, and the crawler
  // follows it and gets an HTML login page at status 200. That is exactly how
  // `/fonts/*.ttf` was broken for weeks: every check said "200, non-empty", and
  // the only symptom was a broken artifact downstream. Here the symptom would
  // be a collector's shared trophy case unfurling as the sign-in page.
  ["/profile/trevor", "GET", true],
  ["/profile/trevor/trophy-case", "GET", true, "the shareable trophy case must not need a session"],
  ["/api/og/profile/trevor", "GET", true],
  ["/api/og/trophy-case/trevor", "GET", true, "its card must be fetchable by an unauthenticated crawler"],
  // ...while the editor stays gated, including anything under it.
  ["/profile/edit", "GET", false, "the editor is not a public surface"],

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
  // The bare root is a server redirect to /overview; every entity page's
  // breadcrumb links it, so it must not bounce an anonymous reader to /login.
  ["/nba-top-shot", "GET", true, "collection root redirects to /overview"],
  ["/nfl-all-day", "HEAD", true],
  ["/laliga-golazos", "GET", true],
  ["/disney-pinnacle", "GET", true],
  ["/ufc", "GET", true],
  ["/nba-top-shot", "POST", false, "GET/HEAD only"],
  ["/candy-mlb", "GET", true, "published 2026-09-06 (thin) — the breadcrumb/JSON-LD root is crawlable"],
  ["/panini-blockchain", "GET", false, "unpublished chain-three root stays gated"],
  ["/panini", "GET", false, "unpublished root stays gated"],
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

  // ── Global catalog search ────────────────────────────────────────────────────
  // Read-only index over data that is already anonymously readable (the
  // collection tabs un-gated 2026-07-17; the entity pages it links to are in
  // the sitemap). Gated, it would 302 anonymous visitors to /login on every
  // keystroke. GET/HEAD only, and EXACT path — no /api/search/* subtree is
  // opened, so a future sibling route must make its own decision.
  ["/api/search", "GET", true],
  ["/api/search", "HEAD", true],
  ["/api/search", "POST", false],
  ["/api/search/anything", "GET", false, "exact match only — no subtree"],

  // ── Follow-state probe ───────────────────────────────────────────────────────
  // GET is public so the Follow button on the anon-readable profile page gets
  // JSON instead of 50KB of login HTML; the route still calls requireUser() for
  // its listing form, and the writers stay gated here.
  ["/api/profile/follows", "GET", true],
  ["/api/profile/follows", "POST", false, "follow write stays gated"],
  ["/api/profile/follows", "DELETE", false, "unfollow write stays gated"],

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
  ["/api/profile/me", "GET", true, "answers {user:null} for anon by design; was 307'd to /login (2026-09-04)"],
  ["/api/profile/me", "POST", false, "no write form is public"],
  ["/api/profile/bio", "GET", false, "the rest of /api/profile stays gated"],
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
  ["/api/badge-taxonomy", "POST", true, "static taxonomy read carried in a POST body; anon pages call it per badge chip (2026-09-04)"],
  ["/api/badge-taxonomy", "DELETE", false],

  // ── Gated: private / personalization / mutation surfaces ─────────────────────
  ["/dashboard", "GET", false],
  ["/dashboard/wallets", "GET", false],
  ["/api/profile/cost-basis-summary", "GET", false, "spend/P&L is owner-only"],
  ["/api/watchlist", "GET", false],
  ["/api/saved-wallets", "GET", false],
  ["/some-random-unlisted-page", "GET", false],
  ["/api/some-unlisted-mutation", "POST", false],
]

describe("isPublicPath — the public/gated boundary (flag-independent rows)", () => {
  it.each(TABLE)("%s [%s] → public=%s", (path, method, expected) => {
    expect(isPublicPath(path, method)).toBe(expected)
  })
})

describe("launched surfaces are public (Candy + Panini live)", () => {
  // The inverse of the ledger's highest-cost bug class: a staged surface that
  // leaked because a broad `/insights/*` or `/api/public/*` bypass ran before
  // (or instead of) the flag gate. Both flags are now LIVE (Candy 2026-07-31,
  // Panini 2026-08-01), so all six surfaces must be public — with the real flags
  // ON. The mocked both-directions proof (that a flag-OFF re-gates) lives in the
  // flip describe block below.
  const liveRows: string[] = [
    "/insights/candy-mlb",
    "/api/public/insights/candy-mlb",
    "/api/og/insights/candy-mlb",
    "/insights/panini-squeeze",
    "/api/public/insights/panini-squeeze",
    "/api/og/insights/panini-squeeze",
  ]
  it.each(liveRows)("%s is PUBLIC now that its launch flag is live", (path) => {
    expect(isPublicPath(path, "GET")).toBe(true)
  })

  it("a NON-launched /insights sibling is still public (the gate is scoped, not a blanket)", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: the static-extension suffix bypass (2026-08-13, closed 2026-08-15).
//
// `STATIC_EXT_RX` was an UNANCHORED suffix test, so any path ending in
// `.png|.jpg|.svg|.webp|.ico|.css|.js` was public — including a gated route
// whose trailing segment a visitor controls.
//
// ✅ Confirmed live, on evidence that survives a control: `/api/mcp/keys/<uuid>`
// answers 307 → /login anonymously, while `…<uuid>.png` answers 405. A 405 cannot
// come from the wall, so the suffixed request reached the handler.
//
// ⛔ Defense-in-depth, NOT a confirmed breach — and this block previously said
// otherwise. Two sessions independently reported that `/topshot.png` (and
// `/profile/edit.css`) "rendered a gated page for an anonymous visitor". Both
// were wrong the same way: the next hop was already public by design, and the
// no-bypass controls (`/totally-bogus-slug/overview`, `/profile/zzz-no-such-user`)
// return the same page or more of it. A 200 beside a 307 is not evidence until
// you show the 200 required the bypass. The rows below pin the PREDICATE, which
// is the part that was genuinely broken and the only part a unit test can see.
//
// ⚠ Anchoring to a single root segment does NOT fix this — collections share the
// root namespace with the static assets. Only an exact allowlist does. These
// rows fail against the anchored-regex "fix" as well as the original, which is
// the point of keeping them.
// ─────────────────────────────────────────────────────────────────────────────
describe("static-extension suffix must not bypass the gate", () => {
  const SUFFIXES = ["png", "jpg", "jpeg", "svg", "webp", "ico", "css", "js"] as const

  // (path, why) — each is gated in its bare form; adding any suffix must not flip it.
  const GATED: ReadonlyArray<readonly [string, string]> = [
    ["/topshot", "collection root — the confirmed live exposure"],
    ["/allday", "collection root"],
    ["/analytics/wallets/0x1234567890abcdef", "wallet analytics"],
    ["/analytics/sets/12345", "set analytics"],
    ["/api/mcp/keys/3f8b2c1a-1111-4222-8333-444455556666", "MCP API key management"],
    // ⚠ This row was `/api/analytics/sets/12345` and it was WRONG — that path is
    // PUBLIC in its bare form (the 2026-07-17 soft launch un-gated the whole
    // `/api/analytics` subtree), so it would have asserted the opposite of what
    // it claimed and passed for the wrong reason. The bare-path positive control
    // on the line below is the only thing that caught it. Second time this exact
    // mistake has been made in this file (see the /profile/someone.woff2 note
    // above): when writing a negative row, VERIFY the bare path is gated first.
    ["/api/profile/trophy/reorder", "collector's own trophy case — a real write surface"],
    ["/edition/12345", "edition detail"],
  ]

  for (const [path, why] of GATED) {
    it(`${path} stays gated with any static suffix (${why})`, () => {
      expect(isPublicPath(path, "GET")).toBe(false) // positive control: gated bare
      for (const ext of SUFFIXES) {
        expect(isPublicPath(`${path}.${ext}`, "GET")).toBe(false)
        expect(isPublicPath(`${path}.${ext.toUpperCase()}`, "GET")).toBe(false)
      }
    })
  }

  // The other half of the contract: real assets must stay reachable.
  const ASSETS = [
    "/rip-packs-city-logo.png",
    "/file.svg",
    "/globe.svg",
    "/next.svg",
    "/vercel.svg",
    "/window.svg",
    // The REAL vendored fonts, not a plausible-looking name: these two are the
    // files the OG card and the trophy-case PDF actually fetch over HTTP.
    "/fonts/BarlowCondensed-Black.ttf",
    "/fonts/ShareTechMono-Regular.ttf",
    "/favicon.ico",
    "/_next/static/chunks/main.js",
  ]
  for (const path of ASSETS) {
    it(`${path} stays public`, () => {
      expect(isPublicPath(path, "GET")).toBe(true)
    })
  }
})
