import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/ingest/candy-offers — the Candy (Solana / Magic Eden)
// standing-offer sweep. The sweep runs inside after(). We mock the Solana seams
// (solUsd, candyMeSymbolReady) so the activities → bidder-union → offers_made →
// candy-mint-gate → upsert → deactivate ladder runs unmodified. Pinned:
//   - discovery-gate: while candyMeSymbolReady() is false the route 202s
//     discovery_pending and never schedules the sweep;
//   - happy sweep: exact `candy_offers` upsert row (SOL + USD from rate, expiry
//     unix→ISO, buyer, edition resolved wmc.edition_key → editions.external_id),
//     non-Candy offers from the same wallet filtered by the wmc-miss gate;
//   - bidder union: a buyer present only on an ACTIVE stored offer (aged out of
//     the activities window) is still re-swept via offers_made;
//   - partial-sweep safety: any per-bidder offers_made failure SKIPS the
//     stale-offer deactivation (an absence could be a fetch artifact) while the
//     expiry-based deactivation still runs;
//   - a fatal ME activities error logs ok=false.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  ready: true,
  rate: 150 as number | null,
  // When set, solUsd() never settles — simulating the class of hang that a
  // loop-checked deadline structurally cannot catch (see the watchdog test).
  hangSolUsd: false,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/solana/das", () => ({
  solUsd: () => (state.hangSolUsd ? new Promise(() => {}) : Promise.resolve(state.rate)),
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_ME_SYMBOL: "candy-mlb-icons",
  CANDY_MLB_SLUG: "candy_mlb",
  CANDY_MLB_UUID: "209ade70-32c5-4470-bc7c-4793d660f713",
  candyMeSymbolReady: () => state.ready,
}))

process.env.INGEST_SECRET_TOKEN = "candy-token"
// Real inter-request spacing would cost 250 x 150ms in the bidder-cap test,
// well past vitest's 5s per-test budget. The throttle exists for Magic Eden's
// rate limiter, which the fetch mock does not model.
process.env.CANDY_ME_THROTTLE_MS = "0"
const { POST } = await import("@/app/api/ingest/candy-offers/route")

const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
// Recent bid so the 45-day activities lookback floor never trips in tests.
const RECENT = Math.floor(Date.now() / 1000) - 3600

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/ingest/candy-offers", {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer candy-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function logRun(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "candy-token"
  state.afterCbs.length = 0
  state.ready = true
  state.rate = 150
  state.hangSolUsd = false
})

describe("candy-offers — discovery gate + auth", () => {
  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/ingest/candy-offers", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("202s discovery_pending (no after() sweep) while the ME symbol is a TODO", async () => {
    state.ready = false
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "discovery_pending", collection: "candy_mlb" })
    expect(state.afterCbs).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "candy_mlb" })
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("discovery_pending")
  })
})

