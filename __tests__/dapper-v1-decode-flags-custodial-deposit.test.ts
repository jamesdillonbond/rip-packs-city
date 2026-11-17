import { describe, it, expect, vi, afterEach } from "vitest"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"

/**
 * 2026-10-22: an All Day sale whose `AllDay.Deposit.to` is the Dapper custodian (0xddfbe848a81b2236)
 * decodes to buyer NULL by decision — and must now SAY so (`custodialDeposit`), so the buyer
 * backfill stops counting it as a decode failure. Event shapes copied from a real tx
 * (dbb78c2c…, sold 2026-06-29), fetched 10-22.
 */
const DEPOSIT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const WITHDRAW = "A.e4cf4bdc1751c65d.AllDay.Withdraw"
const ev = (type: string, fields: unknown[]) => ({
  type,
  event_index: 0,
  payload: Buffer.from(JSON.stringify({ value: { id: type, fields }, type: "Event" })).toString("base64"),
})
const addr = (name: string, a: string) => ({ value: { value: { value: a, type: "Address" }, type: "Optional" }, name })
const id = (v: string) => ({ value: { value: v, type: "UInt64" }, name: "id" })

function mockTx(depositTo: string) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      events: [ev(WITHDRAW, [id("2669071"), addr("from", "0x65eb6e4715f87980")]), ev(DEPOSIT, [id("2669071"), addr("to", depositTo)])],
    }),
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe("decodeV1SaleTx — a custodial deposit is decoded, and flagged", () => {
  const cfg = { depositEventType: DEPOSIT, withdrawEventType: WITHDRAW, nftId: "2669071" }
  it("Deposit.to = the custodian → buyer null, custodialDeposit true, seller still read", async () => {
    mockTx("0xddfbe848a81b2236")
    const r = await decodeV1SaleTx("ab", cfg)
    expect(r.buyer).toBeNull()
    expect(r.custodialDeposit).toBe(true)
    expect(r.seller).toBe("0x65eb6e4715f87980")
  })
  it("CONTROL: a real collector address is the buyer, and nothing is flagged", async () => {
    mockTx("0x1234567890abcdef")
    const r = await decodeV1SaleTx("ab", cfg)
    expect(r.buyer).toBe("0x1234567890abcdef")
    expect(r.custodialDeposit).toBeFalsy()
  })
})
