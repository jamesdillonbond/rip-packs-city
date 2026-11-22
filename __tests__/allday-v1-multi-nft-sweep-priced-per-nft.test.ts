import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-21 on-chain census: a V1 Dapper tx that bought several All Day listings (a sweep) was
// recorded with the WHOLE basket's price on every NFT (tx 07145a00…: 4 × $0.75 stored as 4 × $3.00;
// 14 such txs since Sept). The cache-miss path must price a multi-NFT tx per NFT through
// decodeV1MultiSaleTx, keyed by the FULL type id (its match is exact), never decodeV1SaleTx's gross.
describe("allday-sales-indexer — a multi-NFT V1 sweep is priced per NFT", () => {
  const src = readFileSync(join(process.cwd(), "app/api/allday-sales-indexer/route.ts"), "utf8")
  it("routes a tx with more than one V1 sale to the per-NFT decoder before the gross decoder", () => {
    const multi = src.indexOf("(v1TxCount.get(sale.transactionId) ?? 0) > 1")
    const gross = src.indexOf("const decoded = await decodeV1SaleTx(sale.transactionId", multi)
    expect(multi).toBeGreaterThan(-1)
    expect(src.indexOf("decodeV1MultiSaleTx(sale.transactionId", multi)).toBeGreaterThan(multi)
    expect(gross).toBeGreaterThan(src.indexOf("decodeV1MultiSaleTx(sale.transactionId", multi))
  })
  it("passes the full All Day NFT type id (the decoder compares it exactly)", () => {
    expect(src).toContain('nftType: "A.e4cf4bdc1751c65d.AllDay.NFT"')
  })
  it("parks an uncertain per-NFT price instead of guessing", () => {
    expect(src).toMatch(/reason: `multi_\$\{per\?\.priceReason \?\? multi\.reason\}`/)
  })
})
