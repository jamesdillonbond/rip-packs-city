// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * UFC Strike on Aptos (2026-11-25). UFC sales ingested from Aptos (source 'aptos_indexer_v1') carry
 * 64-hex Aptos addresses. Before this, the sales table linked them into RPC's FLOW wallet analyzer
 * (/ufc/collection?wallet=0x…64), a page that cannot describe an Aptos collector, and the rows carried
 * no venue, so Aptos sales read as Flow sales under a banner that said everything was historical Flow.
 */

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))
vi.mock("@/lib/analytics/username-resolver", () => ({ useResolveUsernames: () => ({}) }))

import SalesTablePaginated from "@/components/entity/SalesTablePaginated"
import { aptosWalletDisplay, aptosSaleVenue, isAptosAccountAddress } from "@/lib/ufc-aptos"
import { bannerCopy } from "@/lib/marketplace-status-banner"

afterEach(cleanup)

const STORE = "0x8a94446716e60160571b930bd1097b31c7788decbe4d375802bebfc79d928e7f"
const BUYER = "0x721f786f5728483d0ce359a7179332246622ed7999e514df19fe17bfc78f7f9b"
const FLOW = "0x4ecf6aaa3a6bfe3a"

function sale(o: Record<string, unknown> = {}): any {
  return {
    serial_number: 733, price_usd: 3, marketplace: "rarible", source: "aptos_indexer_v1",
    buyer_address: BUYER, seller_address: STORE, nft_id: "0xc1bd", transaction_hash: "0x8713",
    sold_at: "2026-10-22T08:56:20Z", parallel: null, ...o,
  }
}
const props = (rows: any[]) => ({ collectionUrlSlug: "ufc", routeSlug: "GEOFF-NEAL-750", initial: rows, initialOffset: rows.length, pageSize: 30, isAllDay: false })

describe("Aptos sale rows", () => {
  it("never link an Aptos address into the Flow wallet analyzer — they go to the Aptos explorer", () => {
    const { container } = render(<SalesTablePaginated {...props([sale()])} />)
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs.some((h) => h.includes("/collection?wallet="))).toBe(false)
    expect(hrefs).toContain(`https://explorer.aptoslabs.com/account/${BUYER}?network=mainnet`)
  })

  it("name UFC's own store wallet instead of a truncated address", () => {
    const { container } = render(<SalesTablePaginated {...props([sale()])} />)
    expect(container.textContent).toContain("UFC Strike store")
  })

  it("mark the venue: Aptos · Rarible / Aptos · Tradeport", () => {
    const { container } = render(<SalesTablePaginated {...props([sale(), sale({ marketplace: "tradeport", transaction_hash: "0x2" })])} />)
    expect(container.textContent).toContain("Aptos · Rarible")
    expect(container.textContent).toContain("Aptos · Tradeport")
  })

  it("leave Flow rows exactly as before: analyzer link, no Aptos chip", () => {
    const { container } = render(<SalesTablePaginated {...props([sale({ source: "ufc_backfill", marketplace: "ufc", buyer_address: FLOW, seller_address: FLOW })])} />)
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain(`/ufc/collection?wallet=${FLOW}`)
    expect(container.textContent).not.toContain("Aptos")
  })
})

describe("lib/ufc-aptos helpers", () => {
  it("recognise only full 64-hex Aptos accounts (not Flow 16-hex, not EVM 40-hex)", () => {
    expect(isAptosAccountAddress(BUYER)).toBe(true)
    expect(isAptosAccountAddress(FLOW)).toBe(false)
    expect(isAptosAccountAddress("0x" + "a".repeat(40))).toBe(false)
    expect(aptosWalletDisplay(FLOW)).toBeNull()
  })
  it("venue is null for every non-Aptos sale", () => {
    expect(aptosSaleVenue("topshot", "topshot")).toBeNull()
    expect(aptosSaleVenue("aptos_indexer_v1", null)).toBe("Aptos")
  })
})

describe("UFC banner", () => {
  it("no longer claims everything below is historical Flow data", () => {
    const c = bannerCopy("ufc", "shutdown", null)
    expect(c?.title).toContain("UFC Strike")
    expect(c?.body).not.toMatch(/Everything below is historical Flow data/)
    expect(c?.body).toMatch(/Aptos/)
  })
})
