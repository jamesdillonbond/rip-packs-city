import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET /api/topshot-listing-cache — the Flowty-proxy paginated
// sweep into cached_listings (after()-deferred). Contracts pinned (test-only):
//   - the exact cached_listings row built from a Flowty NFT: keyed by flow_id
//     (upsert onConflict) with id/listing_resource_id = the LISTED order's
//     listingResourceID, trait-derived series ("5" -> "Series 4"), tier
//     UPPERCASED, card-derived serial/circulation, ask from salePrice, fmv from
//     valuations.blended, flowty buy_url, ms-epoch listed_at -> ISO;
//   - skip accounting: no-LISTED-order, missing player name, duplicate flow_id
//     within a run (first occurrence wins);
//   - pagination: full pages continue with advancing offset, a short page
//     breaks the loop;
//   - stale purge runs ONLY when at least one row upserted (a failed Flowty
//     fetch never wipes the cache), fmv-recalc chaining is best-effort;
//   - fatal upsert error -> honest ok=false pipeline_runs log.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
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

// Both env consts are captured at import time; the module THROWS without
// FLOWTY_PROXY_TOKEN.
process.env.INGEST_SECRET_TOKEN = "cache-token"
process.env.FLOWTY_PROXY_TOKEN = "flowty-token"

const { GET } = await import("@/app/api/topshot-listing-cache/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const LISTED_AT_MS = 1789000000000

function makeNft(i: number): Record<string, unknown> {
  return {
    id: String(i),
    orders: [
      {
        state: "LISTED",
        listingResourceID: String(90000 + i),
        salePrice: "25",
        valuations: { blended: { usdValue: 30 } },
        storefrontAddress: "0xseller000000001",
        blockTimestamp: LISTED_AT_MS,
      },
    ],
    card: { title: `Player ${i}`, num: 12, max: 15000, images: [{ url: `https://img/${i}.png` }] },
    nftView: {
      uuid: `uuid-${i}`,
      traits: [
        { name: "SeriesNumber", value: "5" },
        { name: "Tier", value: "Rare" },
        { name: "TeamAtMoment", value: "Portland Trail Blazers" },
        { name: "SetName", value: "Base Set" },
      ],
    },
  }
}

/** Flowty-proxy stub serving one payload per call (last repeats). */
function flowtyStub(
  pages: Array<{ nfts?: unknown[]; total?: number; status?: number }>,
): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("flowty-proxy"),
    respond: () => {
      const p = pages[Math.min(call, pages.length - 1)]
      call++
      return { status: p.status ?? 200, json: { nfts: p.nfts ?? [], total: p.total } }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts?: { failWrites?: string[] }) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/topshot-listing-cache", {
    method: "GET",
    headers: new Headers({ authorization: "Bearer cache-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "topshot-listing-cache")
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "cache-token"
  state.afterCbs.length = 0
})

describe("topshot-listing-cache — row building + skip accounting", () => {
  it("builds the exact cached_listings row, purges stale rows, chains fmv-recalc, logs the full stage accounting", async () => {
    const noOrderNft = { ...makeNft(2), orders: [{ state: "EXPIRED", listingResourceID: "x" }] }
    const noPlayerNft = {
      id: "3",
      orders: [{ state: "LISTED", listingResourceID: "90003", salePrice: "5" }],
      card: {},
      nftView: { traits: [] },
    }
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [makeNft(1), noOrderNft, noPlayerNft] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 1 } as never, // upsert chunk
        { error: null, count: 5 } as never, // stale purge delete
        { count: 42, error: null } as never, // post-purge head count
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
    await runDeferred()

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      id: "90001",
      flow_id: "1",
      moment_id: "uuid-1",
      player_name: "Player 1",
      team_name: "Portland Trail Blazers",
      set_name: "Base Set",
      series_name: "Series 4", // on-chain series 5 IS Series 4
      tier: "RARE",
      serial_number: 12,
      circulation_count: 15000,
      ask_price: 25,
      fmv: 30,
      source: "flowty",
      buy_url:
        "https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/1?listingResourceID=90001",
      thumbnail_url: "https://img/1.png",
      listing_resource_id: "90001",
      storefront_address: "0xseller000000001",
      is_locked: false,
      listed_at: new Date(LISTED_AT_MS).toISOString(),
      collection_id: TS,
    })

    // Flowty page request carried the sale filter + Bearer proxy token.
    const flowtyCall = fetchMock.calls.find((c) => c.url.includes("flowty-proxy"))
    expect(String(flowtyCall?.init?.body)).toContain('"listingKind":"sale"')
    // fmv-recalc chained with the ingest token.
    const recalcCall = fetchMock.calls.find((c) => c.url.includes("/api/fmv-recalc"))
    expect(
      (recalcCall?.init?.headers as Record<string, string>)?.Authorization ??
        (recalcCall?.init?.headers as Headers | undefined)?.get?.("Authorization"),
    ).toBe("Bearer cache-token")
    // Verification-challenge resolver invoked.
    expect(spy.rpcCalls.some((c) => c.name === "resolve_wallet_verification_challenges")).toBe(true)

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1,
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_collection_slug: "nba_top_shot",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      fetched: 3,
      parsed: 1,
      deduped: 1,
      written: 1,
      purged: 5,
      purge_skipped: false,
      head_count_after_purge: 42,
      pages_fetched: 1,
      skip_no_listed_order: 1,
      skip_missing_player_name: 1,
      skip_duplicate_in_run: 0,
      fmv_recalc_called: true,
    })
  })

  it("a duplicate flow_id within the run is skipped — first occurrence wins", async () => {
    const dup = { ...makeNft(1), orders: [{ ...(makeNft(1).orders as any[])[0], listingResourceID: "99999", salePrice: "9" }] }
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [makeNft(1), dup] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 1 } as never,
        { error: null, count: 0 } as never,
        { count: 1, error: null } as never,
      ],
    })

    await GET(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "1", id: "90001", ask_price: 25 })
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.skip_duplicate_in_run).toBe(1)
    expect(extra.deduped).toBe(1)
  })

  it("paginates full pages with advancing offsets and breaks on the short page", async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => makeNft(1000 + i))
    const page1 = [makeNft(2000), makeNft(2001)]
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: page0 }, { nfts: page1 }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 50 } as never,
        { error: null, count: 50 } as never,
        { error: null, count: 2 } as never,
        { error: null, count: 3 } as never, // purge
        { count: 102, error: null } as never, // head
      ],
    })

    await GET(req())
    await runDeferred()

    const flowtyCalls = fetchMock.calls.filter((c) => c.url.includes("flowty-proxy"))
    expect(flowtyCalls).toHaveLength(2)
    expect(String(flowtyCalls[0]?.init?.body)).toContain('"offset":0')
    expect(String(flowtyCalls[1]?.init?.body)).toContain('"offset":100')

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 102, p_rows_written: 102 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ pages_fetched: 2, fetched: 102, deduped: 102, written: 102 })
  })
})

