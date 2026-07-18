import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock } from "./helpers/flow-cdc-fixture"

// Deep-drive of the pack-events-ingest Cloudflare Worker — the source-of-truth
// event_kind classifier for pack_purchases (a misclassification silently
// corrupts primary/secondary attribution platform-wide). The worker module is
// runtime-agnostic (env-injected Supabase + global fetch), so the REAL handler
// runs here with no prod change and no miniflare. Pins:
//   - secondary_sale: ListingCompleted(PackNFT type, purchased) paired with the
//     same-tx PackNFT.Deposit for the buyer; seller = tx payer; DUC currency
//     derivation from the vault type;
//   - primary_withdraw: PackNFT.Withdraw ONLY when from = the contract reserve
//     address, paired deposit for the buyer, null price (off-chain Dapper);
//   - a user-to-user Withdraw and a non-pack ListingCompleted never classify;
//   - a purchase without its deposit handover never lands (not a real sale);
//   - cursor advance to tip, the (tx_hash, pack_nft_id) conflict target, and
//     the pipeline_runs telemetry;
//   - auth/health/method guards (the worker's own edge, ahead of any secret).

// The worker compiles under its own tsconfig with @cloudflare/workers-types;
// importing it here pulls it into the ROOT tsc program, which lacks that lib.
// Provide the one ambient name the module references.
declare global {
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void
    passThroughOnException(): void
  }
}

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

const worker = (await import("../workers/pack-events-ingest/index")).default

const TS_PACK_TYPE = "A.0b2a3299cc857e29.PackNFT.NFT"
const CONTRACT_RESERVE = "0x0b2a3299cc857e29"
const EVT_LISTING = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const EVT_DEPOSIT = "A.0b2a3299cc857e29.PackNFT.Deposit"
const EVT_WITHDRAW = "A.0b2a3299cc857e29.PackNFT.Withdraw"

const ENV = {
  SUPABASE_URL: "https://sb.test",
  SUPABASE_SERVICE_ROLE_KEY: "svc-key",
  INGEST_SECRET_TOKEN: "worker-token",
} as never
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never

function packListingPayload(nftId: string, price: string, typeID = TS_PACK_TYPE) {
  return cdcEvent(EVT_LISTING, {
    listingResourceID: cdc.uint64(9000),
    storefrontResourceID: cdc.uint64(1),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(typeID),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    salePaymentVaultType: cdc.nftType("A.ead892083b3e2c6c.DapperUtilityCoin.Vault"),
    commissionAmount: cdc.ufix64("1.25000000"),
    customID: cdc.optionalNull(),
  })
}

function depositPayload(nftId: string, to: string) {
  return cdcEvent(EVT_DEPOSIT, {
    id: cdc.uint64(nftId),
    to: { type: "Optional", value: { type: "Address", value: to } },
  })
}

function withdrawPayload(nftId: string, from: string) {
  return cdcEvent(EVT_WITHDRAW, {
    id: cdc.uint64(nftId),
    from: { type: "Optional", value: { type: "Address", value: from } },
  })
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function post(path = "/", token = "worker-token"): Request {
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
// Test-only: the worker guards every Flow REST fetch with
// AbortSignal.timeout(20_000). The mocked fetch resolves instantly but that
// 20s timer stays scheduled; ~12 per fetch-making test linger and, on Node
// builds where they are ref'd (Windows local; CI Linux unref's them), hang the
// vitest worker. Neutralize it to a no-timer, never-aborting signal.
const realAbortSignalTimeout = AbortSignal.timeout
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
  ;(AbortSignal as any).timeout = realAbortSignalTimeout
})
beforeEach(() => {
  ;(AbortSignal as any).timeout = () => new AbortController().signal
  fetchMock = installFetchMock([jsonRoute("sealed", [{ header: { height: "1200" } }])])
})

describe("pack-events-ingest worker — guards", () => {
  it("GET /health is unauthenticated liveness; wrong paths 405; wrong bearer 401", async () => {
    install({})
    const health = await worker.fetch(new Request("https://worker.test/health"), ENV, CTX)
    expect(health.status).toBe(200)
    expect((await health.json()).ok).toBe(true)

    expect((await worker.fetch(post("/nope"), ENV, CTX)).status).toBe(405)
    expect((await worker.fetch(post("/", "wrong"), ENV, CTX)).status).toBe(401)
  })
})

