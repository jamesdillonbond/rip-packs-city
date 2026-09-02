import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { scriptResult } from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/allday-listings-retry — the listing_resolution_failures
// queue drainer for AllDay. The whole drain runs inside after(); we capture and
// replay it, pinning the drain ACCOUNTING (what resolves vs re-queues vs
// retires), not fixture echo:
//   - resolution ladder wmc -> nft_edition_map -> seller-borrow Cadence (bumped
//     cap), each rung ending in a cached_listings_v2 upsert built from the SAVED
//     event_payload (currency derivation, USD only for DUC/FUT, epoch expiry ->
//     ISO, source='direct') + resolved_at mark;
//   - the wmc_miss_historical_backfill short-circuit: Cadence-attempted AND
//     failed -> permanently retired as unresolvable_no_chain_data (the chain has
//     spoken), while the same reason WITHOUT a Cadence attempt only bumps;
//   - retry_count bump vs RETRY_COUNT_CAP retirement accounting
//     (still_unresolved / retry_count_hit_cap / rows_skipped);
//   - empty-queue early exit and the fatal path both still log_pipeline_run.

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

process.env.INGEST_SECRET_TOKEN = "ad-retry-token"

const { POST, GET } = await import("@/app/api/allday-listings-retry/route")

const AD_COLLECTION = "dee28451-5d62-409e-a1ad-a83f763ac070"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FLOW_VAULT = "A.1654653399040a61.FlowToken.Vault"
const TX = "ab".repeat(32)

function qrow(opts: {
  id: number
  flowId: string
  retry?: number
  reason?: string | null
  seller?: string | null // null = event_payload has NO storefrontAddress
  vault?: string
  price?: string
  custom?: string | null
  expiry?: string
}) {
  return {
    id: opts.id,
    collection_id: AD_COLLECTION,
    flow_id: opts.flowId,
    listing_resource_id: `LR-${opts.id}`,
    retry_count: opts.retry ?? 0,
    failure_reason: opts.reason ?? "wmc_miss",
    event_payload: {
      blockHeight: 123456,
      blockTimestamp: "2026-07-01T00:00:00Z",
      txHash: TX,
      eventIndex: 2,
      listingResourceID: `LR-${opts.id}`,
      ...(opts.seller === null ? {} : { storefrontAddress: opts.seller ?? "0xseller1" }),
      nftID: opts.flowId,
      salePrice: opts.price ?? "25.00000000",
      salePaymentVaultType: opts.vault ?? DUC_VAULT,
      customID: opts.custom ?? null,
      ...(opts.expiry !== undefined ? { expiry: opts.expiry } : {}),
    },
  }
}