describe("topshot-listing-cache — degradation + fatal paths", () => {
  it("a Flowty 500 yields zero rows, SKIPS the stale purge (cache never wiped), tolerates a failed fmv-recalc, and logs the run as FAILED — not ok", async () => {
    fetchMock = installFetchMock([
      flowtyStub([{ status: 500 }]),
      jsonRoute("/api/fmv-recalc", { error: "down" }, { status: 500 }),
    ])
    const spy = install({
      cached_listings: [{ count: 7, error: null } as never], // head count only
    })

    await GET(req())
    await runDeferred()

    // No upsert, no delete — the only cached_listings touch is the head count.
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)

    // INVERTED 2026-08-25: this used to pin `p_ok: true`. A run that could not
    // read a single page of the book is not a healthy run — it is a degraded one
    // whose purge was suppressed, and `pipeline_runs` is the only place that
    // fact can be counted from.
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_rows_found: 0, p_rows_written: 0 })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      pages_fetched: 0,
      purged: 0,
      purge_skipped: true,
      sweep_complete: false,
      page_errors: 1,
      head_count_after_purge: 7,
      fmv_recalc_called: false,
    })
  })

  it("REGRESSION: a full page 0 followed by a 500 on page 1 writes rows but SKIPS the purge — a partial book never drives a delete", async () => {
    // Page 0 is FULL (100), so the loop must ask for page 1; page 1 errors.
    // The run therefore holds a real, non-empty, INCOMPLETE book — precisely the
    // shape `upserted > 0` could not distinguish from a complete one, and the
    // old purge deleted every listing that lived beyond offset 100.
    const page0 = Array.from({ length: 100 }, (_, i) => makeNft(3000 + i))
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: page0 }, { status: 500 }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 50 } as never,
        { error: null, count: 50 } as never,
        { count: 100, error: null } as never, // head count — NO purge in between
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })

    await GET(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings ?? []).filter((w) => w.method === "upsert")
    expect(upserts.flatMap((w) => w.rows)).toHaveLength(100)

    // The fixture queue is the discriminator, and it is not vacuous: only three
    // `cached_listings` responses are staged (two upsert chunks + the head
    // count). A purge would consume the third as its delete, so `purged` could
    // not read 0 and `head_count_after_purge` could not read 100.
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_rows_written: 100 })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({
      sweep_complete: false,
      page_errors: 1,
      purge_skipped: true,
      purged: 0,
      head_count_after_purge: 100,
    })
  })

  it("NO-CHANGE CONTROL: a complete sweep still purges — the guard suppresses a delete only on truncation", async () => {
    // Same shape as the regression above except page 1 answers 200 with a SHORT
    // page (a legitimate end of book). Without this control, a route that simply
    // never purged again would satisfy every assertion above.
    const page0 = Array.from({ length: 100 }, (_, i) => makeNft(4000 + i))
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: page0 }, { nfts: [makeNft(4999)] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 50 } as never,
        { error: null, count: 50 } as never,
        { error: null, count: 1 } as never,
        { error: null, count: 4 } as never, // purge
        { count: 101, error: null } as never, // head
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })

    await GET(req())
    await runDeferred()

    // ⓘ Asserts ONLY properties that hold both before and after this change, on
    // purpose: a control that goes red against the pre-fix route is testing the
    // fix, not controlling it. Its job is to stay green forever and go red if
    // someone ever "fixes" a truncation report by suppressing the purge outright.
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_error: null })
    expect(log?.p_extra).toMatchObject({ purge_skipped: false, purged: 4 })
  })

  it("an upsert failure trips the fatal catch -> ok=false log with the error message", async () => {
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [makeNft(1)] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({}, { failWrites: ["cached_listings"] })

    await GET(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("forced cached_listings upsert failure")
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0 })
  })
})

