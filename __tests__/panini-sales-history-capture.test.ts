// __tests__/panini-sales-history-capture.test.ts
//
// 2026-09-28 — Panini sales history (migration 20260929020655). The runner tags every
// nftSalesData record with the list its REQUEST named (top | recent) so the ingest can move
// coverage only on RECENT reads; the replay can post sales ONLY, so a backfill from an old
// backup never re-posts stale serials over today's asks and owners.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { saleListOf, tagSaleRecords } from "../scripts/panini-sales-list.mjs"
import { replayBody } from "../scripts/panini-replay.mjs"

describe("saleListOf — which list a request asked for", () => {
  it("reads sale_type + pageSize from a GraphQL query string (quotes escaped in the JSON body)", () => {
    const body = JSON.stringify({ query: 'query nftSalesData { nftSalesData(psku:"packcard-1", sale_type:"top", pageSize:20, p:1) { data { url_key } } }' })
    expect(saleListOf(body)).toEqual({ list: "top", pageSize: 20 })
  })
  it("reads a variables object too, any case", () => {
    expect(saleListOf(JSON.stringify({ operationName: "nftSalesData", variables: { saleType: "RECENT", page_size: 20 } }))).toEqual({ list: "recent", pageSize: 20 })
  })
  it("an unrecognised or missing field is null — never a guess", () => {
    expect(saleListOf(JSON.stringify({ query: "query nftSalesData { nftSalesData(psku:\"x\") { data } }" }))).toEqual({ list: null, pageSize: null })
    expect(saleListOf(JSON.stringify({ variables: { sale_type: "all_time" } })).list).toBeNull()
    expect(saleListOf(undefined as unknown as string)).toEqual({ list: null, pageSize: null })
  })
  it("tagSaleRecords stamps __list/__page_size only when known", () => {
    const recs: Record<string, unknown>[] = [{ url_key: "a" }, { url_key: "b" }]
    expect(tagSaleRecords(recs, JSON.stringify({ query: 'nftSalesData(sale_type:"recent", pageSize:20)' }))).toBe("recent")
    expect(recs.every((r) => r.__list === "recent" && r.__page_size === 20)).toBe(true)
    const bare: Record<string, unknown>[] = [{ url_key: "c" }]
    expect(tagSaleRecords(bare, "{}")).toBeNull()
    expect(bare[0]).toEqual({ url_key: "c" })
  })
})

describe("replayBody — a backfill never re-posts stale serials", () => {
  const line = JSON.stringify({ cards: [{ sku: "p" }], serials: [{ sku: "p__1_5", buy_now_price: 9 }], packs: [{}], sales: [{ url_key: "p__1_5", txn_amount: 4 }] })
  it("sales-only mode posts the sales array and nothing else", () => {
    expect(JSON.parse(replayBody(line, true)!)).toEqual({ sales: [{ url_key: "p__1_5", txn_amount: 4 }] })
  })
  it("sales-only mode skips batches with no sales, and unparseable lines", () => {
    expect(replayBody(JSON.stringify({ serials: [{}] }), true)).toBeNull()
    expect(replayBody("not json", true)).toBeNull()
  })
  it("control: full mode (a failed-POST recovery) posts the line verbatim", () => {
    expect(replayBody(line, false)).toBe(line)
  })
})

describe("the runner wires the tag in", () => {
  const src = readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8")
  it("tags every captured sale record with the request's list and reports untagged", () => {
    expect(src).toContain('import { tagSaleRecords } from "./panini-sales-list.mjs"')
    expect(src).toMatch(/tagSaleRecords\(saleRecs, resp\.request\(\)\.postData\(\)/)
    expect(src).toContain("untagged=${salesByList.untagged}")
  })
})
