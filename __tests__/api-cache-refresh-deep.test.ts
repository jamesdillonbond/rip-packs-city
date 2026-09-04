import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
} from "./helpers/route-harness"

// Deep-drive of GET /api/cache-refresh — the own-wallet wmc refresh (on-chain
// diff -> stub insert -> metadata enrichment). Pins:
//   - the on-chain vs cache diff drives stub upserts on the 3-column conflict
//     target (the 2026-05-06 wmc unique-constraint shape);
//   - new moments get an 'unknown' moment_acquisitions row ONLY when none exists
//     (never clobbering real marketplace attribution);
//   - the May-9 dedup rule: enrichment prefers the CANONICAL editions.external_id
//     over the raw int "set:play" key built from chain metadata;
//   - isLocked flows from GQL into the wmc update; refreshLocked=1 backfills it
//     across the cached set;
//   - guard/degradation contracts (400s, FCL failure -> 502, empty wallet).

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as string[],
  fclThrows: false,
  metadataById: {} as Record<string, Record<string, string>>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (state.fclThrows) throw new Error("access node down")
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const meta = state.metadataById[collected[1]]
      if (!meta) throw new Error("no nft")
      return meta
    },
  },
}))

const { GET } = await import("@/app/api/cache-refresh/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const WALLET = "0xbd94cade097e50ac"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs: string): NextRequest {
  return new NextRequest(`https://t/api/cache-refresh${qs}`, { method: "GET" })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.ownedIds = []
  state.fclThrows = false
  state.metadataById = {}
  fetchMock = installFetchMock([
    jsonRoute("public-api.nbatopshot.com", {
      data: { getMintedMoment: { data: { flowId: "102", tier: "TIER_COMMON", isLocked: true } } },
    }),
  ])
})

describe("cache-refresh — guards + degradation", () => {
  it("400s without a 0x wallet and on an unsupported collection", async () => {
    install({})
    expect((await GET(req(""))).status).toBe(400)
    expect((await GET(req("?wallet=notawallet"))).status).toBe(400)
    expect((await GET(req(`?wallet=${WALLET}&collection=disney-pinnacle`))).status).toBe(400)
  })

  it("502s when the on-chain id walk fails (never a false-empty wallet)", async () => {
    state.fclThrows = true
    install({})
    const res = await GET(req(`?wallet=${WALLET}`))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("on-chain IDs")
  })

  it("an empty wallet returns ok with zero counts and touches nothing", async () => {
    const spy = install({})
    const res = await GET(req(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, total_on_chain: 0, new_stubs_inserted: 0 })
    expect(Object.keys(spy.writes)).toHaveLength(0)
  })
})

