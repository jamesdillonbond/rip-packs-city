import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// OG card render sweep — every /api/og/** card must emit REAL PNG BYTES.
//
// WHY THIS EXISTS
// This app has a KNOWN, previously-shipped failure mode: an OG route returning
// HTTP 200 + content-type image/png with a ZERO-BYTE body, which silently
// blanks every social unfurl (memory: share-og-image-zero-bytes; resolved by
// moving off the `opengraph-image.tsx` file convention to /api/og/* handlers).
// A test asserting only `status === 200` passes straight through that bug, so
// every assertion here reads the actual bytes: PNG magic + a real length + the
// width/height out of the IHDR chunk rather than the config we passed in.
//
// Until this file landed, exactly ONE of the 44 `route.tsx` files in app/api
// had a test (api-og-insights-candy-mlb), and `route.tsx` was measured by
// NEITHER coverage gate — the primary gate's include is `app/api/**/route.ts`,
// which does not match `.tsx`. So 43 cards could regress to 0 bytes with
// nothing in CI to catch it. This sweep is the regression floor for all of
// them; the sibling candy-mlb test keeps its deeper per-branch assertions.
//
// WHAT IT DELIBERATELY DOES *NOT* ASSERT
// Not the headline text or the data branch. Upstreams are stubbed generically,
// so most cards render their FALLBACK copy here — and that is the point: the
// fallback path is the one a social crawler hits when the backing API is down,
// and it is exactly the path that must never 500 or emit an empty body. Per-
// card data-branch assertions belong in per-card tests (see candy-mlb), not in
// a sweep whose value is breadth.
//
// A card that legitimately renders at a non-default size registers it in
// SIZE_OVERRIDES rather than being dropped from the sweep.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_MAGIC = "89504e470d0a1a0a"
const DEFAULT_W = 1200
const DEFAULT_H = 630

/** Cards whose canvas is intentionally not 1200x630. */
const SIZE_OVERRIDES: Record<string, { w: number; h: number }> = {}

/**
 * Every OG card route, with a query string that satisfies its required params.
 *
 * Routes are listed EXPLICITLY rather than globbed at runtime so that adding a
 * new card is a conscious "add it to the sweep" step; the companion
 * completeness guard (api-route-tsx-test-completeness.test.ts) fails CI if a
 * `route.tsx` exists that no test references, so a forgotten card cannot land
 * silently.
 */
