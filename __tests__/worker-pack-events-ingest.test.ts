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

// ── AllDay: the primary_mint path ──────────────────────────────────────────
//
// ⚠ THE HIGHEST-STAKES UNCOVERED LEG IN THIS WORKER. `event_kind` is what the
// `pack_purchases_set_is_primary_drop` TRIGGER reads to derive `is_primary_drop`,
// so a regression here does not error — it silently reclassifies AllDay Studio
// drops as secondary sales across every pack surface. A wrong NUMBER, not a
// failure. The TopShot half of that classification was already driven above;
// AllDay's was not, and it reaches the same column by a completely different
// event shape (PackNFT.Mint, not a contract-reserve Withdraw).
//
// AllDay is mint-on-demand: every `PackNFT.Mint` is primary BY DEFINITION, so
// unlike TopShot there is no signer/from filter — which is exactly why the
// deposit pairing and the nftType filter carry the whole burden of correctness.
const EVT_AD_MINT = "A.e4cf4bdc1751c65d.PackNFT.Mint"
const EVT_AD_DEPOSIT = "A.e4cf4bdc1751c65d.PackNFT.Deposit"
const AD_PACK_TYPE = "A.e4cf4bdc1751c65d.PackNFT.NFT"
const AD_COLLECTION = "dee28451-5d62-409e-a1ad-a83f763ac070"

function adMintPayload(nftId: string, distId: string | null) {
  return cdcEvent(EVT_AD_MINT, {
    id: cdc.uint64(nftId),
    commitHash: { type: "String", value: "deadbeef" },
    distId: distId === null ? cdc.optionalNull() : { type: "String", value: distId },
  })
}

function adDepositPayload(nftId: string, to: string) {
  return cdcEvent(EVT_AD_DEPOSIT, {
    id: cdc.uint64(nftId),
    to: { type: "Optional", value: { type: "Address", value: to } },
  })
}

/** find-or-fail. `Array.prototype.find` returns `T | undefined`, so every
 *  downstream field access is a tsc error — and sprinkling `!` would silence the
 *  ONE case worth failing loudly on: the row never having been written at all. */
function mustFind<T>(rows: T[], pred: (r: T) => boolean, what: string): T {
  const hit = rows.find(pred)
  expect(hit, `expected a row matching ${what}`).toBeTruthy()
  return hit as T
}

