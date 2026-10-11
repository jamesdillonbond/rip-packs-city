// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"

// 2026-09-27 — Disney Pinnacle moved off its bespoke /collection and /sniper
// pages onto the SHARED ones every collection uses ("the foundational pages
// shouldn't change between each collection" — Trevor). The bespoke pages had
// three Pinnacle facts the shared ones did not; each is pinned here so the
// move cannot silently lose them:
//
//   1. A pin opens ITS OWN page (/pinnacle/moment/<render_id>), not
//      `/moment/<id>` — a moment_id is unique only within a collection.
//   2. An unserialised edition says "not serialised", not "#-" (most Pinnacle
//      holdings are on Open / Open Event / Starter editions, which have none).
//   3. The outbound link names the pin on its own marketplace, not Top Shot.
//
// Plus the shared-table constants the move exposed on every collection: the
// "View on Top Shot" link and the Top Shot thumbnail fallback.

const state: { moments: any; editionTypes: any[]; rpcArgs: Record<string, any> } = {
  moments: { moments: [], total_count: 0 },
  editionTypes: [],
  rpcArgs: {},
}
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => { throw new Error("must not be called for Pinnacle") },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args?: any) => {
      if (args) state.rpcArgs[name] = args
      if (name === "get_wallet_moments_with_fmv") return { data: state.moments, error: null }
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: table === "pinnacle_editions" ? state.editionTypes : [], error: null }),
        eq: () => ({ single: async () => ({ data: null }) }),
        // pinnacle_serial_fmv_multipliers is read with a bare select()
        then: (resolve: any) => resolve({
          data: table === "pinnacle_serial_fmv_multipliers"
            ? [{ band: "first", multiplier: 14.45, is_reliable: true }, { band: "perfect", multiplier: 3.49, is_reliable: true }, { band: "normal", multiplier: 1, is_reliable: true }]
            : [],
          error: null,
        }),
      }),
    }),
  },
}))

import { GET } from "@/app/api/collection-moments/route"
import { serverMomentToRow } from "@/lib/collection/server-moment"
import { momentRowHref, momentMarketplaceLink } from "@/components/collection/CollectionMomentTable"
import { resolveViewUrl } from "@/lib/sniper/helpers"
import type { SniperDeal } from "@/lib/sniper/types"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const WALLET = "0x4cb602ea748b256f"

// Shaped from a live get_wallet_moments_with_fmv row (2026-09-27).
const pinRow = (over: Record<string, unknown> = {}) => ({
  moment_id: "217703303243381",
  edition_key: "WDAS-OEEV2-MNF:Embellished Enamel:1",
  render_id: "OEEV2-MNF-MIDO-E3",
  player_name: "Mickey Mouse & Donald Duck",
  set_name: "Walt Disney Animation Studios • Disney's Mickey & Friends Vol.2",
  tier: "Embellished Enamel",
  serial_number: null,
  circulation_count: 1369,
  fmv_usd: 4.054,
  low_ask: 5,
  confidence: "MEDIUM",
  thumbnail_url: "/api/public/pinnacle-image/OEEV2-MNF-MIDO-E3",
  is_locked: false,
  lock_known: true,
  ...over,
})

beforeEach(() => {
  state.moments = { moments: [], total_count: 0 }
  state.editionTypes = []
  state.rpcArgs = {}
})