const CARDS: Array<{ path: string; query?: string; params?: Record<string, string> }> = [
  // Entity cards (read Supabase directly)
  { path: "app/api/og/collection/route", query: "?slug=nba-top-shot" },
  { path: "app/api/og/deal/route", query: "?edition=1:2&price=10&fmv=20" },
  { path: "app/api/og/default/route" },
  { path: "app/api/og/edition/route", query: "?slug=1-2" },
  { path: "app/api/og/moment/[id]/route", query: "?id=abc", params: { id: "abc" } },
  { path: "app/api/og/pack/route", query: "?collection=nba-top-shot&dist=1" },
  { path: "app/api/og/pack/lifecycle/route", query: "?id=1" },
  { path: "app/api/og/player/route", query: "?collection=nba-top-shot&slug=lebron-james" },
  { path: "app/api/og/series/route", query: "?collection=nba-top-shot&slug=series-1" },
  { path: "app/api/og/set/route", query: "?collection=nba-top-shot&slug=base-set" },
  { path: "app/api/og/team/route", query: "?collection=nba-top-shot&slug=portland-trail-blazers" },
  { path: "app/api/og/share/route", query: "?wallet=0xbd94cade097e50ac" },
  { path: "app/api/og/fast-break/route", query: "?date=2026-08-11" },
  { path: "app/api/og/profile/[username]/route", params: { username: "jamesdillonbond" } },
  { path: "app/api/og/trophy-case/[username]/route", params: { username: "jamesdillonbond" } },

  // Insights board cards (self-fetch their public API)
  { path: "app/api/og/insights/route" },
  { path: "app/api/og/insights/allday-pack-market/route" },
  { path: "app/api/og/insights/allday-pack-reality/route" },
  { path: "app/api/og/insights/allday-scarcity/route" },
  { path: "app/api/og/insights/cross-collection/route" },
  { path: "app/api/og/insights/deals/route" },
  { path: "app/api/og/insights/first-mint/route" },
  { path: "app/api/og/insights/market/route" },
  { path: "app/api/og/insights/market-pulse/route" },
  { path: "app/api/og/insights/new-collectors/route" },
  { path: "app/api/og/insights/offer-spread/route" },
  { path: "app/api/og/insights/pack-drops/route" },
  { path: "app/api/og/insights/pack-reality/route" },
  { path: "app/api/og/insights/pack-sniper/route" },
  { path: "app/api/og/insights/panini-squeeze/route" },
  { path: "app/api/og/insights/parallel-premiums/route" },
  { path: "app/api/og/insights/pinnacle-scarcity/route" },
  { path: "app/api/og/insights/rookie-board/route" },
  { path: "app/api/og/insights/rookies/route" },
  { path: "app/api/og/insights/serial-premiums/route" },
  { path: "app/api/og/insights/set-completers/route" },
  { path: "app/api/og/insights/set-squeeze/route" },
  { path: "app/api/og/insights/squeeze/route" },
  { path: "app/api/og/insights/squeeze-check/route" },
  { path: "app/api/og/insights/top-sales/route" },
  { path: "app/api/og/insights/topshot-pack-market/route" },
  { path: "app/api/og/insights/trophies/route" },
  { path: "app/api/og/insights/underpriced-serials/route" },
]

/**
 * A row shaped as the UNION of the fields the various board cards read, so one
 * fixture drives every card's data branch far enough to render. Cards that want
 * a field we don't supply fall back to their null-handling, which is fine — the
 * sweep asserts bytes, not copy.
 */
const UNIVERSAL_ROW: Record<string, unknown> = {
  edition_id: "11111111-1111-1111-1111-111111111111",
  external_id: "1:2",
  player_name: "Test Player",
  set_name: "Base Set",
  team_name: "Portland Trail Blazers",
  character_name: "Test Character",
  collection: "nba_top_shot",
  collection_slug: "nba-top-shot",
  tier: "COMMON",
  serial_number: 1,
  circulation_count: 1000,
  mint_count: 1000,
  fmv_usd: 42.5,
  price_usd: 30,
  ask_price: 30,
  low_ask: 30,
  discount_pct: 29.4,
  squeeze_pct: 12.5,
  premium_pct: 15,
  pct: 10,
  count: 5,
  n: 5,
  total: 5,
  supply: 1000,
  holders: 250,
  owners: 250,
  ev: 12.34,
  pack_ev: 12.34,
  typical_pull_ev: 8.5,
  retail_price_usd: 10,
  sold_at: "2026-08-01T00:00:00Z",
  computed_at: "2026-08-11T00:00:00Z",
  confidence: "HIGH",
  thumbnail_url: null, // never a URL: Satori would try to fetch it
  image_url: null,
  name: "Test",
  slug: "test",
  title: "Test",
  username: "jamesdillonbond",
  wallet_address: "0xbd94cade097e50ac",
}

const ROWS = Array.from({ length: 8 }, (_, i) => ({ ...UNIVERSAL_ROW, rank: i + 1 }))

/**
 * JSON body shaped as the UNION of every envelope these cards consume.
 *
 * ⚠ The union matters more than it looks. Each card reads a DIFFERENT top-level
 * key — `rows` (market, market-pulse), `wallets` + `stats` (cross-collection),
 * `deals` + `meta.stats` (pack-sniper), `drops` + `meta` (pack-drops),
 * `trophies` + `stats` (first-mint), `stats.*` scalars (the /insights hub). A
 * payload carrying only `rows` silently sends most cards down their FALLBACK
 * branch, which still renders a valid PNG — so the sweep passes while the
 * per-card formatters (fmtVol / shortAddr / tierColor / num / usd …) never
 * execute. That is exactly how these cards sat at 20-40% function coverage
 * while every assertion here was green.
 */
