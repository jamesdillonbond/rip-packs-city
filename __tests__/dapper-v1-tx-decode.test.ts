import { describe, it, expect, vi, afterEach } from "vitest"

// Fixture-based unit tests for lib/chains/flow/dapper-v1-tx-decode.ts.
//
// These decoders recover buyer / seller / price from a raw Flow transaction by
// parsing Cadence event payloads — the source of several past data-integrity
// incidents (V2 Flowty fee-router mistaken for the buyer, split-payment sums
// mis-added, DUC gross vs downstream-split confusion). The functions themselves
// only do one `fetch` to Flow REST and are otherwise pure, so we stub global
// fetch with hand-built base64 Cadence payloads and assert the extraction +
// the split-sum sanity gate. No network.

import {
  decodeV1SaleTx,
  decodeTopShotSaleTx,
  decodeTopShotSaleTxViaSpork,
} from "@/lib/chains/flow/dapper-v1-tx-decode"

const DUC_TOKENS_WITHDRAWN = "A.ead892083b3e2c6c.DapperUtilityCoin.TokensWithdrawn"
const DUC_CONTRACT_ADDRESS = "0xead892083b3e2c6c"
const DEPOSIT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const WITHDRAW = "A.e4cf4bdc1751c65d.AllDay.Withdraw"

// ── Cadence JSON-CDC node builders (the shape lib's unwrapCdc consumes) ───────
const uint64 = (n: number | string) => ({ type: "UInt64", value: String(n) })
const addr = (a: string) => ({ type: "Address", value: a })
const ufix = (n: number) => ({ type: "UFix64", value: n.toFixed(8) })
const optional = (node: unknown) => ({ type: "Optional", value: node })

function eventNode(id: string, fields: Array<[string, unknown]>) {
  return { type: "Event", value: { id, fields: fields.map(([name, value]) => ({ name, value })) } }
}
function b64(node: unknown): string {
  return Buffer.from(JSON.stringify(node), "utf8").toString("base64")
}
function evt(type: string, node: unknown, i: number) {
  return { type, payload: b64(node), event_index: i }
}

// Stub global fetch to return a Flow REST transaction_results body.
function stubResults(events: unknown[], ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => ({ events }) }) as any),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("decodeV1SaleTx — V1 Dapper NFTStorefront sale recovery", () => {
  const config = { depositEventType: DEPOSIT, withdrawEventType: WITHDRAW, nftId: "42" }

  it("recovers buyer, seller, and gross price with no downstream splits", async () => {
    stubResults([
      evt(WITHDRAW, eventNode(WITHDRAW, [["id", uint64(42)], ["from", optional(addr("0xseller00000000"))]]), 0),
      evt(DEPOSIT, eventNode(DEPOSIT, [["id", uint64(42)], ["to", optional(addr("0xbuyer000000000"))]]), 1),
      // Only event sourced from the DUC contract account counts as gross.
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(25)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 2),
    ])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.buyer).toBe("0xbuyer000000000")
    expect(r.seller).toBe("0xseller00000000")
    expect(r.priceDuc).toBe(25)
    expect(r.priceCertain).toBe(true)
    expect(r.priceReason).toBe("matched_no_splits")
  })

  it("sums only DUC-contract-sourced events as gross and reconciles against splits", async () => {
    stubResults([
      evt(DEPOSIT, eventNode(DEPOSIT, [["id", uint64(42)], ["to", optional(addr("0xbuyer"))]]), 0),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(100)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 1),
      // Downstream TokenForwarding splits have from = nil → counted as splits.
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(95)], ["from", optional(null)]]), 2),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(5)], ["from", optional(null)]]), 3),
    ])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.priceDuc).toBe(100)
    expect(r.priceCertain).toBe(true)
    expect(r.priceReason).toBe("matched")
    expect(r.sampleAmounts).toEqual([100, 95, 5])
  })

  it("flags split-sum mismatch as uncertain and refuses to record a price", async () => {
    stubResults([
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(100)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 0),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(80)], ["from", optional(null)]]), 1),
    ])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.priceDuc).toBeNull()
    expect(r.priceCertain).toBe(false)
    expect(r.priceReason).toBe("split_sum_mismatch")
  })

  it("reports no_duc_from_contract when every DUC event is a downstream split", async () => {
    stubResults([
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(50)], ["from", optional(null)]]), 0),
    ])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.priceReason).toBe("no_duc_from_contract")
    expect(r.priceCertain).toBe(false)
  })

  it("does not attribute a buyer when the Deposit is for a different nftId", async () => {
    stubResults([
      evt(DEPOSIT, eventNode(DEPOSIT, [["id", uint64(999)], ["to", optional(addr("0xnotthebuyer"))]]), 0),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(10)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 1),
    ])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.buyer).toBeNull()
    expect(r.priceDuc).toBe(10)
  })

  it("returns tx_no_events for an empty event list", async () => {
    stubResults([])
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.priceReason).toBe("tx_no_events")
  })

  it("returns tx_fetch_failed on a non-2xx REST response", async () => {
    stubResults([], false)
    const r = await decodeV1SaleTx("0xabc", config)
    expect(r.priceReason).toBe("tx_fetch_failed")
    expect(r.priceCertain).toBe(false)
  })
})

