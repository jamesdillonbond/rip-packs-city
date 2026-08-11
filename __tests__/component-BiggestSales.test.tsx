// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))

// Return-based mock: no real fetch. The resolver map is a hoisted mutable so a
// test can seed a { addr → username } entry and drive the @name display branch;
// default empty → truncated-0x display path.
const resolverState = vi.hoisted(() => ({ names: {} as Record<string, string> }))
vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => resolverState.names,
}))

import BiggestSales from "@/components/analytics/BiggestSales"

afterEach(() => {
  cleanup()
  resolverState.names = {}
})

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

// ── Formatter bands, relative time, label fallbacks, @name resolution ───────
describe("BiggestSales — formatter + fallback branches", () => {
  it("shows $0 for a non-positive price", () => {
    const { container } = render(<BiggestSales rows={[row({ price_usd: 0 })]} />)
    expect(container.textContent).toContain("$0")
  })

  it("formats a sub-$10k price with grouped whole dollars (no k/M band)", () => {
    const { container } = render(<BiggestSales rows={[row({ price_usd: 4500 })]} />)
    // 4500 < 10_000 -> toLocaleString whole dollars -> "$4,500".
    expect(container.textContent).toContain("$4,500")
  })

  it("resolves a buyer to @username when the resolver has a handle", () => {
    resolverState.names = { [BUYER.toLowerCase()]: "whale" }
    const { container } = render(<BiggestSales rows={[row()]} />)
    expect(container.textContent).toContain("@whale")
  })

  it("renders an em-dash for a null seller and does not linkify it", () => {
    const { container } = render(<BiggestSales rows={[row({ seller_address: null })]} />)
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    // buyer still links; seller shows the em-dash (truncate(null)).
    expect(links).toContain(`/analytics/wallets/${BUYER}`)
    expect(container.textContent).toContain("—")
  })

  it("falls back to the raw collection/marketplace strings when unknown", () => {
    const { container } = render(
      <BiggestSales rows={[row({ collection: "candy_mlb", marketplace: "magiceden" })]} />,
    )
    // COLLECTION_LABEL / MARKETPLACE_LABEL have no entry -> raw value shown.
    expect(container.textContent).toContain("candy_mlb")
    expect(container.textContent).toContain("magiceden")
  })

  it("uses the collection label as the subtitle when set_name is null but player_name is present", () => {
    const { container } = render(
      <BiggestSales rows={[row({ player_name: "Nikola Jokic", set_name: null })]} />,
    )
    expect(container.textContent).toContain("Nikola Jokic")
    // subtitle = set_name || collectionLabel -> "Top Shot"
    expect(container.textContent).toContain("Top Shot")
  })

  it("hides the serial pill when serial_number is null", () => {
    const { container } = render(<BiggestSales rows={[row({ serial_number: null })]} />)
    // No standalone "#N" serial line — the header "#1 · Top Shot" rank stays.
    const serialLines = Array.from(container.querySelectorAll(".tabular-nums")).filter((n) =>
      /^#\d+$/.test((n.textContent ?? "").trim()),
    )
    expect(serialLines.length).toBe(0)
  })

  it("renders older relative-time buckets (minutes / hours / days)", () => {
    const min = new Date(Date.now() - 5 * 60_000).toISOString()
    const hr = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    const day = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    const { container } = render(
      <BiggestSales
        rows={[
          row({ rank: 1, transaction_hash: "0xa", sold_at: min }),
          row({ rank: 2, transaction_hash: "0xb", sold_at: hr }),
          row({ rank: 3, transaction_hash: "0xc", sold_at: day }),
        ]}
      />,
    )
    const txt = container.textContent!
    expect(txt).toContain("5m ago")
    expect(txt).toContain("3h ago")
    expect(txt).toContain("2d ago")
  })

  it("renders a locale date for a sale older than 30 days", () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString()
    const { container } = render(<BiggestSales rows={[row({ sold_at: old })]} />)
    // >30d -> toLocaleDateString() contains a slash-separated date, not "d ago".
    expect(container.textContent).not.toContain("ago")
  })
})