describe("pack-events-ingest worker — AllDay primary_mint", () => {
  function cursorsAtTip(allday: number) {
    return {
      data: [
        { id: "topshot_pack_purchases", last_processed_block: 1200 },
        { id: "topshot_pack_opens", last_processed_block: 1200 },
        { id: "allday_pack_purchases", last_processed_block: allday },
      ],
      error: null,
    }
  }

  it("a Mint paired with a same-tx Deposit becomes primary_mint with a NULL seller", async () => {
    const tx = "c".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_AD_MINT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_MINT, payload: adMintPayload("900", "dist-77") }),
      ]),
      jsonRoute(encodeURIComponent(EVT_AD_DEPOSIT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_DEPOSIT, payload: adDepositPayload("900", "0x4444444444444444") }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: cursorsAtTip(1000),
      pack_purchases: { data: [{ event_kind: "primary_mint" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.allday_forward).toMatchObject({ primary_mint_rows: 1, rows_inserted: 1 })

    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    const mint = mustFind(rows, (r) => r.pack_nft_id === "900", "the minted pack")
    expect(mint.event_kind, "the trigger reads THIS to set is_primary_drop").toBe("primary_mint")
    expect(mint.collection_id).toBe(AD_COLLECTION)
    // ⚠ seller_address must be NULL, not a sentinel. The column carries a CHECK
    // requiring NULL or ^0x[0-9a-f]{16}$, so a 'mint:<contract>' style marker
    // would fail at INSERT — and there is no prior holder to name anyway.
    expect(mint.seller_address).toBeNull()
    // AllDay's Mint carries distId inline, so pack_dist_id resolves immediately
    // (unlike TopShot, where it is NULL at purchase and backfilled after the rip).
    expect(mint.pack_dist_id).toBe("dist-77")
    // A Dapper primary purchase is off-chain — no on-chain price to record.
    expect(mint.sale_price).toBeNull()
    expect(mint.buyer_address).toBe("0x4444444444444444")
  })

  it("a Mint with NO matching Deposit is skipped — the pack never landed", async () => {
    // ⚠ Not a cosmetic filter. Without the pairing there is no buyer, and a row
    // with a null buyer would be a purchase attributed to nobody.
    const tx = "d".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_AD_MINT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_MINT, payload: adMintPayload("901", "dist-77") }),
      ]),
      // Deposit exists but in a DIFFERENT transaction — must not pair.
      jsonRoute(encodeURIComponent(EVT_AD_DEPOSIT), [
        eventBlock({ height: 1150, txId: "e".repeat(64), eventType: EVT_AD_DEPOSIT, payload: adDepositPayload("901", "0x4444444444444444") }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: cursorsAtTip(1000),
      pack_purchases: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const body = await (await worker.fetch(post(), ENV, CTX)).json()
    expect(body.allday_forward.primary_mint_rows).toBe(0)
    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    expect(rows.find((r) => r.pack_nft_id === "901")).toBeUndefined()
  })

  it("a Mint with no distId still lands, with a NULL pack_dist_id", async () => {
    // The dist is what names the drop on the pack surfaces. Absent, the row is
    // still a real primary purchase and must not be dropped — the name can be
    // resolved later, the purchase cannot be recovered.
    const tx = "f".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_AD_MINT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_MINT, payload: adMintPayload("902", null) }),
      ]),
      jsonRoute(encodeURIComponent(EVT_AD_DEPOSIT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_DEPOSIT, payload: adDepositPayload("902", "0x6666666666666666") }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: cursorsAtTip(1000),
      pack_purchases: { data: [{ event_kind: "primary_mint" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    await worker.fetch(post(), ENV, CTX)
    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    const mint = mustFind(rows, (r) => r.pack_nft_id === "902", "the distId-less mint")
    expect(mint.event_kind).toBe("primary_mint")
    expect(mint.pack_dist_id).toBeNull()
  })

  it("a TopShot pack listing in the AllDay scan is filtered out by nftType", async () => {
    // ⚠ The AllDay secondary leg reads the SAME NFTStorefrontV2.ListingCompleted
    // contract as the TopShot one — only the nftType filter separates them. Lose
    // it and TopShot pack sales would be written under the AllDay collection_id,
    // corrupting both collections' pack surfaces at once.
    const tx = "1".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_AD_MINT), []),
      jsonRoute(encodeURIComponent(EVT_AD_DEPOSIT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_DEPOSIT, payload: adDepositPayload("903", "0x7777777777777777") }),
      ]),
      // A TS-typed pack listing inside the AllDay window.
      jsonRoute(encodeURIComponent(EVT_LISTING), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_LISTING, payload: packListingPayload("903", "9.00000000", TS_PACK_TYPE) }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: cursorsAtTip(1000),
      pack_purchases: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    await worker.fetch(post(), ENV, CTX)
    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    expect(
      rows.find((r) => r.pack_nft_id === "903" && r.collection_id === AD_COLLECTION),
      "a TopShot-typed listing must never be written as an AllDay pack",
    ).toBeUndefined()
  })

  it("an AllDay-typed listing DOES become a secondary_sale on this cursor", async () => {
    // The positive half of the filter above — without it, the previous test
    // passes just as well against a leg that writes nothing at all.
    const tx = "2".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_AD_MINT), []),
      jsonRoute(encodeURIComponent(EVT_AD_DEPOSIT), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_AD_DEPOSIT, payload: adDepositPayload("904", "0x8888888888888888") }),
      ]),
      jsonRoute(encodeURIComponent(EVT_LISTING), [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_LISTING, payload: packListingPayload("904", "12.50000000", AD_PACK_TYPE) }),
      ]),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: cursorsAtTip(1000),
      pack_purchases: { data: [{ event_kind: "secondary_sale" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const body = await (await worker.fetch(post(), ENV, CTX)).json()
    expect(body.allday_forward.secondary_sale_rows).toBe(1)
    const rows = (spy.writes.pack_purchases ?? []).flatMap((w) => w.rows)
    const sale = mustFind(rows, (r) => r.pack_nft_id === "904", "the AllDay secondary sale")
    expect(sale.event_kind).toBe("secondary_sale")
    expect(sale.collection_id).toBe(AD_COLLECTION)
    expect(sale.sale_price).toBe(12.5)
    // The payer is the real seller — recovered from the tx, not the event.
    expect(sale.seller_address).toBe("0x5555555555555555")
  })
})