describe("decodeTopShotSaleTx — buyer + execution accounts", () => {
  const TS_DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
  const TS_WITHDRAW = "A.0b2a3299cc857e29.TopShot.Withdraw"

  function stubTx(body: unknown, ok = true) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body }) as any))
  }

  it("recovers buyer/seller from events and payer/proposer from the envelope, normalizing hex", async () => {
    stubTx({
      // Envelope addresses arrive WITHOUT a 0x prefix and possibly upper-cased.
      payer: "1654653399040A61",
      proposal_key: { address: "18eb4ee6b3c026d2" },
      result: {
        events: [
          evt(TS_DEPOSIT, eventNode(TS_DEPOSIT, [["id", uint64(7)], ["to", optional(addr("0xBUYER0000000000"))]]), 0),
          evt(TS_WITHDRAW, eventNode(TS_WITHDRAW, [["id", uint64(7)], ["from", optional(addr("0xseller00000000"))]]), 1),
        ],
      },
    })
    const r = await decodeTopShotSaleTx("0xabc", "7")
    expect(r.ok).toBe(true)
    expect(r.buyer).toBe("0xbuyer0000000000")
    expect(r.seller).toBe("0xseller00000000")
    expect(r.payer).toBe("0x1654653399040a61")
    expect(r.proposer).toBe("0x18eb4ee6b3c026d2")
  })

  it("captures a custodial-front-end signal: payer differs from the moment recipient", async () => {
    // dapper.market pays gas for the buyer, so payer != buyer — the exact signal
    // a new-venue monitor keys on.
    stubTx({
      payer: "aaaaaaaaaaaaaaaa",
      proposal_key: { address: "aaaaaaaaaaaaaaaa" },
      result: { events: [evt(TS_DEPOSIT, eventNode(TS_DEPOSIT, [["id", uint64(7)], ["to", optional(addr("0xbuyer"))]]), 0)] },
    })
    const r = await decodeTopShotSaleTx("0xabc", "7")
    expect(r.buyer).toBe("0xbuyer")
    expect(r.payer).toBe("0xaaaaaaaaaaaaaaaa")
    expect(r.payer).not.toBe(r.buyer)
  })

  it("returns ok:false without throwing on a failed fetch", async () => {
    stubTx({}, false)
    const r = await decodeTopShotSaleTx("0xabc", "7")
    expect(r.ok).toBe(false)
    expect(r.buyer).toBeNull()
  })
})

// ── The spork lane + the payload-decode guard ────────────────────────────────
// decodeTopShotSaleTxViaSpork exists because the current mainnet REST node only
// serves the CURRENT spork (heights >= 137,390,146), so the plain decoder
// returns ok:false for the whole 2022-2024 null-buyer tail. The lane is INERT
// until an operator deploys the worker, which is precisely why it needs tests:
// nothing else would catch a regression in it before the day it is turned on.
// The contract that matters is that every failure mode returns nulls with
// ok:false rather than throwing — a throw inside the backfill loop would abort
// the whole batch instead of leaving one tx unrecovered.

const TS_DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
const TS_WITHDRAW = "A.0b2a3299cc857e29.TopShot.Withdraw"

