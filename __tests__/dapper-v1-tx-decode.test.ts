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