/** Flow REST script stub returning each entry in order (last repeats). */
function scriptsStub(results: Array<{ value: string }>): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("/v1/scripts"),
    respond: () => {
      const r = results[Math.min(call, results.length - 1)]
      call++
      return { json: r ?? scriptResult(null) }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(token: string | null = "ad-retry-token"): NextRequest {
  return new NextRequest("https://t/api/allday-listings-retry", {
    method: "POST",
    headers: token ? new Headers({ authorization: `Bearer ${token}` }) : undefined,
  })
}

async function runDeferred() {
  for (const cb of state.afterCbs.splice(0)) await cb()
}

function terminalLog(spy: { rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> }) {
  return spy.rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A FAILED READ OR WRITE MUST NOT CLOSE A QUEUE ROW.
//
// This drain has two irreversible outcomes for a row: `resolved_at` (out of the
// queue for good) and a retry_count bump that retires it at RETRY_COUNT_CAP.
// Both used to be reachable from a FAILURE:
//   - the three ladder reads discarded supabase-js's `error` and fell through
//     `?? []`, so an unread table looked like an absent mapping and the row was
//     bumped toward retirement;
//   - the v2 upsert logged its error and carried on, and the resolved-mark then
//     ran over the WHOLE of resolvedIds — closing failure rows whose listing was
//     never written. Nothing re-derives those listings; they are simply lost.
//
// ⚠ Each case asserts the ABSENCE of the closing write, not the presence of an
// error string.
// ─────────────────────────────────────────────────────────────────────────────
describe("allday-listings-retry — a failed read or write leaves the queue row alone", () => {
  const readCases: Array<{ name: string; fixtures: Record<string, unknown>; wants: string }> = [
    {
      name: "wallet_moments_cache",
      wants: "wallet_moments_cache lookup",
      fixtures: {
        wallet_moments_cache: { data: null, error: { message: "wmc down" } },
        nft_edition_map: { data: [], error: null },
        editions: { data: [], error: null },
      },
    },
    {
      name: "nft_edition_map",
      wants: "nft_edition_map lookup",
      fixtures: {
        wallet_moments_cache: { data: [], error: null },
        nft_edition_map: { data: null, error: { message: "map down" } },
        editions: { data: [], error: null },
      },
    },
    {
      name: "editions",
      wants: "editions lookup",
      fixtures: {
        // A key IS derived, so the editions leg is actually reached.
        wallet_moments_cache: { data: [{ moment_id: "900", edition_key: "EXT-900" }], error: null },
        nft_edition_map: { data: [], error: null },
        editions: { data: null, error: { message: "editions down" } },
      },
    },
  ]

  for (const c of readCases) {
    it(`a failed ${c.name} read bumps NO retry_count and logs ok=false`, async () => {
      fetchMock = installFetchMock([scriptsStub([])])
      const spy = install({
        listing_resolution_failures: {
          data: [qrow({ id: 900, flowId: "900", retry: 9 })],
          error: null,
        },
        cached_listings_v2: { data: null, error: null },
        ...c.fixtures,
      } as Fixtures)

      await POST(req())
      await runDeferred()

      // ⛔ THE LOAD-BEARING ASSERTION. This row sits at retry_count 9, one bump
      // from permanent retirement. Nothing may touch it.
      expect(
        (spy.writes.listing_resolution_failures ?? []).filter((w) => w.method === "update"),
      ).toHaveLength(0)

      const log = terminalLog(spy)
      expect(log?.p_ok).toBe(false)
      expect(String(log?.p_error)).toContain(c.wants)
      expect(log).toMatchObject({ p_rows_written: 0, p_rows_skipped: 0 })
    })
  }

  it("a failed v2 upsert leaves the failure row OPEN — neither resolved nor bumped", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: {
        data: [qrow({ id: 901, flowId: "901", retry: 9 })],
        error: null,
      },
      wallet_moments_cache: { data: [{ moment_id: "901", edition_key: "EXT-901" }], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-901", external_id: "EXT-901" }], error: null },
      cached_listings_v2: { data: null, error: { message: "v2 write boom" } },
    } as Fixtures)

    await POST(req())
    await runDeferred()

    // The upsert WAS attempted...
    expect((spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "upsert")).toHaveLength(1)
    // ...and the failure row was left completely alone: no resolved_at (which
    // would lose the listing for good) and no retry bump (our fault, not its
    // budget). Asserted as an absence of ANY write to that table.
    expect(
      (spy.writes.listing_resolution_failures ?? []).filter((w) => w.method === "update"),
    ).toHaveLength(0)

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 0, p_ok: false })
    expect(String(log?.p_error)).toContain("cached_listings_v2 upsert row")
    expect(log?.p_extra).toMatchObject({ resolved: 0, v2_write_errors: 1 })
  })

  it("reports ZERO resolved and a failed tick when the resolved-mark UPDATE errors", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      // call#1 = queue read (ok), call#2 = the resolved-mark UPDATE (errors).
      listing_resolution_failures: [
        { data: [qrow({ id: 902, flowId: "902" })], error: null },
        { data: null, error: { message: "mark boom" } },
      ],
      wallet_moments_cache: { data: [{ moment_id: "902", edition_key: "EXT-902" }], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-902", external_id: "EXT-902" }], error: null },
      cached_listings_v2: { data: null, error: null },
    } as Fixtures)

    await POST(req())
    await runDeferred()

    // The v2 row DID land — that is reported as written — but the failure row is
    // not resolved, because the mark that resolves it failed.
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 1, p_ok: false })
    expect(String(log?.p_error)).toContain("resolved-mark failed")
    expect(log?.p_extra).toMatchObject({ resolved: 0, resolved_mark_failed: 1 })
  })
})