describe("pack-events-ingest worker — event_kind classification", () => {
  function liveCursors(purchases: number, opens = 1195, allday = 1200) {
    return {
      data: [
        { id: "topshot_pack_purchases", last_processed_block: purchases },
        { id: "topshot_pack_opens", last_processed_block: opens },
        { id: "allday_pack_purchases", last_processed_block: allday },
      ],
      error: null,
    }
  }

  it("classifies a marketplace pack sale as secondary_sale and a contract-reserve withdraw as primary_withdraw", async () => {
    const txSec = "a".repeat(64)
    const txPri = "b".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_LISTING), [
        eventBlock({ height: 1100, txId: txSec, eventType: EVT_LISTING, payload: packListingPayload("42", "25.00000000") }),
        // A MOMENT listing (not a pack) in the same range — must be ignored.
        eventBlock({ height: 1101, txId: txSec, eventType: EVT_LISTING, payload: packListingPayload("77", "5.00000000", "A.0b2a3299cc857e29.TopShot.NFT") }),
      ]),
      jsonRoute(encodeURIComponent(EVT_DEPOSIT), [
        eventBlock({ height: 1100, txId: txSec, eventType: EVT_DEPOSIT, payload: depositPayload("42", "0x1111111111111111") }),
        eventBlock({ height: 1102, txId: txPri, eventType: EVT_DEPOSIT, payload: depositPayload("43", "0x2222222222222222") }),
      ]),
      jsonRoute(encodeURIComponent(EVT_WITHDRAW), [
        // Primary: withdraw FROM the contract reserve.
        eventBlock({ height: 1102, txId: txPri, eventType: EVT_WITHDRAW, payload: withdrawPayload("43", CONTRACT_RESERVE) }),
        // User-to-user withdraw (a secondary transfer leg) — never primary.
        eventBlock({ height: 1103, txId: txSec, eventType: EVT_WITHDRAW, payload: withdrawPayload("42", "0x9999999999999999") }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x3333333333333333" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: liveCursors(1000),
      pack_purchases: {
        data: [{ event_kind: "secondary_sale" }, { event_kind: "primary_withdraw" }],
        error: null,
      },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.sealed_tip).toBe(1200)
    expect(body.purchases).toMatchObject({
      secondary_rows: 1,
      primary_withdraw_rows: 1,
      rows_inserted: 2,
      events_processed: 4,
      to_block: 1200,
      caught_up: true,
    })

    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    const secondary = rows.find((r) => r.pack_nft_id === "42")
    expect(secondary).toMatchObject({
      event_kind: "secondary_sale",
      buyer_address: "0x1111111111111111",
      seller_address: "0x3333333333333333", // tx payer
      sale_price: 25,
      sale_currency: "DUC",
      commission_amount: 1.25,
      tx_hash: txSec,
    })
    const primary = rows.find((r) => r.pack_nft_id === "43")
    expect(primary).toMatchObject({
      event_kind: "primary_withdraw",
      buyer_address: "0x2222222222222222",
      seller_address: CONTRACT_RESERVE, // contract reserve = "seller"
      sale_price: null, // off-chain Dapper settlement
      sale_currency: null,
      tx_hash: txPri,
    })

    // Purchases cursor advanced to tip; the conflict-safe upsert keyed writes.
    const cursorWrites = (spy.writes.event_cursor ?? []).flatMap((w) => w.rows)
    expect(cursorWrites.some((r) => r.id === "topshot_pack_purchases" && r.last_processed_block === 1200)).toBe(true)
    // Telemetry landed under the live pipeline name.
    expect(spy.rpcCalls.some((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "pack-events-ingest")).toBe(true)
  })

  it("a purchase whose pack was never deposited to the buyer does NOT land (not a real handover)", async () => {
    const tx = "c".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_LISTING), [
        eventBlock({ height: 1100, txId: tx, eventType: EVT_LISTING, payload: packListingPayload("55", "9.00000000") }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x3333333333333333" }),
      jsonRoute("/v1/events", []), // no matching deposit anywhere
    ])
    const spy = install({
      event_cursor: liveCursors(1000),
      pack_purchases: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    expect((await res.json()).ok).toBe(true)
    expect(spy.writes.pack_purchases ?? []).toHaveLength(0)
    // The cursor STILL advances — a skipped non-sale is not an error.
    const cursorWrites = (spy.writes.event_cursor ?? []).flatMap((w) => w.rows)
    expect(cursorWrites.some((r) => r.id === "topshot_pack_purchases" && r.last_processed_block === 1200)).toBe(true)
  })

  it("caught-up cursors skip scanning entirely and the run still reports ok", async () => {
    const spy = install({
      event_cursor: liveCursors(1200, 1200, 1200), // all at tip
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Only the sealed-tip probe fired — no event scans.
    expect(fetchMock!.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect(spy.writes.pack_purchases ?? []).toHaveLength(0)
  })
})
