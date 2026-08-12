import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"

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
 * JSON body shaped as a superset of every public-insights envelope the cards
 * consume (`rows`, `data`, `items`, plus assorted scalar summary fields).
 */
const UNIVERSAL_JSON: Record<string, unknown> = {
  ok: true,
  rows: ROWS,
  data: ROWS,
  items: ROWS,
  results: ROWS,
  editions: ROWS,
  packs: ROWS,
  sales: ROWS,
  count: ROWS.length,
  total: ROWS.length,
  meta: { coverage: { basis: "listing_gated", note: "test" } },
  summary: { ...UNIVERSAL_ROW },
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
  return url.includes("/api/")
}

function stubFetch(respond: () => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isAppApiRequest(input)) return originalFetch(input as never, init)
    return respond()
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  // Every self-fetch resolves to the universal envelope. No card in this sweep
  // may touch the network: an unstubbed fetch would make the suite dependent on
  // prod being up, and on a slow/500 upstream it would assert the WRONG card.
  stubFetch(
    async () =>
      new Response(JSON.stringify(UNIVERSAL_JSON), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  )
  installSupabaseStub()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
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
      globalThis.fetch = vi.fn(async () => {
        throw new Error("upstream down")
      }) as unknown as typeof globalThis.fetch
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
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 503 })
    ) as unknown as typeof globalThis.fetch
    const { res, buf } = await renderCard("app/api/og/insights/deals/route")
    assertRealPng(buf, res, "app/api/og/insights/deals/route")
  }, 60000)

  it("renders when the upstream returns an empty board", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, rows: [], data: [], items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch
    const { res, buf } = await renderCard("app/api/og/insights/deals/route")
    assertRealPng(buf, res, "app/api/og/insights/deals/route")
  }, 60000)
})