describe("allday-listings-retry — resolution + v2 insert contract", () => {
  it("wmc + nft_edition_map rungs resolve without Cadence; v2 rows rebuilt from event_payload (DUC -> price_usd, FLOW -> null, epoch expiry -> ISO), failures marked resolved", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: {
        data: [
          qrow({ id: 1, flowId: "555", custom: "cid-1", expiry: "1789000000" }),
          qrow({ id: 2, flowId: "666", vault: FLOW_VAULT, price: "100.00000000" }),
        ],
        error: null,
      },
      wallet_moments_cache: { data: [{ moment_id: "555", edition_key: "321" }], error: null },
      nft_edition_map: { data: [{ nft_id: "666", edition_external_id: "322" }], error: null },
      editions: {
        data: [
          { id: "uuid-321", external_id: "321" },
          { id: "uuid-322", external_id: "322" },
        ],
        error: null,
      },
      cached_listings_v2: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message: "retry queued" })
    await runDeferred()

    // Both rungs hit before Cadence: zero Flow REST spend.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    expect(upserts.find((r) => r.flow_id === "555")).toMatchObject({
      listing_resource_id: "LR-1",
      source: "direct",
      flow_id: "555",
      edition_id: "uuid-321",
      collection_id: AD_COLLECTION,
      seller_address: "0xseller1",
      price_usd: 25, // DUC is USD-equivalent
      currency: "DUC",
      custom_id: "cid-1",
      listed_at: "2026-07-01T00:00:00Z",
      expiry_at: new Date(1789000000 * 1000).toISOString(),
      completed_at: null,
      completed_status: null,
      block_height: 123456,
      tx_hash: TX,
      event_index: 2,
    })
    expect(upserts.find((r) => r.flow_id === "666")).toMatchObject({
      edition_id: "uuid-322",
      currency: "FLOW",
      price_usd: null, // FLOW is not USD-equivalent
      expiry_at: null, // no expiry in the saved payload
    })

    // Resolved rows flip resolved_at (+ last_retry_at).
    const marks = (spy.writes.listing_resolution_failures ?? []).filter(
      (w) => w.method === "update",
    )
    expect(marks).toHaveLength(1)
    expect(typeof marks[0]?.rows[0]?.resolved_at).toBe("string")
    expect(typeof marks[0]?.rows[0]?.last_retry_at).toBe("string")

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "allday-listings-retry",
      p_rows_found: 2,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: "nfl_all_day",
    })
    expect(log?.p_extra).toMatchObject({
      resolved: 2,
      still_unresolved: 0,
      retry_count_hit_cap: 0,
      unresolvable_marked: 0,
      cadence_attempted: 0,
      cadence_resolved: 0,
    })
  })

  it("both DB rungs miss -> the seller-borrow Cadence fallback resolves editionID (Address+UInt64 args) and the listing lands", async () => {
    fetchMock = installFetchMock([
      scriptsStub([scriptResult({ id: "777", editionID: "888", serialNumber: "9" })]),
    ])
    const spy = install({
      listing_resolution_failures: {
        data: [qrow({ id: 3, flowId: "777", seller: "0xselleraa" })],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-888", external_id: "888" }], error: null },
      cached_listings_v2: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const scriptCalls = fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))
    expect(scriptCalls).toHaveLength(1)
    // The borrow is keyed (seller Address, nft UInt64) — decode the JSON-CDC args.
    const body = JSON.parse(String(scriptCalls[0]?.init?.body))
    const args = (body.arguments as string[]).map((a) =>
      JSON.parse(Buffer.from(a, "base64").toString("utf8")),
    )
    expect(args).toEqual([
      { type: "Address", value: "0xselleraa" },
      { type: "UInt64", value: "777" },
    ])

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "777", edition_id: "uuid-888", source: "direct" })

    const extra = terminalLog(spy)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ resolved: 1, cadence_attempted: 1, cadence_resolved: 1 })
  })
})