describe("candy-offers — sweep ladder", () => {
  it("upserts an exact candy_offers row for a Candy-mint offer and filters non-Candy offers via the wmc gate", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", [
        { signature: "sb1", type: "bid", buyer: "bidder1", blockTime: RECENT },
        // a listing event never contributes a bidder
        { signature: "sl1", type: "list", buyer: "lister", blockTime: RECENT },
      ]),
      jsonRoute("/offers_made", [
        { pdaAddress: "pdaA", tokenMint: "mintCandy", auctionHouse: "AH1", price: 0.0035, tokenSize: 1, expiry: 1900000000 },
        // wmc-miss → not a Candy mint → filtered, never counted
        { pdaAddress: "pdaX", tokenMint: "mintOther", price: 2.5, expiry: 0 },
      ]),
    ])
    const spy = install({
      candy_offers: [
        { data: [], error: null }, // active-buyer union read (empty)
        { data: null, error: null }, // upsert
        { data: null, error: null, count: 0 }, // active-book count (ratio guard)
        { data: [{ pda_address: "pdaGone" }], error: null }, // stale deactivate
        { data: [], error: null }, // expiry deactivate
      ],
      // Mint resolution is now ONE batched read per table (see step 4b), keyed
      // by moment_id / external_id, not a per-mint lookup returning a bare value.
      wallet_moments_cache: { data: [{ moment_id: "mintCandy", edition_key: "aaron-judge" }], error: null },
      editions: { data: [{ id: "ed-judge", external_id: "aaron-judge" }], error: null },
      candy_packs: { data: [], error: null }, // mintOther is not a pack either
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const upserts = (spy.writes.candy_offers ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      pda_address: "pdaA",
      token_mint: "mintCandy",
      edition_id: "ed-judge",
      collection_id: CANDY_UUID,
      buyer: "bidder1",
      auction_house: "AH1",
      price_sol: 0.0035,
      price_usd: 0.53, // 0.0035 * 150, 2dp
      token_size: 1,
      expiry: new Date(1900000000 * 1000).toISOString(),
      is_active: true,
    })
    // first_seen_at must be omitted so the upsert preserves it on conflict.
    expect("first_seen_at" in upserts[0]).toBe(false)

    // Complete sweep → BOTH deactivation updates ran (stale + expired).
    const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2)

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 1, p_rows_skipped: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.bidders_discovered).toBe(1)
    expect(extra.bidders_swept).toBe(1)
    expect(extra.bidder_fetch_errors).toBe(0)
    expect(extra.deactivated).toBe(1) // pdaGone from the stale pass
    expect(extra.sol_usd).toBe(150)
  })

  it("re-sweeps a buyer known only from an ACTIVE stored offer (aged out of the activities window)", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", []), // no recent bid events at all
      jsonRoute("/offers_made", []),
    ])
    install({
      candy_offers: [
        { data: [{ buyer: "storedBidder" }], error: null }, // active-buyer union
        { data: [], error: null }, // stale deactivate
        { data: [], error: null }, // expiry deactivate
      ],
    })

    await POST(req())
    await runDeferred()

    const offerCalls = fetchMock.calls.filter((c) => c.url.includes("/offers_made"))
    expect(offerCalls).toHaveLength(1)
    expect(offerCalls[0].url).toContain("/wallets/storedBidder/offers_made")
  })

  it("skips stale-offer deactivation on ANY per-bidder fetch failure (partial-sweep safety); expiry pass still runs", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", [{ signature: "s", type: "bid", buyer: "bidderErr", blockTime: RECENT }]),
      jsonRoute("/offers_made", { error: "boom" }, { status: 500, ok: false }),
    ])
    const spy = install({
      candy_offers: [
        { data: [], error: null }, // active-buyer union
        // ⚠ The active-book COUNT read was MISSING from this queue, so `count`
        // came back `undefined` — a state production never produces, since a
        // successful count read always returns a number. The route now treats
        // "not a number" as an unreadable book and suppresses deactivation, so
        // the gap surfaced as a spurious ok=false. A fixture that cannot express
        // the real response shape cannot pin behaviour that depends on it.
        { data: null, error: null, count: 0 }, // active-book count (ratio guard)
        { data: [], error: null }, // expiry deactivate (the ONLY update expected)
      ],
    })

    await POST(req())
    await runDeferred()

    const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1) // stale pass gated off, expiry pass ran
    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect((log?.p_extra as Record<string, unknown>).bidder_fetch_errors).toBe(1)
  })

  it("a fatal ME activities error logs ok=false with the message", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", { error: "rate limited" }, { status: 429, ok: false }),
    ])
    const spy = install({})

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("HTTP 429")
  })
})