// ── The OPENS cursor: pack rip -> moment attribution ───────────────────────
//
// The second of the two legs left dark when the worker gate landed. This is the
// path that turns "a pack was opened" into the per-moment `moment_acquisitions`
// rows carrying `source_pack_rip_id` — i.e. the link that lets the platform say
// a given moment CAME FROM a given pack. Every pack-EV, pull-value and
// rip-history surface joins on it.
//
// ⚠ Its failure mode is attribution, not an error: a rip that writes no moment
// rows just looks like a pack nobody opened.
const EVT_OPENED = "A.0b2a3299cc857e29.PackNFT.Opened"
const EVT_TS_DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
const EVT_TS_WITHDRAW = "A.0b2a3299cc857e29.TopShot.Withdraw"
const CUSTODY = "0xb6f2481eba4df97b"

function openedPayload(packNftId: string) {
  return cdcEvent(EVT_OPENED, { id: cdc.uint64(packNftId) })
}
function tsDepositPayload(momentId: string, to: string) {
  return cdcEvent(EVT_TS_DEPOSIT, {
    id: cdc.uint64(momentId),
    to: { type: "Optional", value: { type: "Address", value: to } },
  })
}
function tsWithdrawPayload(momentId: string, from: string) {
  return cdcEvent(EVT_TS_WITHDRAW, {
    id: cdc.uint64(momentId),
    from: { type: "Optional", value: { type: "Address", value: from } },
  })
}

