import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/sniper-feed — ASK_ONLY rows must carry the "⚠ thin data" caveat.
//
// THE DEFECT (fixed 2026-08-04):
//
// An ASK_ONLY FMV is literally `0.90 x a single seller's ask` — it has no
// corroborating sale at all (see lib/fmv-basis.ts and app/api/fmv-recalc).
// So a discount computed against it is ask-vs-ask, not a deal: a stale $700
// ask becomes a $630 "FMV", and a fresh $12 listing then renders "−98% off".
//
// app/api/market/route.ts already guards this on BOTH of its paths:
//     lowConfidenceFmv: g.lowConfidenceFmv || confidence === "ASK_ONLY"
// and __tests__/api-market.test.ts pins it. The sniper — the surface where a
// fake bargain is most actionable — never got the same rule. It keyed the
// caveat off the display guard ALONE, and the guard table only carries
// editions it has already independently flagged.
//
// Measured on live prod 2026-08-04: 3,137 Top Shot editions are ASK_ONLY and
// 2,592 of them (82.6%) are absent from topshot_fmv_display_guard — i.e. four
// out of five ask-derived rows rendered a hard discount percentage on the
// sniper while the identical row on the market rendered "⚠ thin data".
//
// The third path (the Top Shot GQL leg) was worse still: it never set
// lowConfidenceFmv at ALL, so the flag was `undefined` → falsy → no caveat
// regardless of the guard.
//
// These tests mock guardTopshotFmv to ALWAYS return lowConfidenceFmv:false,
// which is what isolates the fix — with the guard contributing nothing, the
// flag can only come from the confidence value.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, any> }))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => factory(),
  deleteCache: () => {},
}))

// makeSupabaseFixture captures its fixtures object BY REFERENCE — hand it a
// live Proxy view of fx.tables (see api-sniper-feed-badge-join.test.ts).
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: makeSupabaseFixture(
    new Proxy({} as Record<string, any>, {
      get: (_t, k: string) => fx.tables[k],
      has: (_t, k: string) => k in fx.tables,
      ownKeys: () => Reflect.ownKeys(fx.tables),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  ),
}))

// THE ISOLATING MOCK: the display guard never flags anything here, so any
// lowConfidenceFmv:true in the assertions below is attributable solely to the
// ASK_ONLY rule under test. If the fix is reverted these all read false.
vi.mock("@/lib/fmv-display-guard", () => ({
  loadTopshotFmvGuard: async () => new Map(),
  guardTopshotFmv: (_m: unknown, _k: unknown, fmv: number) => ({
    effectiveFmv: fmv,
    lowConfidenceFmv: false,
  }),
}))

const { GET } = await import("@/app/api/sniper-feed/route")
const get = (qs = "") => new Request(`https://t/api/sniper-feed${qs}`)

function rpcDeal(momentId: string, over: Record<string, unknown> = {}) {
  return {
    flow_id: `F-${momentId}`,
    moment_id: momentId,
    player_name: `Player ${momentId}`,
    team_name: "",
    set_name: "Base Set",
    series_name: "4",
    tier: "COMMON",
    circulation_count: 1000,
    serial_number: null,
    // A deep "discount" is the whole point: ask $12 against a $630 ask-derived
    // FMV is the exact fake bargain this caveat exists to defuse.
    ask_price: 12,
    fmv_usd: 630,
    confidence: "HIGH",
    thumbnail_url: null,
    listed_at: "2026-07-20T00:00:00Z",
    buy_url: "https://nbatopshot.com/x",
    listing_resource_id: null,
    ...over,
  }
}

function seed(over: Record<string, any> = {}) {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  Object.assign(fx.tables, {
    ts_listings: { data: [] },
    "rpc:get_topshot_sniper_deals": { data: [], error: null },
    badge_editions: { data: [], error: null },
    ...over,
  })
}

beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
})

const byMoment = (deals: any[]) => Object.fromEntries(deals.map((d) => [d.momentId, d]))

describe("sniper-feed — ASK_ONLY FMV is flagged thin-data even when the display guard is silent", () => {
  it("flags an ASK_ONLY RPC row and leaves a sale-backed HIGH row unflagged", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [
          rpcDeal("1:100", { confidence: "ASK_ONLY" }),
          rpcDeal("1:101", { confidence: "HIGH" }),
        ],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    const deals = byMoment(body.deals)

    // The ask-derived row: caveat shown INSTEAD of the fake discount badge.
    expect(deals["1:100"].lowConfidenceFmv).toBe(true)
    // The sale-backed row is untouched — marking every row would drown the
    // one that matters (the standing rule in lib/fmv-basis.ts).
    expect(deals["1:101"].lowConfidenceFmv).toBe(false)
  })

  it("matches on confidence case-insensitively", async () => {
    // fmv_snapshots.confidence is an UPPERCASE enum, but the sniper lowercases
    // it onto the deal and sibling paths read it from different sources. A
    // case-sensitive comparison would silently miss rows.
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:200", { confidence: "ask_only" })],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals[0].lowConfidenceFmv).toBe(true)
  })

  it("an ASK_ONLY row is excluded from the verified-deal stats it would otherwise inflate", async () => {
    // Defence in depth: lib/sniper/helpers.ts::isVerifiedDeal already gates on
    // HIGH/MEDIUM + !lowConfidenceFmv + confidenceSource !== "ask_fallback".
    // Pin that the route emits the inputs that gate relies on, so the caveat
    // and the demotion can never drift apart.
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:300", { confidence: "ASK_ONLY" })],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    const d = body.deals[0]
    expect(d.lowConfidenceFmv).toBe(true)
    expect(d.confidenceSource).toBe("ask_fallback")
    expect(String(d.confidence).toLowerCase()).toBe("ask_only")
  })
})