// ---------------------------------------------------------------------------
// Bidder-cap truncation (added 2026-07-26).
//
// MAX_BIDDERS is a lambda guard, but at 40 it bound BELOW the real bidder
// population: from 2026-07-25 06:50Z every tick logged bidders_truncated=true,
// and because deactivation is (correctly) skipped on a partial sweep, NOTHING
// was deactivated for ~42h — 6 of 17 "active" offers had not been re-verified
// since. The cap is now 250; a truncated tick must also report ok=false so the
// freeze can never again hide behind a healthy-looking offers_upserted count.
// ---------------------------------------------------------------------------
describe("candy-offers-indexer — truncation is a degraded run", () => {
  it("reports ok=false and skips deactivation when the bidder cap truncates the sweep", async () => {
    const buyers = Array.from({ length: 251 }, (_, i) => ({ buyer: `bidder${i}` }))
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    const spy = install({
      candy_offers: [{ data: buyers, error: null }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toMatch(/truncated/i)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.bidders_truncated).toBe(true)
    expect(extra.bidders_discovered).toBe(251)
    expect(extra.bidders_swept).toBe(250)
  })

  it("a bidder population under the cap sweeps clean and stays ok=true", async () => {
    const buyers = Array.from({ length: 60 }, (_, i) => ({ buyer: `bidder${i}` }))
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    const spy = install({
      candy_offers: [
        { data: buyers, error: null }, // active-buyer union
        { data: null, error: null, count: 0 }, // active-book count (ratio guard)
        { data: [] }, // stale deactivate
        { data: [] }, // expiry deactivate
      ],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    const extra = log?.p_extra as Record<string, unknown>
    // 60 discovered is exactly the population that was truncating at the old
    // cap of 40 on 2026-07-26.
    expect(extra.bidders_truncated).toBe(false)
    expect(extra.bidders_swept).toBe(60)
  })
})

// Pack-bid instrumentation (added 2026-07-27). Sealed packs share the ME
// collection with the cards, so a bid on a PACK fails the wmc card gate and is
// dropped. Pack bids are not stored yet (that needs its own table) — this
// counts them so the build/skip decision rests on a measured number.
describe("candy-offers-indexer — pack bids are counted, not silently dropped", () => {
  it("counts a bid on a known pack mint under pack_offers_seen and stores nothing", async () => {
    fetchMock = installFetchMock([
      jsonRoute("magiceden.dev", [
        { pdaAddress: "pdaP", tokenMint: "mintPack", price: 0.3, buyer: "bidder1", expiry: 0 },
      ]),
    ])
    const spy = install({
      candy_offers: [
        { data: [{ buyer: "bidder1" }], error: null }, // active-buyer union
        { data: null, error: null, count: 0 }, // active-book count (ratio guard)
        { data: [] }, // stale deactivate
        { data: [] }, // expiry deactivate
      ],
      wallet_moments_cache: { data: [], error: null }, // not a card
      candy_packs: { data: [{ token_mint: "mintPack" }], error: null }, // it IS a pack
    })

    await POST(req())
    await runDeferred()

    expect((spy.writes.candy_offers ?? []).some((w) => w.method === "upsert")).toBe(false)
    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect((log?.p_extra as Record<string, unknown>).pack_offers_seen).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Deadline bounding (added 2026-08-07).
//
// This route was KILLED at the 300s Vercel wall on every tick from 2026-08-05
// 00:50Z ("Task timed out after 300 seconds" at 00:50:33 / 06:50:33 / 12:50:33
// on 08-07). Because the sweep runs inside after(), a kill means the logging
// tail never runs at all — so the pipeline read as SILENT rather than failing,
// and candy_offers sat 64h stale with 39 rows still flagged is_active behind
// the public candy_offer_spread_board. An explicit deadline turns an invisible
// kill into a bounded, logged, partial run.
// ---------------------------------------------------------------------------
describe("candy-offers-indexer — the lambda wall is bounded by an explicit deadline", () => {
  it("stops at the deadline, reports the PARTIAL walk, and suppresses deactivation", async () => {
    // Freeze the clock, then jump it past the sweep deadline while the first
    // batch of offers_made calls is in flight. 12 bidders vs a concurrency of 4
    // makes the cut unambiguous: only the first concurrent batch can start.
    let nowMs = Date.now()
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs)
    try {
      fetchMock = installFetchMock([
        jsonRoute("/activities", []),
        {
          match: (url) => url.includes("/offers_made"),
          respond: () => {
            nowMs += 750_000 // one slow upstream call blows the whole budget
            return { json: [] }
          },
        },
      ])
      const buyers = Array.from({ length: 12 }, (_, i) => ({ buyer: `b${i}` }))
      const spy = install({
        candy_offers: [
          { data: buyers, error: null },
          { data: null, error: null, count: 0 }, // active-book count
          { data: [], error: null }, // expiry deactivate
        ],
      })

      await POST(req())
      await runDeferred()

      // Only the first concurrent batch was walked before the cut; the
      // remaining bidders are left for the next tick.
      const swept = fetchMock.calls.filter((c) => c.url.includes("/offers_made"))
      expect(swept.length).toBeLessThan(12)
      expect(swept.length).toBeLessThanOrEqual(4)

      const log = logRun(spy.rpcCalls)
      expect(log?.p_ok).toBe(false)
      expect(String(log?.p_error)).toMatch(/deadline/i)
      const extra = log?.p_extra as Record<string, unknown>
      expect(extra.deadline_hit).toBe(true)
      // ACTUAL walked count, not the intended 12 — the shortfall must be visible.
      expect(extra.bidders_swept).toBe(swept.length)
      expect(extra.bidders_eligible).toBe(12)

      // The stale-offer pass must be gated off (an unswept bidder's offers are
      // absent because we ran out of time, not because they were cancelled).
      // The expiry pass still runs — expiry is true regardless of sweep depth.
      const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
      expect(updates).toHaveLength(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  // ⚠ The deadline above is NOT sufficient on its own, and prod proved it on
  // 2026-08-07: after the deadline shipped, the route was STILL killed with
  // "Task timed out after 300 seconds". A deadline can only fire where the code
  // looks at it, so a single un-timed-out await (a hung CoinGecko call inside
  // solUsd(), a Supabase read stuck behind pooler saturation) sails past every
  // loop check and the lambda dies with after() never reaching logRun — leaving
  // NO row, i.e. the silent-failure mode this whole change set exists to kill.
  // A timer fires on the event loop while an await is still pending, so it can
  // always write the row.
  it("still writes a run row when a hang no loop check can see blocks the sweep, tagged with the phase", async () => {
    vi.useFakeTimers()
    try {
      state.hangSolUsd = true // blocks BETWEEN discovery and the bidder loop
      fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
      const spy = install({
        candy_offers: [{ data: [{ buyer: "b1" }], error: null }],
      })

      await POST(req())
      // Start the deferred sweep but do NOT await it — it never settles.
      const cbs = [...state.afterCbs]
      state.afterCbs.length = 0
      void cbs[0]()

      await vi.advanceTimersByTimeAsync(761_000)

      const log = logRun(spy.rpcCalls)
      expect(log?.p_ok).toBe(false)
      expect(String(log?.p_error)).toMatch(/watchdog/i)
      const extra = log?.p_extra as Record<string, unknown>
      expect(extra.phase).toBe("watchdog")
      // The phase marker is what turns "it hung somewhere" into an answer.
      expect(extra.hung_phase).toBe("sol_usd")
    } finally {
      vi.useRealTimers()
    }
  })

  it("sweeps least-recently-verified bidders FIRST so partial ticks cover the tail", async () => {
    // Rotation is load-bearing, not cosmetic: with a fixed order a deadline cut
    // would re-walk the same prefix every tick, the tail would never be
    // re-verified, and deactivation (suppressed on every short sweep) would
    // never run again. Fixture order is deliberately NOT the expected order.
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    install({
      candy_offers: [
        {
          data: [
            { buyer: "fresh", last_seen_at: "2026-08-07T12:00:00Z" },
            { buyer: "stalest", last_seen_at: "2026-08-01T00:00:00Z" },
            { buyer: "middling", last_seen_at: "2026-08-04T06:00:00Z" },
          ],
          error: null,
        },
        { data: null, error: null, count: 0 },
        { data: [], error: null },
        { data: [], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const swept = fetchMock.calls
      .filter((c) => c.url.includes("/offers_made"))
      .map((c) => c.url.split("/wallets/")[1].split("/")[0])
    expect(swept).toEqual(["stalest", "middling", "fresh"])
  })
})

// ---------------------------------------------------------------------------
// Batched mint resolution (added 2026-08-08).
//
// Until this change the Candy-mint gate ran up to THREE sequential Supabase
// round-trips PER DISTINCT MINT, inside the bidder walk, none timeout-bounded.
// On 08-08 00:50Z the watchdog caught the sweep hung in phase "bidder_sweep"
// with deadline_hit=false at 760s — blocked inside a single un-timed-out await
// no loop check could reach. Meanwhile 78% of the PUBLIC offer book (39 of 50
// active offers) had gone 3+ days unverified, because a partial sweep correctly
// refuses to deactivate. Resolution now happens in one batched pass AFTER the
// walk, so the sweep phase issues no DB calls at all.
// ---------------------------------------------------------------------------
describe("candy-offers-indexer — mints resolve in ONE batched pass, not per mint", () => {
  it("resolves every distinct mint from a single read per table", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", [{ signature: "s", type: "bid", buyer: "bidder1", blockTime: RECENT }]),
      jsonRoute("/offers_made", [
        { pdaAddress: "pdaA", tokenMint: "mintA", price: 0.5, expiry: 0 },
        { pdaAddress: "pdaB", tokenMint: "mintB", price: 0.6, expiry: 0 },
      ]),
    ])
    // The fixture stub ignores `.in()` filters, so a chunked read still SEES all
    // rows — meaning an empty second entry cannot distinguish batched from
    // per-mint. The second entry is therefore POISONED: consuming it (i.e.
    // issuing more than one read) remaps mintB to a key that resolves to no
    // edition. Batched → mintB keeps ed-b; un-batched → mintB collapses to null.
    const spy = install({
      candy_offers: [
        { data: [], error: null }, // active-buyer union
        { data: null, error: null }, // upsert
        { data: null, error: null, count: 0 }, // active-book count
        { data: [], error: null }, // stale deactivate
        { data: [], error: null }, // expiry deactivate
      ],
      wallet_moments_cache: [
        {
          data: [
            { moment_id: "mintA", edition_key: "k-a" },
            { moment_id: "mintB", edition_key: "k-b" },
          ],
          error: null,
        },
        { data: [{ moment_id: "mintB", edition_key: "POISON-second-read" }], error: null },
      ],
      editions: [
        {
          data: [
            { id: "ed-a", external_id: "k-a" },
            { id: "ed-b", external_id: "k-b" },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      candy_packs: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = (spy.writes.candy_offers ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(upserts.map((r) => r.pda_address).sort()).toEqual(["pdaA", "pdaB"])
    expect(upserts.find((r) => r.pda_address === "pdaA")?.edition_id).toBe("ed-a")
    // The one that bites: a second (un-batched) wmc read poisons mintB's key.
    expect(upserts.find((r) => r.pda_address === "pdaB")?.edition_id).toBe("ed-b")

    const log = logRun(spy.rpcCalls)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.distinct_mints_resolved).toBe(2)
    expect(extra.raw_offers_collected).toBe(2)
    expect(extra.raw_offers_capped).toBe(false)
  })
})

// Ratio guard, ported from the listings incident of 2026-07-27 (ME served 7
// listings against a 426-ask book and the card sweep deactivated 419 standing
// asks in one tick). The same shape is reachable here: every per-bidder fetch
// can "succeed" with a short answer, which looks like a complete sweep.
describe("candy-offers-indexer — degraded-sweep ratio guard", () => {
  it("suppresses deactivation when the sweep finds far fewer offers than the book it holds", async () => {
    fetchMock = installFetchMock([
      jsonRoute("magiceden.dev", [
        { pdaAddress: "pdaO", tokenMint: "mintA", price: 0.2, buyer: "bidder1", expiry: 0 },
      ]),
    ])
    const spy = install({
      // bidder discovery -> ... -> the active-book count read (80 standing)
      candy_offers: [
        { data: [{ buyer: "bidder1" }], error: null },
        { error: null },
        { data: null, error: null, count: 80 },
        { data: [] },
      ],
      wallet_moments_cache: { data: [{ moment_id: "mintA", edition_key: "candy-mlb:trout" }], error: null },
      editions: { data: [{ id: "ed-trout", external_id: "candy-mlb:trout" }], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("degraded")
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.degraded_sweep).toBe(true)
    expect(extra.active_offers_before).toBe(80)
    expect(extra.deactivated).toBe(0)
  })
})

// ⚠ THE RATIO GUARD'S ONLY INPUT IS A COUNT, AND A FAILED COUNT USED TO OPEN IT.
//
// supabase-js RESOLVES rather than throws, so a failed count comes back
// `{ count: null, error }`. `activeOffersBefore ?? 0` made `offersBefore = 0`,
// which fails `offersBefore >= SWEEP_GUARD_MIN_BOOK` — so `degradedSweep` was
// FALSE and the mass deactivation directly below it RAN. The guard written to
// stop the 2026-07-27 incident (7 listings against a 426-ask book, 419 standing
// asks killed in one tick) was reachable again through its own input.
//
// CLAUDE.md names this shape: "a guard (`?? 0` on a count makes a check fail
// OPEN)". Every sibling condition here already suppresses deactivation on
// uncertainty, so "we could not size the book" belongs with them.
//
// ⚠ Pinned as BEHAVIOUR — no stale deactivation happens — rather than on the
// wording of the message, and paired with a no-change control so "suppress
// everything always" cannot satisfy it.
describe("candy-offers-indexer — the ratio guard fails CLOSED on an unreadable book", () => {
  const oneOffer = () =>
    installFetchMock([
      jsonRoute("magiceden.dev", [
        { pdaAddress: "pdaO", tokenMint: "mintA", price: 0.2, buyer: "bidder1", expiry: 0 },
      ]),
    ])
  const resolvable = {
    wallet_moments_cache: { data: [{ moment_id: "mintA", edition_key: "candy-mlb:trout" }], error: null },
    editions: { data: [{ id: "ed-trout", external_id: "candy-mlb:trout" }], error: null },
  }

  it("suppresses the stale sweep when the active-book COUNT read errors", async () => {
    fetchMock = oneOffer()
    const spy = install({
      candy_offers: [
        { data: [{ buyer: "bidder1" }], error: null }, // active-buyer union
        { error: null },
        { data: null, count: null, error: { message: "canceling statement due to statement timeout" } },
        { data: [] }, // expiry deactivate — still allowed, expiry is absolute
      ],
      ...resolvable,
    })

    await POST(req())
    await runDeferred()

    const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
    // The EXPIRY pass may still run (an expired offer is dead regardless), but
    // the unbounded stale pass must not. One update, not two.
    expect(updates).toHaveLength(1)

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.book_size_unknown).toBe(true)
    expect(extra.deactivated).toBe(0)
    // ⚠ NULL, not 0. A fabricated zero here is indistinguishable from a
    // genuinely empty book — the one reading that makes this suppression look
    // unnecessary to whoever reads the telemetry later.
    expect(extra.active_offers_before).toBeNull()
    // The message must name the real cause, not report "against 0 active".
    expect(String(log?.p_error)).toMatch(/count could not be read/i)
    expect(String(log?.p_error)).not.toMatch(/against 0 active/)
  })

  it("suppresses it when the count is absent without an error", async () => {
    // supabase can answer without the count when the query was not a count
    // query; "not a number" is the honest test, not "error is set".
    fetchMock = oneOffer()
    const spy = install({
      candy_offers: [
        { data: [{ buyer: "bidder1" }], error: null },
        { error: null },
        { data: null, error: null }, // no `count` key at all
        { data: [] },
      ],
      ...resolvable,
    })

    await POST(req())
    await runDeferred()

    expect((spy.writes.candy_offers ?? []).filter((w) => w.method === "update")).toHaveLength(1)
    expect(((logRun(spy.rpcCalls)?.p_extra) as Record<string, unknown>).book_size_unknown).toBe(true)
  })

  it("NO-CHANGE CONTROL: a readable book with a healthy ratio still deactivates", async () => {
    // Without this, "always suppress" would satisfy both cases above and the
    // sweep would silently stop deactivating anything, forever.
    //
    // ⚠ Honest note on what this case proves: it goes red against the pre-fix
    // route only because it asserts the NEW `book_size_unknown` field — its
    // `toHaveLength(2)` half passed before. So it is a FORWARD pin guarding the
    // next change, not a third regression test. The two cases above are the
    // regressions.
    fetchMock = oneOffer()
    const spy = install({
      candy_offers: [
        { data: [{ buyer: "bidder1" }], error: null },
        { error: null },
        { data: null, error: null, count: 1 }, // book of 1, sweep found 1 → healthy
        { data: [] }, // stale deactivate
        { data: [] }, // expiry deactivate
      ],
      ...resolvable,
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.book_size_unknown).toBe(false)
    expect(extra.active_offers_before).toBe(1)
    expect(log?.p_ok).toBe(true)
    // BOTH updates ran — stale and expiry.
    expect((spy.writes.candy_offers ?? []).filter((w) => w.method === "update")).toHaveLength(2)
  })
})