describe("/api/collection-moments carries what the Pinnacle rows need", () => {
  it("passes render_id through and marks an unserialised edition type", async () => {
    state.moments = {
      moments: [
        pinRow(),
        pinRow({ moment_id: "2", edition_key: "LTD:Limited Edition:1", render_id: "R2", serial_number: 7 }),
        pinRow({ moment_id: "3", edition_key: "NEW:Mystery:1", render_id: "R3" }),
      ],
      total_count: 3,
    }
    state.editionTypes = [
      { edition_key: "WDAS-OEEV2-MNF:Embellished Enamel:1", edition_type: "Open Event Edition" },
      { edition_key: "LTD:Limited Edition:1", edition_type: "Limited Edition" },
      { edition_key: "NEW:Mystery:1", edition_type: "Some Type We Have Never Seen" },
    ]
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&collection=disney-pinnacle`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(state.rpcArgs.get_wallet_moments_with_fmv.p_collection_id).toBe("7dd9dd11-e8b6-45c4-ac99-71331f959714")
    expect(body.moments.map((m: any) => m.render_id)).toEqual(["OEEV2-MNF-MIDO-E3", "R2", "R3"])
    // true / false / null — an unknown type is "cannot say", never "not serialised".
    expect(body.moments.map((m: any) => m.is_serialised)).toEqual([false, true, null])
  })

  it("never substitutes Top Shot art for a pin without a thumbnail", async () => {
    state.moments = { moments: [pinRow({ thumbnail_url: null })], total_count: 1 }
    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&collection=disney-pinnacle`))).json()
    expect(body.moments[0].thumbnail_url).toBeNull()
  })

  it("control: Top Shot keeps its thumbnail fallback and never gets a serialisation flag", async () => {
    state.moments = { moments: [pinRow({ thumbnail_url: null, edition_key: "12:34", render_id: undefined })], total_count: 1 }
    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&collection=nba-top-shot`))).json()
    expect(body.moments[0].thumbnail_url).toContain("assets.nbatopshot.com")
    expect(body.moments[0].is_serialised).toBeNull()
    expect(body.moments[0].render_id).toBeNull()
  })

  // 2026-09-27: the #1 / perfect serial premium reaches the shared table's badge
  // (SerialFmvBadge) — the column the bespoke page had as "Serial est.".
  it("a #1 and a perfect Pinnacle serial carry the shared serial estimate; a low serial does not", async () => {
    state.moments = {
      moments: [
        pinRow({ moment_id: "a", serial_number: 1, circulation_count: 500, fmv_usd: 10, confidence: "HIGH" }),
        pinRow({ moment_id: "b", serial_number: 500, circulation_count: 500, fmv_usd: 10, confidence: "MEDIUM" }),
        pinRow({ moment_id: "c", serial_number: 3, circulation_count: 500, fmv_usd: 10, confidence: "HIGH" }),
        pinRow({ moment_id: "d", serial_number: 1, circulation_count: 500, fmv_usd: 10, confidence: "LOW" }),
      ],
      total_count: 4,
    }
    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&collection=disney-pinnacle`))).json()
    const byId = Object.fromEntries(body.moments.map((m: any) => [m.moment_id, m.serial_fmv]))
    expect(byId.a).toMatchObject({ serial_bucket: "first", estimate_usd: 144.5 })
    expect(byId.b).toMatchObject({ serial_bucket: "perfect", estimate_usd: 34.9 })
    expect(byId.c).toBeNull()
    expect(byId.d).toBeNull() // LOW-confidence base: no premium claimed
  })

  it("the client row mapper keeps both fields", () => {
    const row = serverMomentToRow({ ...(pinRow() as any), is_serialised: false })
    expect(row.renderId).toBe("OEEV2-MNF-MIDO-E3")
    expect(row.isSerialised).toBe(false)
  })
})

describe("the shared moment table's links come from the collection", () => {
  it("a pin opens its own render page", () => {
    expect(momentRowHref("disney-pinnacle", { momentId: "217703303243381", renderId: "OEEV2-MNF-MIDO-E3", editionKey: "k" }))
      .toBe("/pinnacle/moment/OEEV2-MNF-MIDO-E3")
  })
  it("a pin with no resolved render opens its legacy-key page, never /moment/<id>", () => {
    expect(momentRowHref("disney-pinnacle", { momentId: "217703303243381", renderId: null, editionKey: "A:B:1" }))
      .toBe("/pinnacle/moment/" + encodeURIComponent("A:B:1"))
  })
  it("control: other collections keep /moment/<id>", () => {
    expect(momentRowHref("nba-top-shot", { momentId: "123", renderId: null, editionKey: "1:2" })).toBe("/moment/123")
  })
  it("the outbound link names each collection's own marketplace", () => {
    expect(momentMarketplaceLink("disney-pinnacle", "9")).toEqual({ href: "https://disneypinnacle.com/pin/9", label: "View on Disney Pinnacle" })
    expect(momentMarketplaceLink("nba-top-shot", "9")).toEqual({ href: "https://nbatopshot.com/moment/9", label: "View on NBA Top Shot" })
    expect(momentMarketplaceLink("candy-mlb", "Mint1")?.label).toBe("View on Magic Eden")
    // UFC has no per-moment URL: no link, rather than a Top Shot one.
    expect(momentMarketplaceLink("ufc", "9")).toBeNull()
  })
})