const MARKET_ROWS = (() => {
  // market/ needs a per-tier time series incl. an "ALL" tier, spanning >30d so
  // the 30-day change leg resolves rather than short-circuiting to null.
  const out: Array<Record<string, unknown>> = []
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)
  for (const tier of ["ALL", "LEGENDARY", "RARE", "FANDOM", "COMMON"]) {
    for (let i = 0; i < 45; i += 1) {
      out.push({
        tier,
        d: day(i),
        median_px: 100 + i,
        sales: 10 + i,
        volume_usd: 1000 + i * 10,
        // market-pulse reads the SAME `rows` key but a different row shape, and
        // filters on `sales_7d > 0` — without these three it dropped every row
        // and silently rendered its fallback (caught by the data-branch check).
        collection_name: "NBA Top Shot",
        volume_7d: 125_000 + i * 100,
        sales_7d: 900 + i,
        buyers_7d: 400 + i,
      })
    }
  }
  return out
})()

const UNIVERSAL_JSON: Record<string, unknown> = {
  ok: true,
  rows: MARKET_ROWS,
  data: ROWS,
  items: ROWS,
  results: ROWS,
  editions: ROWS,
  packs: ROWS,
  sales: ROWS,
  // Per-card envelope keys (see the note above).
  wallets: ROWS.map((r, i) => ({ ...r, address: `0x${(i + 1).toString(16).padStart(16, "0")}`, moments: 10 + i, collections: 3 })),
  deals: ROWS.map((r) => ({ ...r, pack_name: "Test Pack", ev: 12.5, ask: 10, ev_ratio: 1.25 })),
  drops: ROWS.map((r) => ({ ...r, drop_name: "Test Drop", packs: 500, sold_pct: 40 })),
  trophies: ROWS.map((r) => ({ ...r, multiplier: 3.2, price_usd: 500 })),
  distribution: ROWS,
  top_ev: ROWS,
  count: ROWS.length,
  total: ROWS.length,
  meta: {
    coverage: { basis: "listing_gated", note: "test" },
    total_drops: 12,
    stats: { positiveEv: 7 },
  },
  stats: {
    ...UNIVERSAL_ROW,
    rips_60d: 1234,
    zero_value_pct: 8.1,
    cohort_size: 246,
    trophies_90d: 42,
    avg_multiplier: 3.4,
    median_pull_value_usd: 26,
    mean_pull_value_usd: 86,
  },
  ...UNIVERSAL_ROW,
}

/**
 * Chainable Supabase stub that answers ANY builder chain and any `.rpc()`.
 *
 * A hand-written chain object breaks the moment a card adds `.order()` or
 * `.maybeSingle()`, so this is a Proxy: every property access returns the same
 * callable proxy, and awaiting anywhere in the chain resolves to
 * `{ data, error: null }`. That keeps the sweep robust to per-card query shape
 * without pinning any card's exact query — which is a per-card test's job.
 */
function chainProxy(data: unknown): any {
  const target: any = function () {
    return chainProxy(data)
  }
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve({ data, error: null, count: ROWS.length })
      }
      if (prop === Symbol.toPrimitive || prop === "toJSON") return () => ""
      return chainProxy(data)
    },
    apply() {
      return chainProxy(data)
    },
  })
}

