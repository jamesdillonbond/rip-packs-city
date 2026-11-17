import { describe, it, expect } from "vitest"
import {
  decodeCounterparties,
  decodePayload,
  fields,
  type CdcEvent,
} from "../workers/sales-counterparty-backfill/decode"

// Unit tests for the sales-counterparty-backfill decoder — the logic that decides
// which buyer/seller gets written into the partitioned `sales` table. These pin
// the three rules the worker's own comments call out as landmines:
//   1. SELLER comes from the collection's <TopShot|AllDay|UFC_NFT>.Withdraw.from,
//      NOT from NonFungibleToken.Withdrawn or the FungibleToken money legs.
//   2. BUYER comes from a TopShot.Deposit ONLY — AllDay/UFC deposit to a Dapper
//      custodian and MUST leave buyer NULL (the most dangerous mis-write).
//   3. A multi-moment tx writes NOTHING rather than mis-attribute.

// ── JSON-CDC fixture builders ────────────────────────────────────────────────

const TS = "A.0b2a3299cc857e29.TopShot"
const ALLDAY = "A.e4cf4bdc1751c65d.AllDay"
const UFC = "A.329feb3ab062d289.UFC_NFT"
const MOMENT_PURCHASED = "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased"

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
}

/** An Optional<Address> field, the on-chain shape of Withdraw.from / Deposit.to. */
function optAddr(name: string, addr: string | null) {
  return { name, value: { type: "Optional", value: addr == null ? null : { type: "Address", value: addr } } }
}

/** Build an event `{type, payload}` whose base64 JSON-CDC carries the given fields. */
function event(typeId: string, fieldList: unknown[]): CdcEvent {
  return { type: typeId, payload: b64({ type: "Event", value: { id: typeId, fields: fieldList } }) }
}

const tsWithdraw = (from: string | null) => event(`${TS}.Withdraw`, [optAddr("from", from)])
const tsDeposit = (to: string | null) => event(`${TS}.Deposit`, [optAddr("to", to)])
const alldayWithdraw = (from: string) => event(`${ALLDAY}.Withdraw`, [optAddr("from", from)])
const alldayDeposit = (to: string) => event(`${ALLDAY}.Deposit`, [optAddr("to", to)])
const ufcWithdraw = (from: string) => event(`${UFC}.Withdraw`, [optAddr("from", from)])
const momentPurchased = (seller: string) => event(MOMENT_PURCHASED, [optAddr("seller", seller)])
// Money/standard legs that must be IGNORED by the seller regex.
const nftWithdrawn = (from: string) => event("A.1d7e57aa55817448.NonFungibleToken.Withdrawn", [optAddr("from", from)])
const flowTokensWithdrawn = (from: string) =>
  event("A.1654653399040a61.FlowToken.TokensWithdrawn", [optAddr("from", from)])

const SELLER = "0x1111111111111111"
const BUYER = "0x2222222222222222"
const CUSTODIAN = "0xddfbe848a81b2236" // the AllDay Dapper intermediate — must never be a buyer

describe("decodeCounterparties — Top Shot recovers both sides", () => {
  it("reads seller from TopShot.Withdraw.from and buyer from TopShot.Deposit.to", () => {
    expect(decodeCounterparties([tsWithdraw(SELLER), tsDeposit(BUYER)])).toEqual({
      seller: SELLER,
      buyer: BUYER,
    })
  })

  it("MomentPurchased.seller takes precedence over the Withdraw seller (corroboration wins)", () => {
    const mpSeller = "0x3333333333333333"
    expect(decodeCounterparties([tsWithdraw(SELLER), momentPurchased(mpSeller), tsDeposit(BUYER)])).toEqual({
      seller: mpSeller,
      buyer: BUYER,
    })
  })
})

describe("decodeCounterparties — the AllDay/UFC custodian trap (buyer MUST stay null)", () => {
  it("AllDay: fills the seller but leaves buyer NULL even though a Deposit exists", () => {
    // The AllDay Deposit goes to a Dapper custodian, not the real buyer — writing
    // it would poison every AllDay wallet's "bought" view. This is THE regression.
    expect(decodeCounterparties([alldayWithdraw(SELLER), alldayDeposit(CUSTODIAN)])).toEqual({
      seller: SELLER,
      buyer: null,
    })
  })

  it("UFC: seller only, buyer NULL", () => {
    expect(decodeCounterparties([ufcWithdraw(SELLER), alldayDeposit(CUSTODIAN)])).toEqual({
      seller: SELLER,
      buyer: null,
    })
  })
})

describe("decodeCounterparties — money/standard legs are not counterparties", () => {
  it("ignores NonFungibleToken.Withdrawn and FlowToken.TokensWithdrawn when picking the seller", () => {
    const res = decodeCounterparties([
      flowTokensWithdrawn("0x9999999999999999"),
      nftWithdrawn("0x8888888888888888"),
      tsWithdraw(SELLER),
      tsDeposit(BUYER),
    ])
    expect(res).toEqual({ seller: SELLER, buyer: BUYER })
  })

  it("returns null/null when only money legs are present (no moment transfer)", () => {
    expect(decodeCounterparties([flowTokensWithdrawn("0xabc"), nftWithdrawn("0xdef")])).toEqual({
      seller: null,
      buyer: null,
    })
  })
})

describe("decodeCounterparties — multi-moment guard writes nothing", () => {
  it("two moment Withdraws → both null (cannot attribute the sale_id to one nft)", () => {
    expect(decodeCounterparties([tsWithdraw(SELLER), tsWithdraw("0x4444444444444444"), tsDeposit(BUYER)])).toEqual({
      seller: null,
      buyer: null,
    })
  })

  it("two TopShot Deposits → both null", () => {
    expect(decodeCounterparties([tsWithdraw(SELLER), tsDeposit(BUYER), tsDeposit("0x5555555555555555")])).toEqual({
      seller: null,
      buyer: null,
    })
  })
})

describe("decodeCounterparties — degenerate inputs never throw", () => {
  it("empty / nullish events → null/null", () => {
    expect(decodeCounterparties([])).toEqual({ seller: null, buyer: null })
    expect(decodeCounterparties(undefined as unknown as CdcEvent[])).toEqual({ seller: null, buyer: null })
  })

  it("a Withdraw with a null Optional from is skipped (not counted as a party)", () => {
    expect(decodeCounterparties([tsWithdraw(null), tsDeposit(BUYER)])).toEqual({ seller: null, buyer: BUYER })
  })

  it("an event with an undecodable payload is skipped without throwing", () => {
    const garbage: CdcEvent = { type: `${TS}.Withdraw`, payload: "!!!not-base64!!!" }
    expect(decodeCounterparties([garbage, tsWithdraw(SELLER)])).toEqual({ seller: SELLER, buyer: null })
  })
})

describe("decodePayload / fields helpers", () => {
  it("decodePayload parses base64 JSON-CDC and returns null on bad input", () => {
    expect(decodePayload({ payload: b64({ a: 1 }) })).toEqual({ a: 1 })
    expect(decodePayload({ payload: "@@@" })).toBeNull()
  })

  it("fields flattens a composite, unwrapping one level", () => {
    const payload = decodePayload(tsWithdraw(SELLER)) as any
    // Optional<Address> unwraps to {type:'Address', value:'0x…'} at this layer.
    expect(fields(payload).from).toEqual({ type: "Address", value: SELLER })
  })

  it("fields on a non-composite yields an empty object", () => {
    expect(fields(null)).toEqual({})
    expect(fields({ value: {} })).toEqual({})
  })
})