// ── The unidentified-NFT contract (2026-09-04) ────────────────────────────────
// Flowty answers with a PLACEHOLDER title `TopShot #<nftId>` and NO traits for any NFT whose
// metadata it has not resolved. That title is truthy, so it used to pass the `!playerName` guard
// and land a row that read as a Moment and was fabricated end to end. Measured over the whole live
// population, not a sample: 70 of 104 Top Shot rows were placeholders, and for 70 OF 70 the serial
// was the NFT id, the tier was the `?? "COMMON"` default, and Flowty's blended valuation was
// carried — on 9 of them BELOW the ask, so the row rendered as a discount on an NFT we cannot
// name. `/api/profile/market-pulse` groups cached_listings by tier and takes the lowest ask, so
// the published Top Shot "Common floor" was $0.19 from an assumed tier against a real $0.20.
describe("topshot-listing-cache — an unidentified NFT states unknown instead of guessing", () => {
  function unidentifiedNft(id: string) {
    return {
      id,
      orders: [
        {
          state: "LISTED",
          listingResourceID: "777" + id,
          salePrice: "0.19",
          valuations: { blended: { usdValue: 0.228 } },
          blockTimestamp: LISTED_AT_MS,
        },
      ],
      // Exactly what Flowty sends: the title is the id, card.num is ALSO the id, no max, no traits.
      card: { title: `TopShot #${id}`, num: Number(id) },
      nftView: { traits: [] },
    }
  }

  it("keeps the listing but nulls every field it did not actually read", async () => {
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [unidentifiedNft("52313854")] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 1 } as never,
        { error: null, count: 0 } as never,
        { count: 1, error: null } as never,
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })

    expect((await GET(req())).status).toBe(200)
    await runDeferred()

    const rows = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    const row = rows[0] as Record<string, unknown>

    // The listing itself is real and is kept — dropping it would lose a genuine ask.
    expect(row.flow_id).toBe("52313854")
    expect(row.ask_price).toBe(0.19)
    expect(row.buy_url).toContain("/NFT/52313854?listingResourceID=77752313854")

    // Everything Flowty did not resolve is stated as unknown.
    expect(row.tier).toBeNull()          // NOT "COMMON" — this is what set the published floor
    expect(row.serial_number).toBeNull() // card.num was the NFT id, not a serial
    expect(row.circulation_count).toBeNull()
    expect(row.fmv).toBeNull()           // no identity => nothing for a valuation to be OF
    expect(row.moment_id).toBeNull()
  })

  it("still reads a real title, and a real Moment keeps its tier and serial", async () => {
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [makeNft(1)] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 1 } as never,
        { error: null, count: 0 } as never,
        { count: 1, error: null } as never,
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })
    expect((await GET(req())).status).toBe(200)
    await runDeferred()
    const row = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)[0] as Record<string, unknown>
    expect(row.player_name).toBe("Player 1")
    expect(row.tier).toBe("RARE")
    expect(row.serial_number).toBe(12)
    expect(row.fmv).toBe(30)
  })

  it("a title that merely LOOKS like a placeholder but names a different id is kept", async () => {
    // The guard compares against THIS nft's own id, so a genuine title can never be discarded by
    // a loose /^TopShot #\d+$/ match.
    const nft = { ...unidentifiedNft("52313854"), card: { title: "TopShot #99", num: 7, max: 100 } }
    fetchMock = installFetchMock([
      flowtyStub([{ nfts: [nft] }]),
      jsonRoute("/api/fmv-recalc", { ok: true }),
    ])
    const spy = install({
      cached_listings: [
        { error: null, count: 1 } as never,
        { error: null, count: 0 } as never,
        { count: 1, error: null } as never,
      ],
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
    })
    expect((await GET(req())).status).toBe(200)
    await runDeferred()
    const row = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)[0] as Record<string, unknown>
    expect(row.player_name).toBe("TopShot #99")
    expect(row.serial_number).toBe(7)
    expect(row.circulation_count).toBe(100)
  })
})