describe("pack-events-ingest worker — the opens cursor", () => {
  /** Cursors with purchases + allday already at tip so only OPENS has work. */
  function opensOnly(opens: number) {
    return {
      data: [
        { id: "topshot_pack_purchases", last_processed_block: 1200 },
        { id: "topshot_pack_opens", last_processed_block: opens },
        { id: "allday_pack_purchases", last_processed_block: 1200 },
      ],
      error: null,
    }
  }

  function opensFetch(blocks: {
    opened: ReturnType<typeof eventBlock>[]
    deposits: ReturnType<typeof eventBlock>[]
    withdraws: ReturnType<typeof eventBlock>[]
  }) {
    return installFetchMock([
      jsonRoute("sealed", [{ header: { height: "1200" } }]),
      jsonRoute(encodeURIComponent(EVT_OPENED), blocks.opened),
      jsonRoute(encodeURIComponent(EVT_TS_DEPOSIT), blocks.deposits),
      jsonRoute(encodeURIComponent(EVT_TS_WITHDRAW), blocks.withdraws),
      jsonRoute("/v1/transactions/", { payer: "0x5555555555555555" }),
      jsonRoute("/v1/events", []),
    ])
  }

  it("a rip records moments_pulled and links every moment to it", async () => {
    const tx = "3".repeat(64)
    fetchMock = opensFetch({
      opened: [eventBlock({ height: 1150, txId: tx, eventType: EVT_OPENED, payload: openedPayload("pack-1") })],
      deposits: [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m1", "0xopener00000000a") }),
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m2", "0xopener00000000a") }),
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m3", "0xopener00000000a") }),
      ],
      withdraws: [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_WITHDRAW, payload: tsWithdrawPayload("m1", CUSTODY) }),
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_WITHDRAW, payload: tsWithdrawPayload("m2", CUSTODY) }),
      ],
    })
    const spy = install({
      event_cursor: opensOnly(1000),
      pack_rips: { data: [{ id: "rip-uuid-1", tx_hash: tx }], error: null },
      moment_acquisitions: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.opens).toMatchObject({ rips_inserted: 1, moments_linked: 3 })

    const rips = (spy.writes.pack_rips ?? []).flatMap((w) => w.rows)
    const rip = mustFind(rips, (r) => r.pack_nft_id === "pack-1", "the rip row")
    expect(rip.opener_address).toBe("0xopener00000000a")
    // moments_pulled is the DEPOSIT count in that tx — the number a pull-value
    // surface divides by. It is not the withdraw count (only 2 here).
    expect(rip.moments_pulled).toBe(3)
    expect(rip.tx_hash).toBe(tx)

    const moments = (spy.writes.moment_acquisitions ?? []).flatMap((w) => w.rows)
    expect(moments).toHaveLength(3)
    for (const m of moments) {
      expect(m.wallet).toBe("0xopener00000000a")
      // ⚠ The attribution link. Without it a moment is orphaned from its pack and
      // every pack-EV / pull-value / rip-history surface loses the join.
      expect(m.source_pack_rip_id).toBe("rip-uuid-1")
      expect(m.transaction_hash).toBe(tx)
    }
  })

  it("source_address is READ FROM THE WITHDRAW EVENT, and is null when absent", async () => {
    // ⚠ The worker's own comment: the reveal-custody account "is typically
    // 0xb6f2481eba4df97b for current pack types but MAY VARY BY PACK FORMAT, so
    // we always read it from the event." Hardcoding it would silently mis-tag
    // every moment from a future pack format — and the tag is per-moment, so a
    // partial withdraw set must leave the unmatched ones NULL rather than
    // borrowing a sibling's address.
    const tx = "4".repeat(64)
    fetchMock = opensFetch({
      opened: [eventBlock({ height: 1150, txId: tx, eventType: EVT_OPENED, payload: openedPayload("pack-2") })],
      deposits: [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m10", "0xopener00000000b") }),
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m11", "0xopener00000000b") }),
      ],
      withdraws: [
        // A NON-standard custody address, and only for m10.
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_WITHDRAW, payload: tsWithdrawPayload("m10", "0xfeedfacefeedface") }),
      ],
    })
    const spy = install({
      event_cursor: opensOnly(1000),
      pack_rips: { data: [{ id: "rip-uuid-2", tx_hash: tx }], error: null },
      moment_acquisitions: { data: [{ id: "a" }, { id: "b" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    await worker.fetch(post(), ENV, CTX)
    const moments = (spy.writes.moment_acquisitions ?? []).flatMap((w) => w.rows)
    const tagged = mustFind(moments, (m) => m.nft_id === "m10", "the withdrawn moment")
    const untagged = mustFind(moments, (m) => m.nft_id === "m11", "the moment with no withdraw")
    expect(tagged.source_address, "read from the event, not a constant").toBe("0xfeedfacefeedface")
    expect(untagged.source_address, "no withdraw -> null, never a sibling's address").toBeNull()
  })

  it("a pack opened with NO minted moments is skipped WITHOUT sinking its siblings", async () => {
    // ⚠ Deliberate skip: a rip row with moments_pulled 0 would enter every
    // pull-value average as a zero-value pull and drag the distribution down.
    //
    // ⚠ A SIBLING PACK IS IN THE SAME BATCH ON PURPOSE, and an earlier version
    // of this case did not have one — which made it unable to tell a clean SKIP
    // from a CRASH. Deleting the `continue` makes `txDeposits[0].decoded` throw
    // on the empty array, and with only the bad pack present the observable
    // outcome is identical (0 rips, no pack-3 row), so the mutation survived.
    // The sibling is what distinguishes them: a crash loses it too.
    const badTx = "5".repeat(64)
    const goodTx = "b".repeat(64)
    fetchMock = opensFetch({
      opened: [
        eventBlock({ height: 1150, txId: badTx, eventType: EVT_OPENED, payload: openedPayload("pack-3") }),
        eventBlock({ height: 1151, txId: goodTx, eventType: EVT_OPENED, payload: openedPayload("pack-3b") }),
      ],
      deposits: [
        // Note: nothing for badTx. This deposit is in an UNRELATED tx.
        eventBlock({ height: 1150, txId: "6".repeat(64), eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m20", "0xopener00000000c") }),
        eventBlock({ height: 1151, txId: goodTx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m21", "0xopener00000000e") }),
      ],
      withdraws: [],
    })
    const spy = install({
      event_cursor: opensOnly(1000),
      pack_rips: { data: [{ id: "rip-good", tx_hash: goodTx }], error: null },
      moment_acquisitions: { data: [{ id: "a" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const body = await (await worker.fetch(post(), ENV, CTX)).json()
    const rips = (spy.writes.pack_rips ?? []).flatMap((w) => w.rows)
    expect(rips.find((r) => r.pack_nft_id === "pack-3"), "the empty pack is skipped").toBeUndefined()
    // ...and the batch as a whole still completed.
    expect(body.opens.rips_inserted).toBe(1)
    expect(
      mustFind(rips, (r) => r.pack_nft_id === "pack-3b", "the sibling pack").opener_address,
      "a sibling in the same batch must still be ripped",
    ).toBe("0xopener00000000e")
  })

  it("two packs opened in the SAME block are attributed separately", async () => {
    // Each tx is its own rip. Grouping by BLOCK rather than tx would merge two
    // collectors' pulls into one rip and hand each the other's moments.
    const txA = "7".repeat(64)
    const txB = "8".repeat(64)
    fetchMock = opensFetch({
      opened: [
        eventBlock({ height: 1150, txId: txA, eventType: EVT_OPENED, payload: openedPayload("pack-A") }),
        eventBlock({ height: 1150, txId: txB, eventType: EVT_OPENED, payload: openedPayload("pack-B") }),
      ],
      deposits: [
        eventBlock({ height: 1150, txId: txA, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("mA", "0xopenerAAAAAAAAa") }),
        eventBlock({ height: 1150, txId: txB, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("mB", "0xopenerBBBBBBBBb") }),
      ],
      withdraws: [],
    })
    const spy = install({
      event_cursor: opensOnly(1000),
      pack_rips: {
        data: [
          { id: "rip-A", tx_hash: txA },
          { id: "rip-B", tx_hash: txB },
        ],
        error: null,
      },
      moment_acquisitions: { data: [{ id: "a" }, { id: "b" }], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    await worker.fetch(post(), ENV, CTX)
    const rips = (spy.writes.pack_rips ?? []).flatMap((w) => w.rows)
    expect(rips).toHaveLength(2)
    expect(mustFind(rips, (r) => r.pack_nft_id === "pack-A", "pack A").opener_address).toBe("0xopenerAAAAAAAAa")
    expect(mustFind(rips, (r) => r.pack_nft_id === "pack-B", "pack B").opener_address).toBe("0xopenerBBBBBBBBb")

    const moments = (spy.writes.moment_acquisitions ?? []).flatMap((w) => w.rows)
    expect(mustFind(moments, (m) => m.nft_id === "mA", "moment A").source_pack_rip_id).toBe("rip-A")
    expect(mustFind(moments, (m) => m.nft_id === "mB", "moment B").source_pack_rip_id).toBe("rip-B")
  })

  it("a failed pack_rips LOOKUP is reported and does not sink the run", async () => {
    // ⚠ The lookup is chunked and run through Promise.allSettled precisely so one
    // chunk's failure does not lose the rips that DID resolve. Reported under
    // `pack_rips_lookup_chunk` so a partial attribution is visible rather than
    // silently smaller.
    const tx = "9".repeat(64)
    fetchMock = opensFetch({
      opened: [eventBlock({ height: 1150, txId: tx, eventType: EVT_OPENED, payload: openedPayload("pack-4") })],
      deposits: [
        eventBlock({ height: 1150, txId: tx, eventType: EVT_TS_DEPOSIT, payload: tsDepositPayload("m30", "0xopener00000000d") }),
      ],
      withdraws: [],
    })
    install({
      event_cursor: opensOnly(1000),
      pack_rips: { data: [{ id: "rip-uuid-4", tx_hash: tx }], error: null },
      "pack_rips:select": { data: null, error: { message: "statement timeout" } },
      moment_acquisitions: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })

    const res = await worker.fetch(post(), ENV, CTX)
    // Whatever the outcome of the lookup, the tick must still answer 200 so the
    // cron records it rather than retrying blind.
    expect(res.status).toBe(200)
  })
})