describe("the shared sniper's outbound link names the pin", () => {
  const deal = (over: Partial<SniperDeal>) =>
    ({ flowId: "217703303243381", momentId: "217703303243381", buyUrl: "https://disneypinnacle.com/marketplace", ...over }) as SniperDeal
  it("goes to the pin's own page, not the marketplace landing page", () => {
    expect(resolveViewUrl(deal({}), "disney-pinnacle")).toBe("https://disneypinnacle.com/pin/217703303243381")
  })
  it("control: another collection's live listing URL still wins", () => {
    expect(resolveViewUrl(deal({ buyUrl: "https://nbatopshot.com/moment/5" }), "nba-top-shot")).toBe("https://nbatopshot.com/moment/5")
  })
})

// ── No locking on Disney Pinnacle (Trevor, 2026-09-27) ──────────────────────
// Pinnacle pins cannot be locked, yet 375 Pinnacle rows in wallet_moments_cache
// read is_locked = true from the shared lock-check lane. Every lock surface is
// therefore HIDDEN for Pinnacle — not rendered as "—", which still claims a
// lock state exists and is unknown. Each case has a Top Shot control.
import { render, cleanup } from "@testing-library/react"
import { afterEach } from "vitest"
import WalletStatRow from "@/components/wallet-stat-row"
import CollectionFilterBar from "@/components/collection/CollectionFilterBar"
import { initialCollectionView } from "@/lib/collection/view-reducer"
import { collectionHasLocking } from "@/lib/collections"
import { ownLockLabel } from "@/lib/market-format"

afterEach(() => cleanup())

describe("Disney Pinnacle shows no lock state anywhere", () => {
  it("the registry says Pinnacle, Golazos, UFC and Candy have no lock UI and the rest do", () => {
    // Re-pinned 2026-10-10 (premise changed, not inverted): Golazos and UFC
    // were verified on mainnet to have no locking at all — see the comment on
    // COLLECTIONS_WITHOUT_LOCKING in lib/collections.ts. Top Shot and All Day
    // still exercise the `true` side. Candy MLB joined the same day (Trevor:
    // Candy cards cannot be locked).
    for (const c of ["disney-pinnacle", "laliga-golazos", "ufc", "candy-mlb"]) expect(collectionHasLocking(c)).toBe(false)
    for (const c of ["nba-top-shot", "nfl-all-day"]) expect(collectionHasLocking(c)).toBe(true)
  })

  const statRow = (slug: string) =>
    render(
      <WalletStatRow
        walletFmv={420.04} unlockedFmv={420.04} lockedFmv={0} bestOfferTotal={30}
        momentCount={218} unlockedCount={212} lockedCount={6} spreadGap={10}
        collectionSlug={slug}
      />,
    ).container.textContent ?? ""

  it("the wallet stat row has no Unlocked / Locked tiles on Pinnacle", () => {
    const text = statRow("disney-pinnacle")
    expect(text).toMatch(/Wallet FMV/)
    expect(text).toMatch(/Best Offer Total/)
    expect(text).not.toMatch(/locked/i)
  })
  it("control: Top Shot keeps both tiles", () => {
    const text = statRow("nba-top-shot")
    expect(text).toMatch(/Unlocked FMV/)
    expect(text).toMatch(/Locked FMV/)
    expect(text).toMatch(/6 locked/)
  })

  const filterBar = (slug: string) =>
    render(
      <CollectionFilterBar
        view={initialCollectionView} dispatchView={() => {}}
        availablePlayers={["all"]} availableSets={["all"]} availableSeries={["all"]} availableRarities={["all"]}
        collectionSlug={slug}
      />,
    ).container.textContent ?? ""

  it("the filter bar offers no lock filter on Pinnacle, and speaks Pinnacle", () => {
    const text = filterBar("disney-pinnacle")
    expect(text).not.toMatch(/Lock States|Locked|Unlocked/)
    expect(text).toMatch(/All Characters/)
    expect(text).toMatch(/All Variants/)
  })
  it("control: Top Shot keeps its lock filter and wording", () => {
    const text = filterBar("nba-top-shot")
    expect(text).toMatch(/All Lock States/)
    expect(text).toMatch(/All Players/)
    expect(text).toMatch(/All Rarities/)
  })

  it("the market's own count drops the lock half on Pinnacle only", () => {
    expect(ownLockLabel({ owned: 3, locked: 2 }, collectionHasLocking("disney-pinnacle"))).toBe("3")
    expect(ownLockLabel({ owned: 3, locked: 2 }, collectionHasLocking("nba-top-shot"))).toBe("3 / 2")
    expect(ownLockLabel({ owned: 3, locked: 2 })).toBe("3 / 2")
  })
})