function stubEnvelope(body: unknown, ok = true) {
  const fn = vi.fn(async () => ({ ok, json: async () => body }) as any)
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("decodeTopShotSaleTxViaSpork", () => {
  const sporkBody = (nftId: string) => ({
    payer: "1111111111111111",
    proposal_key: { address: "2222222222222222" },
    result: {
      events: [
        evt(TS_DEPOSIT, eventNode(TS_DEPOSIT, [["id", uint64(nftId)], ["to", optional(addr("0xaaaaaaaaaaaaaaaa"))]]), 0),
        evt(TS_WITHDRAW, eventNode(TS_WITHDRAW, [["id", uint64(nftId)], ["from", optional(addr("0xbbbbbbbbbbbbbbbb"))]]), 1),
      ],
    },
  })

  it("authenticates to the worker, passes the bare tx id, and parses the same envelope", async () => {
    const fn = stubEnvelope(sporkBody("77"))
    const out = await decodeTopShotSaleTxViaSpork("0xdeadbeef", "77", "https://spork.test/tx", "s3cr3t")

    expect(out).toMatchObject({
      ok: true,
      buyer: "0xaaaaaaaaaaaaaaaa",
      seller: "0xbbbbbbbbbbbbbbbb",
      payer: "0x1111111111111111",
      proposer: "0x2222222222222222",
    })
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    // The 0x prefix is stripped — the worker keys on the bare id.
    expect(url).toBe("https://spork.test/tx?tx=deadbeef")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cr3t")
  })

  it("returns nulls with ok:false on a 404 (pre-mainnet19) rather than throwing", async () => {
    stubEnvelope({}, false)
    expect(await decodeTopShotSaleTxViaSpork("abc", "77", "https://spork.test/tx", "s")).toEqual({
      ok: false, buyer: null, seller: null, payer: null, proposer: null,
    })
  })

  it("returns nulls with ok:false when the worker call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("worker unreachable") }))
    const out = await decodeTopShotSaleTxViaSpork("abc", "77", "https://spork.test/tx", "s")
    expect(out.ok).toBe(false)
    expect(out.buyer).toBeNull()
  })

  it("reports ok:true with nulls when the tx is found but carries no matching moment", async () => {
    stubEnvelope(sporkBody("999")) // a different nft id
    const out = await decodeTopShotSaleTxViaSpork("abc", "77", "https://spork.test/tx", "s")
    expect(out.ok).toBe(true) // the tx WAS decoded — it just isn't this moment's
    expect(out.buyer).toBeNull()
    expect(out.seller).toBeNull()
  })

  it("tolerates a missing execution envelope", async () => {
    stubEnvelope({ result: {} })
    const out = await decodeTopShotSaleTxViaSpork("abc", "77", "https://spork.test/tx", "s")
    expect(out).toMatchObject({ ok: true, payer: null, proposer: null })
  })
})

describe("payload decoding guards", () => {
  const config = { depositEventType: DEPOSIT, withdrawEventType: WITHDRAW, nftId: "42" }

  it("skips an undecodable event payload and still reads the good ones", async () => {
    stubResults([
      { type: DEPOSIT, payload: "!!!not-base64-json!!!", event_index: 0 },
      evt(DEPOSIT, eventNode(DEPOSIT, [["id", uint64(42)], ["to", optional(addr("0xaaaaaaaaaaaaaaaa"))]]), 1),
      evt(WITHDRAW, eventNode(WITHDRAW, [["id", uint64(42)], ["from", optional(addr("0xbbbbbbbbbbbbbbbb"))]]), 2),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(20)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 3),
    ])
    const out = await decodeV1SaleTx("tx", config)
    expect(out.buyer).toBe("0xaaaaaaaaaaaaaaaa")
    expect(out.seller).toBe("0xbbbbbbbbbbbbbbbb")
    expect(out.priceDuc).toBe(20)
  })

  it("decodes Array and Dictionary fields inside an event payload without losing the siblings", async () => {
    // Exercises unwrapCdc's container arms — a payload carrying nested
    // structures must not derail the fields the decoder actually reads.
    stubResults([
      evt(
        DEPOSIT,
        eventNode(DEPOSIT, [
          ["id", uint64(42)],
          ["to", optional(addr("0xcccccccccccccccc"))],
          ["tags", { type: "Array", value: [{ type: "String", value: "a" }, { type: "String", value: "b" }] }],
          ["meta", { type: "Dictionary", value: [{ key: { type: "String", value: "k" }, value: uint64(1) }] }],
          ["kind", { type: "Type", value: { staticType: { kind: "Resource", typeID: "A.x.Y.Z" } } }],
          ["raw", { type: "SomethingUnknown", value: "passthrough" }],
        ]),
        0,
      ),
      evt(DUC_TOKENS_WITHDRAWN, eventNode(DUC_TOKENS_WITHDRAWN, [["amount", ufix(9)], ["from", optional(addr(DUC_CONTRACT_ADDRESS))]]), 1),
    ])
    const out = await decodeV1SaleTx("tx", config)
    expect(out.buyer).toBe("0xcccccccccccccccc")
    expect(out.priceDuc).toBe(9)
  })

  it("skips an undecodable payload on the TopShot decoder too", async () => {
    stubEnvelope({
      result: {
        events: [
          { type: TS_DEPOSIT, payload: "@@@garbage@@@", event_index: 0 },
          evt(TS_WITHDRAW, eventNode(TS_WITHDRAW, [["id", uint64(42)], ["from", optional(addr("0xdddddddddddddddd"))]]), 1),
        ],
      },
    })
    const out = await decodeTopShotSaleTx("tx", "42")
    expect(out.ok).toBe(true)
    expect(out.buyer).toBeNull()
    expect(out.seller).toBe("0xdddddddddddddddd")
  })
})