describe("allday-listings-retry — retire vs re-queue accounting", () => {
  it("wmc_miss_historical_backfill + Cadence nil -> permanently retired as unresolvable_no_chain_data (NOT bumped)", async () => {
    fetchMock = installFetchMock([scriptsStub([scriptResult(null)])])
    const spy = install({
      listing_resolution_failures: {
        data: [qrow({ id: 4, flowId: "801", reason: "wmc_miss_historical_backfill", retry: 2 })],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      cached_listings_v2: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.cached_listings_v2 ?? []).toHaveLength(0)
    const updates = (spy.writes.listing_resolution_failures ?? []).filter(
      (w) => w.method === "update",
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]?.rows[0]).toMatchObject({ failure_reason: "unresolvable_no_chain_data" })
    expect(typeof updates[0]?.rows[0]?.resolved_at).toBe("string")
    // Crucially NOT a retry_count bump — the chain has spoken.
    expect(updates[0]?.rows[0]).not.toHaveProperty("retry_count")

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    expect(log?.p_extra).toMatchObject({
      resolved: 0,
      unresolvable_marked: 1,
      still_unresolved: 0,
      retry_count_hit_cap: 0,
      cadence_attempted: 1,
      cadence_resolved: 0,
    })
  })

  it("no-seller rows only BUMP (even the historical-backfill reason — no Cadence attempt, no retirement); a bump reaching 10 counts as cap-hit", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: {
        data: [
          // Historical reason but NO storefrontAddress: Cadence never attempted,
          // so the unresolvable short-circuit must NOT fire.
          qrow({ id: 10, flowId: "901", reason: "wmc_miss_historical_backfill", retry: 3, seller: null }),
          qrow({ id: 11, flowId: "902", reason: "some_other_reason", retry: 9, seller: null }),
        ],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      cached_listings_v2: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    const updates = (spy.writes.listing_resolution_failures ?? [])
      .filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
    // Two per-row bumps, no unresolvable mark, no resolved mark.
    expect(updates).toHaveLength(2)
    expect(updates.map((r) => r.retry_count).sort()).toEqual([10, 4])
    expect(updates.every((r) => !("failure_reason" in r) && !("resolved_at" in r))).toBe(true)

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 0, p_rows_skipped: 2 })
    expect(log?.p_extra).toMatchObject({
      resolved: 0,
      still_unresolved: 1, // id 10: 3 -> 4
      retry_count_hit_cap: 1, // id 11: 9 -> 10 retires
      unresolvable_marked: 0,
      cadence_attempted: 0,
    })
  })
})

describe("allday-listings-retry — control flow", () => {
  it("empty queue exits early but still logs an ok run with empty_queue", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({ listing_resolution_failures: { data: [], error: null } })

    await POST(req())
    await runDeferred()

    expect(spy.writes.cached_listings_v2 ?? []).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect(log?.p_extra).toMatchObject({ empty_queue: true })
  })

  it("a queue-fetch failure logs ok=false with the honest error", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: { data: null, error: { message: "permission denied" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("queue fetch: permission denied")
  })

  it("401s without the token (POST + GET alias) and defers nothing; GET with the token accepts", async () => {
    install({ listing_resolution_failures: { data: [], error: null } })
    expect((await POST(req(null))).status).toBe(401)
    expect((await GET(req(null))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)

    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("retry queued")
    expect(state.afterCbs).toHaveLength(1)
  })
})
