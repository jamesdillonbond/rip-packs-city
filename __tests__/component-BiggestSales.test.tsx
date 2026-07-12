// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))

// Return-based mock: no real fetch, addresses never resolve to a handle so the
// component falls through to its truncated-0x display path.
vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => ({}),
}))

import BiggestSales from "@/components/analytics/BiggestSales"

afterEach(cleanup)

const BUYER = "0x1111111111111111"
const SELLER = "0x2222222222222222"

function row(overrides: Record<string, any> = {}) {
  return {
    rank: 1,
    transaction_hash: "0xtx",
    collection: "topshot",
    marketplace: "topshot",
    player_name: "Damian Lillard",
    set_name: "Cosmic",
    serial_number: 8,
    price_usd: 12500,
    buyer_address: BUYER,
    seller_address: SELLER,
    sold_at: new Date().toISOString(),
    ...overrides,
  } as any
}

describe("BiggestSales", () => {
  it("renders an empty state when there are no rows", () => {
    const { container } = render(<BiggestSales rows={[]} />)
    expect(container.textContent).toContain("No sales in this window yet.")
  })

  it("formats price with the >=10k thousands rule and maps collection/marketplace labels", () => {
    const { container } = render(<BiggestSales rows={[row()]} />)
    const txt = container.textContent!
    // 12500 -> $12.5k
    expect(txt).toContain("$12.5k")
    // COLLECTION_LABEL["topshot"] === "Top Shot"
    expect(txt).toContain("Top Shot")
    expect(txt).toContain("Damian Lillard")
    expect(txt).toContain("Cosmic")
    expect(txt).toContain("#8")
  })

  it("formats millions with two decimals", () => {
    const { container } = render(<BiggestSales rows={[row({ price_usd: 2_500_000 })]} />)
    expect(container.textContent).toContain("$2.50M")
  })

  it("links buyer/seller only for valid Flow addresses and truncates the display", () => {
    const { container } = render(<BiggestSales rows={[row()]} />)
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain(`/analytics/wallets/${BUYER}`)
    expect(links).toContain(`/analytics/wallets/${SELLER}`)
    // truncate(): 0x1111…1111
    expect(container.textContent).toContain("0x1111…1111")
  })

  it("does not linkify a non-Flow-format seller address", () => {
    const { container } = render(
      <BiggestSales rows={[row({ seller_address: "storefront-escrow" })]} />
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain(`/analytics/wallets/${BUYER}`)
    expect(links).not.toContain("/analytics/wallets/storefront-escrow")
  })

  it("falls back to a collection-and-serial title when player_name is null", () => {
    const { container } = render(
      <BiggestSales rows={[row({ player_name: null, serial_number: 42 })]} />
    )
    // title = `${collectionLabel} #${serial}` = "Top Shot #42"
    expect(container.textContent).toContain("Top Shot #42")
  })
})