/** Rows PostgREST returns for the profile card's four reads, keyed by table. */
const REST_ROWS: Record<string, unknown[]> = {
  profile_bio: [
    {
      user_id: "11111111-1111-1111-1111-111111111111",
      display_name: "Trevor",
      tagline: "Portland Trail Blazers Team Captain",
      accent_color: "#E03A2F",
      avatar_url: null,
      favorite_team: "Portland Trail Blazers",
    },
  ],
  saved_wallets: [
    { cached_fmv_usd: 12345.67, cached_moment_count: 250, cached_badges: ["rookie_year"] },
    { cached_fmv_usd: 890.12, cached_moment_count: 40, cached_badges: [] },
  ],
  trophy_moments: Array.from({ length: 6 }, (_, i) => ({
    slot: i,
    player_name: `Player ${i + 1}`,
    thumbnail_url: null, // a URL would make Satori fetch real art
    tier: ["LEGENDARY", "RARE", "COMMON", "FANDOM", "ULTIMATE", "RARE"][i],
  })),
  profile_achievements: [
    { achievement_key: "first_moment", tier: "gold" },
    { achievement_key: "set_completer", tier: "silver" },
  ],
}

/** Pick the PostgREST table out of a `/rest/v1/<table>?...` URL. */
function restRowsFor(url: string): unknown[] {
  const m = url.match(/\/rest\/v1\/([a-z_]+)/)
  return (m && REST_ROWS[m[1]]) || []
}

function installSupabaseStub() {
  const client = {
    from: () => chainProxy(ROWS),
    rpc: async () => ({ data: ROWS, error: null }),
    schema: () => ({ from: () => chainProxy(ROWS) }),
  }
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: client,
    supabase: client,
    default: client,
  }))
  // og/pack/lifecycle builds its OWN client from @supabase/supabase-js rather
  // than importing @/lib/supabase, so mocking only the latter left it on the
  // null-lifecycle path.
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: () => ({
      ...client,
      rpc: async () => ({ data: PACK_LIFECYCLE, error: null }),
    }),
  }))
}

/** Shape of get_pack_lifecycle's jsonb return (og/pack/lifecycle). */
const PACK_LIFECYCLE = {
  status: "opened",
  pack_nft_id: "1",
  collection: "nba_top_shot",
  dist_name: "Test Drop",
  purchased_at: "2026-07-01T00:00:00Z",
  opened_at: "2026-07-02T00:00:00Z",
  price_usd: 25,
  pull_value_usd: 62.5,
  pulls: [
    { player_name: "Dame", tier: "LEGENDARY", serial_number: 7, fmv_usd: 40 },
    { player_name: "Ant", tier: "RARE", serial_number: 88, fmv_usd: 22.5 },
  ],
}

let originalFetch: typeof globalThis.fetch

/**
 * True for a request the CARD makes (its own public API), false for one the
 * RENDERER makes.
 *
 * ⚠ This split is load-bearing, not defensive coding. `next/og` loads its
 * Satori/resvg WebAssembly through the SAME global fetch, so a blanket stub
 * hands the JSON envelope to `WebAssembly.instantiate`, which dies with
 * `expected magic word 00 61 73 6d, found 7b 22 6f 6b` (`{"ok`) — every card
 * fails for a reason that has nothing to do with the card. Anything that is not
 * an http(s) app-API call is delegated to the real fetch so the WASM still
 * loads from disk.
 */
function isAppApiRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  if (!/^https?:/i.test(url)) return false
  // `/rest/v1/` is PostgREST: og/profile/[username] reads its bio/wallets/
  // trophies/achievements straight from it rather than through an app route.
  // Without this the card's fetches escaped to the real network, failed, and it
  // rendered its FALLBACK — which is a valid PNG, so the sweep stayed green
  // while the whole data branch (11 of 15 functions) never ran.
  // `/fonts/*.ttf` is the RENDERER's, not the card's — but it is still an
  // http(s) call to our own origin, and it was falling through to the real
  // network on every CI run. Measured 2026-08-29: the loader fetches
  // https://www.rippackscity.com/fonts/{BarlowCondensed-Black,ShareTechMono-
  // Regular}.ttf, and 0 of 2 matched this predicate. The file's own header says
  // no card in this sweep may touch the network; it did, ~every run.
  //
  // The consequence was not just impurity. `loadBrandFontBytes` memoises at
  // module scope, so the FIRST card to render paid that fetch — and when the
  // connection stalled on a CI runner, that one test hung to vitest's 60,000 ms
  // timeout against an 83 ms local render (run 4202, 2026-08-29). Which card it
  // was varied with execution order, which is why it read as a random flake.
  // ⭐ AND TWEMOJI. Closing the passthrough surfaced a second escape nobody had
  // recorded: `next/og` fetches emoji SVGs from
  // https://cdn.jsdelivr.net/gh/twitter/twemoji/... at RENDER time, so four
  // cards (collection, deal, pack, pack/lifecycle) reached a third-party CDN on
  // every run of this suite — and, more importantly, did so IN PRODUCTION on
  // every uncached card render.
  //
  // 🚨 THAT STUB IS GONE ON PURPOSE (2026-08-29), AND ITS REMOVAL IS THIS FILE'S
  // STRONGEST ASSERTION. Stubbing `twemoji` made the suite hermetic and made the
  // defect INVISIBLE here: the cards kept reaching the CDN in production while
  // this sweep stayed green. Now a remote-glyph fetch falls through to the throw
  // below, so the sweep FAILS on it — and it is the only instrument that can,
  // because it sees glyphs that arrive through DATA. `og/collection` rendered
  // `collection.icon` at 140px, and every icon in the registry is an emoji; no
  // scan of this repo's source could ever have found that.
  //
  // ⚠ The throw is a real failure, not a degraded render: verified 2026-08-29 by
  // rendering "deal 🎯 card" against a rejecting fetch — `ImageResponse` rejects
  // with the escape message rather than dropping the glyph and carrying on (the
  // control, "deal card", renders 3,364 bytes clean). Satori does not swallow it,
  // so this guard cannot pass while the dependency exists.
  //
  // Both of next/og's remote fallbacks land here. jsdelivr for emoji; Google
  // Fonts (`fonts.googleapis.com/css2?family=Noto+Sans+Symbols…`) for any glyph
  // the supplied brand fonts miss — → ↑ ↓ ← ▲ ▼ ✓ ✕ № ‾ among them, measured.
  // Neither is in the predicate, so neither can be silently absorbed again.
  return url.includes("/api/") || url.includes("/rest/v1/") || url.includes("/fonts/")
}

/**
 * Real bytes from `public/fonts`, so intercepting the font fetch changes nothing
 * about what the cards render — only where the bytes come from. Serving JSON
 * here instead would fail `isSupportedFontBuffer`, silently drop the brand fonts
 * from every card in the sweep, and quietly weaken what these renders assert.
 */
function localFontResponse(url: string): Response {
  const name = url.split("/fonts/")[1]?.split("?")[0] ?? ""
  const file = join(__dirname, "..", "public", "fonts", name)
  if (!existsSync(file)) return new Response("not found", { status: 404 })
  const bytes = readFileSync(file)
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "font/ttf" },
  })
}

function stubFetch(respond: (url: string) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isAppApiRequest(input)) {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
      // ⛔ AN UNMATCHED http(s) CALL IS A FAILURE, NOT A PASSTHROUGH. The header
      // says no card in this sweep may touch the network; before 2026-08-29 that
      // was aspirational — the font fetch escaped here every run and hung one
      // test to 60s in CI. Non-http(s) still delegates, because next/og loads
      // its Satori/resvg WASM through this same global fetch.
      if (/^https?:/i.test(raw)) {
        throw new Error(
          `sweep escaped to the network: ${raw}. Add it to isAppApiRequest and serve it a stub, ` +
            `or the suite depends on prod being up and can hang on a slow upstream.`,
        )
      }
      return originalFetch(input as never, init)
    }
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    return respond(url)
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  // Both PostgREST-backed cards return their fallback outright when these are
  // unset, so without them their data branches are unreachable in test.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key"
  originalFetch = globalThis.fetch
  // Every self-fetch resolves to the universal envelope. No card in this sweep
  // may touch the network: an unstubbed fetch would make the suite dependent on
  // prod being up, and on a slow/500 upstream it would assert the WRONG card.
  stubFetch(async (url) => {
    if (url.includes("/fonts/")) return localFontResponse(url)
    const body = url.includes("/rest/v1/") ? restRowsFor(url) : UNIVERSAL_JSON
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  installSupabaseStub()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.doUnmock("@supabase/supabase-js")
  vi.restoreAllMocks()
})

