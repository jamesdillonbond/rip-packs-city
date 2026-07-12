// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))
// The username resolver is a client hook that fetches — stub it to return no
// resolved names so cells show truncated wallets deterministically.
vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => ({}),
}))

import SalesTablePaginated from "@/components/entity/SalesTablePaginated"

afterEach(cleanup)

function sale(o: Record<string, unknown> = {}): any {
  return {
    serial_number: 5, price_usd: 42, marketplace: "topshot", source: "topshot",
    buyer_address: "0xbuyer000000000001", seller_address: "0xseller00000000001",
    nft_id: "1", transaction_hash: "0xhash1", sold_at: "2026-07-12T10:00:00Z",
    parallel: null, ...o,
  }
}

function base(rows: any[], extra: Record<string, unknown> = {}) {
  return {
    collectionUrlSlug: "nba-top-shot", routeSlug: "8:1234",
    initial: rows, initialOffset: rows.length, pageSize: 30, isAllDay: false, ...extra,
  }
}

describe("SalesTablePaginated", () => {
  it("shows the empty state when there are no sales", () => {
    const { container } = render(<SalesTablePaginated {...base([])} />)
    expect(container.textContent).toContain("No sales yet")
    expect(container.querySelector("table")).toBeNull()
  })

  it("formats a positive serial as #N and the price via fmtUsd", () => {
    const { container } = render(<SalesTablePaginated {...base([sale({ serial_number: 7, price_usd: 42 })])} />)
    const txt = container.textContent!
    expect(txt).toContain("#7")
    expect(txt).toContain("$42")
  })

  it("marks an AllDay serial of 0/null as 'unresolved'", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ serial_number: 0 })], { isAllDay: true })} />
    )
    expect(container.textContent).toContain("unresolved")
  })

  it("hides the Parallel column when no row carries a printing", () => {
    const { container } = render(<SalesTablePaginated {...base([sale({ parallel: null })])} />)
    const heads = Array.from(container.querySelectorAll("th")).map((h) => h.textContent)
    expect(heads).not.toContain("Parallel")
  })

  it("shows the Parallel column when at least one row has a printing", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ parallel: "Hexwave" }), sale({ parallel: null, transaction_hash: "0xhash2" })])} />
    )
    const heads = Array.from(container.querySelectorAll("th")).map((h) => h.textContent)
    expect(heads).toContain("Parallel")
    expect(container.textContent).toContain("Hexwave")
  })

  it("shows the 'Load N more' button only when the initial page is full", () => {
    // initial.length (1) < pageSize (30) → exhausted → no button.
    const short = render(<SalesTablePaginated {...base([sale()])} />)
    expect(short.container.textContent).not.toContain("Load 30 more")
    cleanup()
    // A full page → button shown.
    const full = Array.from({ length: 30 }, (_, i) => sale({ transaction_hash: `0xh${i}`, serial_number: i + 1 }))
    const long = render(<SalesTablePaginated {...base(full)} />)
    expect(long.container.textContent).toContain("Load 30 more")
  })
})
