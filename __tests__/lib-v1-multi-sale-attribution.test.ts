import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { attributeV1MultiSalePrices, V1_LISTING_COMPLETED } from "@/lib/chains/flow/dapper-v1-tx-decode"

// Per-NFT price attribution for multi-NFT V1 Dapper txs (2026-09-29). The
// fixtures are REAL All Day transaction_results fetched from Flow REST (via
// pg_net), trimmed to type/event_index/payload — the fields the decoder reads.

type Ev = { type: string; event_index: number; payload: string }
const load = (name: string): Ev[] =>
  JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/flow-v1-multi", name), "utf8")).events

const CFG = {
  depositEventType: "A.e4cf4bdc1751c65d.AllDay.Deposit",
  withdrawEventType: "A.e4cf4bdc1751c65d.AllDay.Withdraw",
  nftType: "A.e4cf4bdc1751c65d.AllDay.NFT",
}
const DUC = "A.ead892083b3e2c6c.DapperUtilityCoin.TokensWithdrawn"

const decodePayload = (e: Ev) => JSON.parse(Buffer.from(e.payload, "base64").toString("utf8"))
const encodePayload = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64")

describe("attributeV1MultiSalePrices — real multi-NFT txs", () => {
  it("splits a 3-NFT cart by listing, including UNEQUAL prices ($0.67/$0.67/$0.66)", () => {
    const r = attributeV1MultiSalePrices(load("allday-v1-3nft-000edcfb.json"), CFG)
    expect(r.ok).toBe(true)
    expect(Object.fromEntries([...r.perNft].map(([k, v]) => [k, v.priceDuc]))).toEqual({
      "9942240": 0.67,
      "10194940": 0.67,
      "10347099": 0.66,
    })
    for (const v of r.perNft.values()) {
      expect(v.priceCertain).toBe(true)
      expect(v.priceReason).toBe("matched")
      expect(v.seller).toBe("0x909a0fd879c9891e")
    }
  })

  it("splits both 4-NFT carts, every price certain", () => {
    const a = attributeV1MultiSalePrices(load("allday-v1-4nft-0019e194.json"), CFG)
    const b = attributeV1MultiSalePrices(load("allday-v1-4nft-1647dbef.json"), CFG)
    expect(a.ok && b.ok).toBe(true)
    expect([...a.perNft.values()].map((v) => v.priceDuc)).toEqual([2, 2, 2, 2])
    expect([...b.perNft.keys()]).toEqual(["6337741", "6626583", "6614197", "6560213"])
    expect([...b.perNft.values()].every((v) => v.priceDuc === 0.5 && v.priceCertain)).toBe(true)
  })

  it("the per-NFT prices sum to the tx's gross (what decodeV1SaleTx returns)", () => {
    const ev = load("allday-v1-3nft-000edcfb.json")
    const gross = ev
      .filter((e) => e.type === DUC)
      .map(decodePayload)
      .filter((p) => JSON.stringify(p).includes("0xead892083b3e2c6c"))
      .length
    expect(gross).toBe(3)
    const sum = [...attributeV1MultiSalePrices(ev, CFG).perNft.values()].reduce((s, v) => s + (v.priceDuc ?? 0), 0)
    expect(sum).toBeCloseTo(2.0, 8)
  })
})

describe("attributeV1MultiSalePrices — refuses rather than guesses", () => {
  it("⛔ a payment no purchased listing closes over makes NOTHING in the tx certain", () => {
    // Drop the middle ListingCompleted: its payment now falls into the next
    // segment, which then holds TWO contract payments.
    const ev = load("allday-v1-3nft-000edcfb.json")
    const completions = ev.filter((e) => e.type === V1_LISTING_COMPLETED)
    const tampered = ev.filter((e) => e !== completions[1])
    const r = attributeV1MultiSalePrices(tampered, CFG)
    expect(r.perNft.get("10194940")).toBeUndefined()
    const last = r.perNft.get("10347099")!
    expect(last.priceCertain).toBe(false)
    expect(last.priceReason).toBe("segment_gross_count")
    expect(last.priceDuc).toBeNull()
  })

  it("⛔ a trailing payment after the last listing fails the whole tx (unattributed_payment)", () => {
    const ev = load("allday-v1-3nft-000edcfb.json")
    const pay = ev.find((e) => e.type === DUC)!
    const extra = { ...pay, event_index: 999 }
    const r = attributeV1MultiSalePrices([...ev, extra], CFG)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("unattributed_payment")
    expect([...r.perNft.values()].every((v) => !v.priceCertain && v.priceDuc === null)).toBe(true)
  })

  it("⛔ a split that does not match its segment's gross is uncertain", () => {
    const ev = load("allday-v1-3nft-000edcfb.json")
    // Inflate the first downstream split (from = null) by $1.
    const firstSplit = ev.find((e) => e.type === DUC && !JSON.stringify(decodePayload(e)).includes("0xead892083b3e2c6c"))!
    const obj = decodePayload(firstSplit)
    const s = JSON.stringify(obj).replace('"0.67000000"', '"1.67000000"')
    const tampered = ev.map((e) => (e === firstSplit ? { ...e, payload: encodePayload(JSON.parse(s)) } : e))
    const r = attributeV1MultiSalePrices(tampered, CFG)
    expect(r.perNft.get("9942240")!.priceReason).toBe("split_sum_mismatch")
    expect(r.perNft.get("9942240")!.priceCertain).toBe(false)
    // the other listings are unaffected
    expect(r.perNft.get("10194940")!.priceCertain).toBe(true)
  })

  it("ignores a purchase of ANOTHER collection's NFT but still reconciles the tx", () => {
    const r = attributeV1MultiSalePrices(load("allday-v1-3nft-000edcfb.json"), { ...CFG, nftType: "A.0b2a3299cc857e29.TopShot.NFT" })
    expect(r.perNft.size).toBe(0)
    expect(r.ok).toBe(true)
  })

  it("an empty event list is tx_no_events, not ok", () => {
    expect(attributeV1MultiSalePrices([], CFG)).toMatchObject({ ok: false, reason: "tx_no_events" })
  })
})
