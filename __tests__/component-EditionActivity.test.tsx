// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"

const salesProps = vi.hoisted(() => ({ last: null as any }))
vi.mock("@/components/entity/SalesTablePaginated", () => ({
  default: (props: any) => {
    salesProps.last = props
    return <div data-testid="sales-table" />
  },
}))
vi.mock("@/components/entity/RelTime", () => ({ default: () => null }))
vi.mock("@/lib/analytics/username-resolver", () => ({ useResolveUsernames: () => ({}) }))

import EditionActivity, { type OfferRow } from "@/components/entity/EditionActivity"

// Pins the edition Activity section's Sales|Offers toggle + the Offers table's
// HONESTY rule: an edition/subedition offer carries NO serial (any serial fills
// it), so the Serial cell must render the em-dash, NOT "#0" or a fake serial.
// A serial-scoped offer shows its "#N". Also pins the offer-count in the tab
// label and the empty-offers state (offers are Top-Shot-only; other collections
// must show empty, never error).

afterEach(cleanup)

const baseProps = {
  collectionUrlSlug: "nba-top-shot",
  routeSlug: "1-1",
  initialSales: [],
  initialSalesOffset: 0,
  salesPageSize: 30,
  isAllDay: false,
  initialNames: {},
}

const offer = (over: Partial<OfferRow> = {}): OfferRow => ({
  serial_number: 5,
  price_usd: 10,
  buyer_address: "0xbidder000000001",
  offer_type: "serial",
  made_at: "2026-07-20T00:00:00Z",
  ...over,
})

describe("EditionActivity", () => {
  it("defaults to the Sales tab and shows the offer count in the Offers label", () => {
    render(<EditionActivity {...baseProps} offers={[offer(), offer({ serial_number: null })]} />)
    expect(screen.getByTestId("sales-table")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Offers · 2/ })).toBeTruthy()
  })

  it("switches to Offers and renders a serial offer as '#N' and an edition offer as the em-dash", () => {
    render(
      <EditionActivity
        {...baseProps}
        offers={[
          offer({ serial_number: 5, offer_type: "serial", price_usd: 10 }),
          offer({ serial_number: null, offer_type: "edition", buyer_address: "0xother00000002", price_usd: 20 }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Offers/ }))
    expect(screen.getByText("#5")).toBeTruthy() // serial offer
    expect(screen.getByText("$10.00")).toBeTruthy() // fmtUsd(10) — serial offer, unique price
    expect(screen.getByText("$20.00")).toBeTruthy() // edition offer
    // the edition offer's serial cell is blank (em-dash), never "#0"
    expect(screen.queryByText("#0")).toBeNull()
  })

  it("shows an honest empty state (never errors) when there are no offers", () => {
    render(<EditionActivity {...baseProps} offers={[]} />)
    fireEvent.click(screen.getByRole("button", { name: /Offers/ }))
    expect(screen.getByText(/No open offers on this edition/i)).toBeTruthy()
  })

  it("a DEGRADED offers tab says the read failed — never 'No open offers'", () => {
    // ⚠ The sibling case above is titled "an honest empty state", and until now
    // that word was doing work the assertion could not back: a failed
    // get_edition_offers degraded to [] and rendered the same sentence, so the
    // tab claimed there were no standing bids when it had simply failed to look.
    const { getByText, container } = render(<EditionActivity {...baseProps} offers={[]} offersOk={false} />)
    fireEvent.click(getByText(/^Offers/))
    expect(container.textContent).not.toMatch(/No open offers/i)
    expect(container.textContent).toContain("couldn't be loaded")
  })

  it("a genuinely empty offers tab keeps its own wording", () => {
    const { getByText, container } = render(<EditionActivity {...baseProps} offers={[]} offersOk={true} />)
    fireEvent.click(getByText(/^Offers/))
    expect(container.textContent).toContain("No open offers on this edition.")
  })

  it("FORWARDS the degraded sales flag to the sales table", () => {
    // ⚠ Asserted as a forwarded PROP, not as rendered text: SalesTablePaginated
    // is mocked in this suite, so a text assertion here would pass no matter what
    // this component did with salesOk. The rendered behaviour is pinned in
    // component-SalesTablePaginated.test.tsx instead.
    //
    // Both legs of the Activity block fan out separately; wiring one and not the
    // other is the "one honest branch does not make an honest page" shape.
    render(<EditionActivity {...baseProps} offers={[]} salesOk={false} />)
    expect(salesProps.last.serverOk).toBe(false)
  })

  it("forwards serverOk true by default so a quiet edition is not called broken", () => {
    render(<EditionActivity {...baseProps} offers={[]} />)
    expect(salesProps.last.serverOk).toBe(true)
  })

  it("toggles aria-pressed on the active tab", () => {
    render(<EditionActivity {...baseProps} offers={[offer()]} />)
    const salesBtn = screen.getByRole("button", { name: "Sales" })
    const offersBtn = screen.getByRole("button", { name: /Offers/ })
    expect(salesBtn.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(offersBtn)
    expect(offersBtn.getAttribute("aria-pressed")).toBe("true")
    expect(salesBtn.getAttribute("aria-pressed")).toBe("false")
  })
})