describe("cache-refresh — diff + enrichment", () => {
  it("inserts stubs for new moments, seeds unknown acquisitions, and enriches with the canonical edition key", async () => {
    state.ownedIds = ["101", "102"]
    state.metadataById["102"] = {
      player: "Damian Lillard",
      team: "Portland Trail Blazers",
      setName: "Base Set",
      series: "5",
      serial: "12",
      mint: "15000",
      playID: "45",
      setID: "3",
      tier: "Common",
    }
    const spy = install({
      wallet_moments_cache: [
        { data: [{ moment_id: "101" }], error: null }, // cached-id lookup: 101 known, 102 new
        { count: 1, error: null } as never, // last_seen_at touch
        { data: null, error: null }, // stub upsert ack
        { data: null, error: null }, // enrichment update ack
      ],
      moment_acquisitions: { data: [], error: null }, // no existing attribution
      // The canonical row for 3:45 is UUID-keyed -> enrichment must prefer it.
      editions: {
        data: [{ external_id: "set-uuid-9:play-uuid-9", set_id_onchain: 3, play_id_onchain: 45 }],
        error: null,
      },
    })

    const res = await GET(req(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      total_on_chain: 2,
      total_cached: 2, // 1 already cached + 1 fresh stub
      new_stubs_inserted: 1,
      enriched: 1,
      last_seen_touched: 1,
    })

    // Stub upsert used the 3-column conflict shape (wallet, collection, moment).
    const stub = spy.writes.wallet_moments_cache?.find((w) => w.method === "upsert")
    expect(stub?.rows[0]).toMatchObject({
      moment_id: "102",
      wallet_address: WALLET,
      collection_id: TOPSHOT,
    })

    // A fresh 'unknown' acquisition row — traceable to this writer.
    const acq = spy.writes.moment_acquisitions?.find((w) => w.method === "insert")
    expect(acq?.rows[0]).toMatchObject({
      nft_id: "102",
      wallet: WALLET,
      acquisition_method: "unknown",
      transaction_hash: "cache-refresh:102",
      source: "cache_refresh",
    })

    // Enrichment landed the CANONICAL edition key (not the raw "3:45"),
    // the parsed serial, and the GQL isLocked flag.
    const enrich = spy.writes.wallet_moments_cache
      ?.filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
      .find((r) => "edition_key" in r)
    expect(enrich).toMatchObject({
      edition_key: "set-uuid-9:play-uuid-9",
      player_name: "Damian Lillard",
      serial_number: 12,
      is_locked: true,
      tier: "Common",
    })
  })

  it("does NOT seed an acquisition row when one already exists for the nft (attribution never clobbered)", async () => {
    state.ownedIds = ["102"]
    state.metadataById["102"] = {
      player: "X", team: "", setName: "", series: "", serial: "1", mint: "", playID: "45", setID: "3", tier: "",
    }
    const spy = install({
      wallet_moments_cache: [
        { data: [], error: null },
        { count: 0, error: null } as never,
        { data: null, error: null },
        { data: null, error: null },
      ],
      moment_acquisitions: { data: [{ nft_id: "102" }], error: null }, // real attribution exists
      editions: { data: [], error: null },
    })

    await GET(req(`?wallet=${WALLET}`))
    expect(spy.writes.moment_acquisitions ?? []).toHaveLength(0)
  })

  it("refreshLocked=1 refreshes the STALEST held moments and stamps lock_checked_at", async () => {
    state.ownedIds = ["101"]
    const spy = install({
      wallet_moments_cache: [
        { data: [{ moment_id: "101" }], error: null }, // diff lookup
        { count: 1, error: null } as never, // last_seen touch
        // step-7 stalest-first query: returns the stale rows AND the exact stale count
        { data: [{ moment_id: "101" }], count: 1, error: null } as never,
        { data: null, error: null }, // is_locked + lock_checked_at update ack
      ],
    })

    const res = await GET(req(`?wallet=${WALLET}&refreshLocked=1`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.locked_backfill).toMatchObject({ total: 1, locked: 1, remaining: 0 })

    // The step-7 write now carries BOTH is_locked and a fresh lock_checked_at stamp,
    // so an on-demand refresh is a real freshness check (not a value-only poke).
    const lockedUpdate = spy.writes.wallet_moments_cache
      ?.filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
      .find((r) => "is_locked" in r && "lock_checked_at" in r)
    expect(lockedUpdate?.is_locked).toBe(true)
    expect(typeof lockedUpdate?.lock_checked_at).toBe("string")
  })

  it("refreshLocked=1 early-outs (no GQL, no write) when the wallet has no stale locks", async () => {
    state.ownedIds = ["101"]
    const spy = install({
      wallet_moments_cache: [
        { data: [{ moment_id: "101" }], error: null }, // diff lookup
        { count: 1, error: null } as never, // last_seen touch
        // step-7: zero stale rows -> the fresh-wallet early-out (cheap, no GQL)
        { data: [], count: 0, error: null } as never,
      ],
    })

    const res = await GET(req(`?wallet=${WALLET}&refreshLocked=1`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.locked_backfill).toMatchObject({ total: 0, locked: 0, remaining: 0 })

    // No lock write happened — the fresh wallet cost only the one stale-count query.
    const lockedUpdate = spy.writes.wallet_moments_cache
      ?.filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
      .find((r) => "lock_checked_at" in r)
    expect(lockedUpdate).toBeUndefined()
  })
})

// ── 2026-09-03: a failed stale-row count leaves `remaining` UNKNOWN ─────────────
//
// The client reads `locked_backfill.remaining` to decide whether to schedule
// another pass. supabase-js returns a timed-out count as `{ count: null, error }`,
// and `(Number(null) || 0) - total` clamped that to 0 — "every locked-status row on
// this wallet is fresh now", manufactured from the outage. null does not fire the
// client's `> 0` check and does not claim completion either.
describe("GET /api/cache-refresh — refreshLocked=1 with a FAILED stale count", () => {
  it("reports remaining: null, not 0", async () => {
    state.ownedIds = ["101"]
    install({
      wallet_moments_cache: [
        { data: [{ moment_id: "101" }], error: null }, // diff lookup
        { count: 1, error: null } as never, // last_seen touch
        // step-7: the count itself failed
        { data: null, count: null, error: { message: "canceling statement due to statement timeout" } } as never,
      ],
    })

    const res = await GET(req(`?wallet=${WALLET}&refreshLocked=1`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.locked_backfill.remaining).toBeNull()
    expect(body.locked_backfill.remaining).not.toBe(0)
    expect(body.locked_backfill.total).toBe(0)
  })
})