async function renderCard(path: string, query = "", params?: Record<string, string>) {
  const mod = await import(/* @vite-ignore */ `@/${path}`)
  const handler = mod.GET
  expect(typeof handler).toBe("function")
  const req = new NextRequest(`https://www.rippackscity.com/x${query}`)
  // Dynamic-segment cards take Next's second `{ params }` arg (a Promise in
  // Next 16). Static ones ignore it; two take no argument at all — passing one
  // to a zero-arity handler is harmless.
  const res = await handler(req, { params: Promise.resolve(params ?? {}) })
  const buf = Buffer.from(await res.arrayBuffer())
  return { res, buf }
}

function assertRealPng(buf: Buffer, res: Response, path: string) {
  const size = SIZE_OVERRIDES[path] ?? { w: DEFAULT_W, h: DEFAULT_H }
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("image/png")
  // The 0-byte trap. A status-only assertion would sail past it.
  expect(buf.length).toBeGreaterThan(1000)
  expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  // Dimensions read from the IHDR chunk — the bytes, not our config.
  expect(buf.readUInt32BE(16)).toBe(size.w)
  expect(buf.readUInt32BE(20)).toBe(size.h)
}

describe("the sweep is hermetic", () => {
  // Added 2026-08-29 after run 4202 timed out at 60,000 ms on a card that
  // renders in 83 ms locally. Cause: `loadBrandFontBytes` fetched
  // /fonts/*.ttf from the LIVE SITE — 0 of 2 matched isAppApiRequest, so both
  // fell through to the real network on every run — and the loader memoises at
  // module scope, so the first card to render paid it and hung when that
  // connection stalled. Which card varied with execution order, which is why it
  // read as a random flake rather than a dependency.
  //
  // Closing the passthrough immediately surfaced a SECOND escape nobody had
  // recorded: next/og fetches Twemoji SVGs from cdn.jsdelivr.net at render time.
  //
  // ⚠ This pins the GUARD, not the two URLs. Listing them would pass just as
  // happily with the passthrough reopened.
  it("throws on an unmatched http(s) call instead of reaching the network", async () => {
    await expect(fetch("https://example.invalid/anything")).rejects.toThrow(/escaped to the network/)
  })

  it("still delegates non-http(s) URLs, which is how next/og loads its WASM", async () => {
    // The load-bearing exception. A blanket stub hands the JSON envelope to
    // WebAssembly.instantiate and every card dies for an unrelated reason.
    await expect(fetch("data:text/plain,hello").then((r) => r.text())).resolves.toBe("hello")
  })
})

describe("OG card render sweep — real PNG bytes, never a 0-byte 200", () => {
  for (const card of CARDS) {
    it(`${card.path} renders a real PNG`, async () => {
      const { res, buf } = await renderCard(card.path, card.query, card.params)
      assertRealPng(buf, res, card.path)
    }, 60000)
  }
})

