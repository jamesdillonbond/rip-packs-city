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

  it("a DEGRADED empty table says the read failed — never 'No sales yet.'", async () => {
    // The whole point of serverOk. Before it, a failed get_edition_recent_sales
    // degraded to [] and this table concluded there were no sales — measured 221
    // times in 24h on 2026-08-21, on the highest-traffic public page.
    const { container } = render(<SalesTablePaginated {...base([])} serverOk={false} />)
    // Assert the ABSENCE of the false claim, not just the presence of an error.
    expect(container.textContent).not.toMatch(/No sales/i)
    expect(container.textContent).toContain("couldn't be loaded")
  })

  it("a GENUINELY empty table still says 'No sales yet.' — the honest case is unchanged", async () => {
    // ⚠ The inverse defect: a section that cries "unavailable" when it is merely
    // quiet would fire on every low-volume edition and train readers to ignore it.
    const { container } = render(<SalesTablePaginated {...base([])} serverOk={true} />)
    expect(container.textContent).toContain("No sales yet.")
    expect(container.textContent).not.toContain("couldn't be loaded")
  })

  it("defaults to the honest-empty reading when serverOk is not passed", async () => {
    // Every existing caller omits the prop; the default must not turn quiet
    // sections into error banners.
    const { container } = render(<SalesTablePaginated {...base([])} />)
    expect(container.textContent).toContain("No sales yet.")
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

// ── loadMore pagination, wallet-cell + name branches ────────────────────────
import { fireEvent, waitFor } from "@testing-library/react"

describe("SalesTablePaginated — loadMore + cell branches", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function fullPage() {
    return Array.from({ length: 30 }, (_, i) => sale({ transaction_hash: `0xh${i}`, serial_number: i + 1 }))
  }

  it("appends the next page and exhausts when a short page returns", async () => {
    const next = [sale({ transaction_hash: "0xnext", serial_number: 99, price_usd: 7 })]
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => next })) as never)
    const { container, getByText } = render(<SalesTablePaginated {...base(fullPage())} />)
    fireEvent.click(getByText("Load 30 more"))
    await waitFor(() => expect(container.textContent).toContain("#99"))
    // The appended page (1 row < pageSize) exhausts the list -> button gone.
    await waitFor(() => expect(container.textContent).not.toContain("Load 30 more"))
  })

  it("a FAILED page fetch says so and keeps Load More — it is not 'that is all the sales'", async () => {
    // ⚠ INVERTED 2026-08-21, NOT deleted. This asserted the opposite — "on error
    // the catch sets exhausted -> the button disappears" — i.e. a 500 while
    // paginating rendered as "you have reached the end of the sales history".
    // Same failed-read-as-fact defect as the empty state, one interaction in.
    //
    // ⚠ AND THE OLD ASSERTION WAS FLAKY-VACUOUS: it waited for "Load 30 more" to
    // be ABSENT, and that string is also absent for the moment the button reads
    // "Loading…". It would have passed whether or not the catch set `exhausted`.
    // This version waits for the settled end state instead.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => [] })) as never)
    const { container, getByText } = render(<SalesTablePaginated {...base(fullPage())} />)
    fireEvent.click(getByText("Load 30 more"))
    await waitFor(() => expect(container.textContent).toContain("couldn't be loaded"))
    // The retry affordance survives, and no false claim about the data is made.
    expect(container.textContent).toContain("Load 30 more")
    expect(container.textContent).not.toMatch(/No sales/i)
  })

  it("a THROWN page fetch is treated exactly like a failed one", async () => {
    // ⚠ INVERTED with its sibling above. A network error is not evidence about
    // how many sales exist.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as never)
    const { container, getByText } = render(<SalesTablePaginated {...base(fullPage())} />)
    fireEvent.click(getByText("Load 30 more"))
    await waitFor(() => expect(container.textContent).toContain("couldn't be loaded"))
    expect(container.textContent).toContain("Load 30 more")
  })

  it("shows the loading label while a fetch is in-flight", async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    const pending = new Promise((res) => { resolveFetch = res })
    vi.stubGlobal("fetch", vi.fn(async () => {
      await pending
      return { ok: true, status: 200, json: async () => [] }
    }) as never)
    const { getByText } = render(<SalesTablePaginated {...base(fullPage())} />)
    fireEvent.click(getByText("Load 30 more"))
    await waitFor(() => expect(getByText("Loading…")).toBeTruthy())
    resolveFetch({})
  })

  it("renders an em-dash for a null buyer/seller wallet", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ buyer_address: null, seller_address: null })])} />,
    )
    // Both wallet cells fall back to the em-dash, no /profile link.
    expect(container.querySelectorAll('a[href^="/profile/"]').length).toBe(0)
    expect(container.textContent).toContain("—")
  })

  it("prefixes a bare (no-0x) wallet with 0x in the profile link", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ buyer_address: "abc123def456", seller_address: null })])} />,
    )
    const link = container.querySelector('a[href="/profile/0xabc123def456"]')
    expect(link).toBeTruthy()
  })

  it("shows @username from initialNames when the resolver has no live entry", () => {
    const { container } = render(
      <SalesTablePaginated
        {...base([sale({ buyer_address: "0xbuyer000000000001" })], {
          initialNames: { "0xbuyer000000000001": "collector" },
        })}
      />,
    )
    expect(container.textContent).toContain("@collector")
  })

  it("renders an em-dash price for a null price_usd", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ price_usd: null, serial_number: 3 })])} />,
    )
    // fmtUsd(null) -> EM_DASH in the price cell.
    expect(container.textContent).toContain("—")
  })

  it("renders an em-dash serial for a null serial on a non-AllDay collection", () => {
    const { container } = render(
      <SalesTablePaginated {...base([sale({ serial_number: null })], { isAllDay: false })} />,
    )
    // Non-AllDay + null serial -> EM_DASH, NOT the 'unresolved' AllDay chip.
    expect(container.textContent).not.toContain("unresolved")
  })
})