describe("OG cards degrade to a valid card when upstreams fail", () => {
  // A dead backing API / view must still produce a renderable card. A broken
  // unfurl (or a 500 the crawler caches) is strictly worse than a generic one.
  const SAMPLE = [
    "app/api/og/insights/deals/route",
    "app/api/og/insights/squeeze/route",
    "app/api/og/insights/top-sales/route",
    "app/api/og/team/route",
    "app/api/og/collection/route",
  ]

  for (const path of SAMPLE) {
    it(`${path} still renders when the upstream throws`, async () => {
      stubFetch(async () => {
        throw new Error("upstream down")
      })
      vi.doMock("@/lib/supabase", () => {
        const dead = {
          from: () => {
            throw new Error("view unavailable")
          },
          rpc: async () => ({ data: null, error: { message: "timeout" } }),
        }
        return { supabaseAdmin: dead, supabase: dead, default: dead }
      })

      const query = path.includes("/team/")
        ? "?collection=nba-top-shot&slug=portland-trail-blazers"
        : path.includes("/collection/")
          ? "?slug=nba-top-shot"
          : ""
      const { res, buf } = await renderCard(path, query)
      assertRealPng(buf, res, path)
    }, 60000)
  }

  it("renders when the upstream returns a non-ok status", async () => {
    stubFetch(async () => new Response("nope", { status: 503 }))
    const { res, buf } = await renderCard("app/api/og/insights/deals/route")
    assertRealPng(buf, res, "app/api/og/insights/deals/route")
  }, 60000)

  it("renders when the upstream returns an empty board", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, rows: [], data: [], items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const { res, buf } = await renderCard("app/api/og/insights/deals/route")
    assertRealPng(buf, res, "app/api/og/insights/deals/route")
  }, 60000)
})

describe("data-rich cards actually TAKE their data branch", () => {
  // The sweep above proves every card emits a valid PNG. It cannot, on its own,
  // prove the card USED its data: a card whose upstream shape it does not
  // recognise falls back to generic copy and still returns a perfectly good
  // 1200x630 PNG. That is not hypothetical — it is why these cards sat at
  // 20-40% function coverage while every byte assertion was green.
  //
  // So for the cards carrying real per-card formatters, render TWICE — once with
  // the populated fixture, once with a dead upstream — and require the two to
  // differ. Identical bytes mean the populated render produced the fallback
  // card, i.e. the data path is dead.
  const DATA_CARDS: Array<{ path: string; query?: string; params?: Record<string, string> }> = [
    { path: "app/api/og/insights/market/route" },
    { path: "app/api/og/insights/cross-collection/route" },
    { path: "app/api/og/insights/route" },
    { path: "app/api/og/insights/market-pulse/route" },
    { path: "app/api/og/insights/pack-sniper/route" },
    { path: "app/api/og/insights/pack-drops/route" },
    { path: "app/api/og/insights/first-mint/route" },
    { path: "app/api/og/insights/deals/route" },
    { path: "app/api/og/profile/[username]/route", params: { username: "trevor" } },
    { path: "app/api/og/pack/lifecycle/route", query: "?id=1" },
  ]

  for (const card of DATA_CARDS) {
    it(`${card.path} renders differently with data than without`, async () => {
      const populated = await renderCard(card.path, card.query, card.params)
      assertRealPng(populated.buf, populated.res, card.path)

      // Same card, every upstream dead.
      vi.resetModules()
      stubFetch(async () => {
        throw new Error("upstream down")
      })
      vi.doMock("@/lib/supabase", () => {
        const dead = {
          from: () => {
            throw new Error("view unavailable")
          },
          rpc: async () => ({ data: null, error: { message: "down" } }),
        }
        return { supabaseAdmin: dead, supabase: dead, default: dead }
      })
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({ rpc: async () => ({ data: null, error: { message: "down" } }) }),
      }))
      const fallback = await renderCard(card.path, card.query, card.params)
      assertRealPng(fallback.buf, fallback.res, card.path)

      expect(
        populated.buf.length,
        `${card.path} rendered byte-identically with and without data — its data ` +
          `branch is dead and the card is silently serving fallback copy.`
      ).not.toBe(fallback.buf.length)
    }, 60000)
  }
})
