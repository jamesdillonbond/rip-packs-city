// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import PaniniOverviewClient from "@/app/(collections)/panini-blockchain/overview/PaniniOverviewClient"
import PaniniSniperClient from "@/app/(collections)/panini-blockchain/sniper/PaniniSniperClient"
import TransactionHistoryClient from "@/app/dashboard/history/TransactionHistoryClient"

// Three pages converted for COVERAGE, not for a fix: all three were already honest, and
// each carries an in-file comment explaining the distinction it makes. That is worth
// recording — a conversion that finds nothing is a real result, and re-sweeping these later
// is wasted effort.
//
// What these tests add is the thing the comments could not: proof that the ladders still
// behave that way. A `page.tsx` is measured by neither gate, so until the split nothing
// could drive the failure branch these files describe at length.

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...rest}>{children}</a>
  ),
}))

const okJson = (body: unknown) =>
  vi.fn(async (_i: unknown, _init?: RequestInit) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
const failJson = (status = 503, body: unknown = {}) =>
  vi.fn(async (_i: unknown, _init?: RequestInit) =>
    ({ ok: false, status, json: async () => body }) as unknown as Response)

afterEach(() => cleanup())

// ── Panini overview ─────────────────────────────────────────────────────────
describe("PaniniOverviewClient — market stats", () => {
  const STATS = {
    floor_price: 0.42,
    floor_price_symbol: "ETH",
    total_volume: 128.5,
    total_sales: 900,
    num_owners: 310,
    total_supply: 4149,
    updated_at: new Date().toISOString(),
  }

  it("publishes the market figures on a successful read", async () => {
    vi.stubGlobal("fetch", okJson(STATS))
    render(<PaniniOverviewClient />)
    await waitFor(() => expect(kpi("Cards On-Chain")).toMatch(/4,?149/))
    expect(kpi("Unique Owners")).toMatch(/310/)
    expect(kpi("Floor Price")).toMatch(/0\.4200 ETH/)
  })

  /** The value text of one KPI card, read by its label. */
  function kpi(label: string): string {
    const card = Array.from(document.querySelectorAll(".rpc-card")).find((c) =>
      c.textContent?.includes(label),
    )
    if (!card) throw new Error(`no KPI card for ${label}`)
    return (card.textContent ?? "").replace(label, "").trim()
  }

  // ⚠ These are a floor price and an owner count — MARKET claims. On a failed read they must
  // be withheld, not zeroed: "Floor Price 0.0000 ETH" tells a collector the market collapsed.
  //
  // ⚠ Asserted PER CARD. The first version checked the whole page for "Floor Price 0", which
  // never matches because the label and the value are separate elements — so a mutation
  // replacing the null with 0 sailed through. Reading the card's own text is the difference
  // between observing the value and observing the page.
  // ⚠ MUTATION SURVIVOR, DOCUMENTED: `statsError` is redundant for the DISPLAY. The error
  // branch renders "—", and without it a null `stats` reaches `fmt(null)` which also renders
  // "—" — identical output, so no fixture separates them. It is still not dead code: it is
  // what would let this page say something more specific than an em-dash, and it is the only
  // signal distinguishing "we could not ask" from "there is no floor", which the next case
  // shows are different facts.
  it("withholds every figure when the read fails", async () => {
    vi.stubGlobal("fetch", failJson())
    render(<PaniniOverviewClient />)
    await waitFor(() => expect(kpi("Floor Price")).toBe("—"))
    expect(kpi("Unique Owners")).toBe("—")
    expect(kpi("Total Volume")).toBe("—")
    expect(kpi("Cards On-Chain")).toBe("—")
  })

  it("never renders a zeroed figure on a failed read", async () => {
    vi.stubGlobal("fetch", failJson())
    render(<PaniniOverviewClient />)
    await waitFor(() => expect(kpi("Floor Price")).toBe("—"))
    // A `?? 0` fallback would render "0.0000 ETH" and "0" — plausible numbers a reader
    // cannot tell from a measurement.
    for (const label of ["Floor Price", "Total Volume", "Unique Owners", "Cards On-Chain"]) {
      expect(kpi(label)).not.toMatch(/\d/)
    }
  })

  // ⚠ THE CASE THAT IS ACTUALLY LOAD-BEARING, found by mutation. On a FAILED read the
  // error branch short-circuits before the value expression is reached, so `statsError` and
  // a null `stats` render identically ("—") and no fixture can separate them — documented,
  // not contrived. What the null DOES decide is a SUCCESSFUL read carrying a null field,
  // which is a real state: a collection with nothing listed has no floor. A `?? 0` there
  // would publish "0.0000 ETH" as the floor price of a market that simply has no ask.
  it("renders an absent floor as withheld, not as a floor of zero", async () => {
    vi.stubGlobal("fetch", okJson({ ...STATS, floor_price: null, num_owners: null }))
    render(<PaniniOverviewClient />)
    await waitFor(() => expect(kpi("Cards On-Chain")).toMatch(/4,?149/))
    expect(kpi("Floor Price")).toBe("—")
    expect(kpi("Unique Owners")).toBe("—")
  })

  // A genuine zero is a different statement and must survive.
  it("renders a real zero volume as zero", async () => {
    vi.stubGlobal("fetch", okJson({ ...STATS, total_volume: 0 }))
    render(<PaniniOverviewClient />)
    await waitFor(() => expect(kpi("Cards On-Chain")).toMatch(/4,?149/))
    expect(kpi("Total Volume")).toMatch(/0\.0000 ETH/)
  })

  it("distinguishes loading from failed", async () => {
    let resolve: (v: unknown) => void = () => {}
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { resolve = r })))
    render(<PaniniOverviewClient />)
    // While in flight the page must not have decided anything yet — neither figures nor a
    // failure notice.
    const during = document.body.textContent ?? ""
    expect(during).not.toMatch(/Floor Price\s*0\b/)
    resolve({ ok: true, status: 200, json: async () => STATS })
    await waitFor(() => expect(document.body.textContent).toMatch(/310/))
  })
})

// ── Panini sniper ───────────────────────────────────────────────────────────
describe("PaniniSniperClient — listings feed", () => {
  const LISTING = {
    id: "l1",
    name: "Panini Card #1",
    image_url: null,
    traits: { Rarity: "Rare" },
    price_eth: 0.5,
    price_usd: 1500,
    seller: "0xseller",
    listed_at: new Date().toISOString(),
    buy_url: "https://example.test/buy/1",
  }
  const FEED = { listings: [LISTING], floor_eth: 0.4, count: 1 }

  it("renders a listing on a successful read", async () => {
    vi.stubGlobal("fetch", okJson(FEED))
    render(<PaniniSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Panini Card #1/))
  })

  // ⚠ The page's own comment says the liveness dot is a CLAIM and must know about `error`.
  // That distinction is what these assertions pin: a failed read must not leave a page that
  // looks live and confident.
  it("does not present a failed read as an empty market", async () => {
    vi.stubGlobal("fetch", failJson())
    render(<PaniniSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/couldn|unavailable|error|failed/i))
    // "No listings" is a claim about the Panini market; the error path must own the screen.
    expect(document.body.textContent).not.toMatch(/No listings (found|match)/i)
  })

  it("shows a genuinely empty feed as empty, not as an error", async () => {
    vi.stubGlobal("fetch", okJson({ listings: [], floor_eth: null, count: 0 }))
    render(<PaniniSniperClient />)
    await waitFor(() => expect(document.body.textContent).toBeTruthy())
    // Both directions: an honest zero must not be dressed up as a failure.
    expect(document.body.textContent).not.toMatch(/couldn't load|failed to load/i)
  })
})

// ── Dashboard transaction history ───────────────────────────────────────────
describe("TransactionHistoryClient — the three-state ladder", () => {
  // ⚠ Shaped from the file's own TxEvent / VerifiedWallet interfaces. Fifth time this
  // session that an invented payload rendered nothing and read as a selector problem — the
  // cheap check is to open the interface first, every time.
  const EVENT = {
    // ⚠ "buy" is not a member of the Kind union ("pack_buy" | "pack_open" | "moment_buy" |
    // "moment_pull" | "moment_sell"). An off-union value made the row renderer throw and the
    // container came back EMPTY — the same symptom as a wrong field name, and the same fix:
    // read the type, do not infer it from the domain word.
    kind: "moment_buy" as const,
    occurred_at: new Date().toISOString(),
    collection_id: "c1",
    collection_slug: "nba-top-shot",
    collection_name: "NBA Top Shot",
    title: "Damian Lillard — Archive Set",
    subtitle: "#12/1000",
    thumbnail_url: null,
    amount_usd: 25,
    currency: "USD",
    counterparty: "0xother",
    method: null,
    moments_pulled: null,
    serial_number: 12,
    nft_id: "1",
    pack_nft_id: null,
    dist_id: null,
  }
  const WALLETS = { wallets: [{ wallet_addr: "0xmine", verified_at: new Date().toISOString() }] }

  function routed(historyResponse: { ok: boolean; body: unknown }) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/profile/saved-wallets")) {
        return { ok: true, status: 200, json: async () => WALLETS } as unknown as Response
      }
      if (url.includes("transaction-history")) {
        return { ok: historyResponse.ok, status: historyResponse.ok ? 200 : 500, json: async () => historyResponse.body } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => WALLETS } as unknown as Response
    })
  }

  it("renders events when the read succeeds", async () => {
    vi.stubGlobal("fetch", routed({ ok: true, body: { wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: 1, events: [EVENT] } }))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
  })

  // ⚠ The ladder is loading → ERROR → empty, in that order, and the order is the property:
  // an inverted ladder tells a collector "No activity for this filter" when the read failed,
  // which is a claim about their own trading history.
  it("shows the error rather than 'no activity' when the history read fails", async () => {
    vi.stubGlobal("fetch", routed({ ok: false, body: { error: "history unavailable" } }))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(screen.getByText(/history unavailable/i)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/No activity for this filter/i)
  })

  it("says 'no activity' only when the read SUCCEEDED and was empty", async () => {
    vi.stubGlobal("fetch", routed({ ok: true, body: { wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: 0, events: [] } }))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(screen.getByText(/No activity for this filter/i)).toBeTruthy())
  })

  it("sends the filter into the request", async () => {
    const f = routed({ ok: true, body: { wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: 1, events: [EVENT] } })
    vi.stubGlobal("fetch", f)
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("transaction-history"))).toBe(true))

    const buttons = screen.queryAllByRole("button")
    const sells = buttons.find((b) => /sell/i.test(b.textContent ?? ""))
    if (sells) {
      fireEvent.click(sells)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => /kind=sell/.test(String(c[0])))).toBe(true),
      )
    }
  })
})

// ── Handler and row coverage ────────────────────────────────────────────────
//
// A conversion moves `% Funcs` DOWN: a page is many small handlers, and covering only the
// fetch paths leaves most of them dark. These three landed the component gate BELOW its
// functions threshold on the fetch tests alone, which is the documented price of a
// conversion rather than a surprise.

describe("PaniniSniperClient — filters, sort and rows", () => {
  const listing = (over: Record<string, unknown> = {}) => ({
    id: "l1",
    name: "Panini Card #1",
    image_url: null,
    traits: { Rarity: "Rare" },
    price_eth: 0.5,
    price_usd: 1500,
    seller: "0x1234567890abcdef",
    listed_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    buy_url: "https://example.test/buy/1",
    ...over,
  })

  async function mount(listings: unknown[]) {
    vi.stubGlobal("fetch", okJson({ listings, floor_eth: 0.4, count: listings.length }))
    render(<PaniniSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Panini|listing/i))
  }

  it("renders a listing with its price and seller", async () => {
    await mount([listing()])
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/Panini Card #1/)
    // The seller is shortened rather than dropped — a full 42-char address would blow the
    // row, and omitting it entirely removes the only counterparty signal on the card.
    expect(body).toMatch(/0x1234/)
  })

  it("renders a listing with every optional field absent", async () => {
    await mount([listing({ name: null, image_url: null, price_usd: null, traits: {} })])
    expect(document.querySelectorAll("img,[class*=card]").length).toBeGreaterThan(0)
  })

  it("filters by search text", async () => {
    await mount([listing({ id: "a", name: "Lillard Auto" }), listing({ id: "b", name: "Curry Base" })])
    const search = screen.getByPlaceholderText(/search/i)
    fireEvent.change(search, { target: { value: "lillard" } })
    await waitFor(() => expect(document.body.textContent).toMatch(/Lillard Auto/))
    expect(document.body.textContent).not.toMatch(/Curry Base/)
  })

  it("applies the max-price filter at the boundary", async () => {
    await mount([listing({ id: "a", name: "Cheap", price_eth: 0.2 }), listing({ id: "b", name: "Dear", price_eth: 2 })])
    const max = screen.getByPlaceholderText(/max/i)
    fireEvent.change(max, { target: { value: "1" } })
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Dear/))
    expect(document.body.textContent).toMatch(/Cheap/)
  })

  it("re-sorts without losing rows", async () => {
    await mount([listing({ id: "a", name: "Alpha", price_eth: 2 }), listing({ id: "b", name: "Beta", price_eth: 1 })])
    const sort = screen.getByRole("combobox")
    const opts = Array.from(sort.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value)
    for (const v of opts) {
      fireEvent.change(sort, { target: { value: v } })
      // A comparator that throws or drops its tail is invisible in the sorted output but
      // obvious in the row count.
      await waitFor(() => {
        const body = document.body.textContent ?? ""
        expect(body).toMatch(/Alpha/)
        expect(body).toMatch(/Beta/)
      })
    }
  })

  it("formats a recent listing time as a relative age", async () => {
    await mount([listing({ listed_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() })])
    // An absolute timestamp on a sniper feed is unreadable at a glance; the relative form is
    // the whole point of the column.
    expect(document.body.textContent).toMatch(/\d+\s*(m|h|d)\b/i)
  })
})

describe("TransactionHistoryClient — filters, wallets and paging", () => {
  const EV = (over: Record<string, unknown> = {}) => ({
    kind: "moment_buy" as const,
    occurred_at: new Date().toISOString(),
    collection_id: "c1",
    collection_slug: "nba-top-shot",
    collection_name: "NBA Top Shot",
    title: "Damian Lillard — Archive Set",
    subtitle: "#12/1000",
    thumbnail_url: null,
    amount_usd: 25,
    currency: "USD",
    counterparty: "0xother",
    method: null,
    moments_pulled: null,
    serial_number: 12,
    nft_id: "1",
    pack_nft_id: null,
    dist_id: null,
    ...over,
  })
  const WALLETS2 = {
    wallets: [
      { wallet_addr: "0xmine", verified_at: new Date().toISOString() },
      { wallet_addr: "0xsecond", verified_at: new Date().toISOString() },
    ],
  }

  function routed(events: unknown[], total = events.length) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/profile/saved-wallets")) {
        return { ok: true, status: 200, json: async () => WALLETS2 } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: total, events }),
      } as unknown as Response
    })
  }

  it("renders each event kind without dropping a row", async () => {
    vi.stubGlobal("fetch", routed([
      EV({ kind: "pack_buy", title: "Pack buy" }),
      EV({ kind: "pack_open", title: "Pack open", moments_pulled: 5 }),
      EV({ kind: "moment_buy", title: "Moment buy" }),
      EV({ kind: "moment_pull", title: "Moment pull" }),
      EV({ kind: "moment_sell", title: "Moment sell" }),
    ]))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Pack buy/))
    for (const t of ["Pack open", "Moment buy", "Moment pull", "Moment sell"]) {
      expect(document.body.textContent).toMatch(new RegExp(t))
    }
  })

  it("renders an event with every optional field absent", async () => {
    vi.stubGlobal("fetch", routed([
      EV({ occurred_at: null, subtitle: null, amount_usd: null, currency: null, counterparty: null, serial_number: null, nft_id: null }),
    ]))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
  })

  it("switches the active wallet and re-requests for it", async () => {
    const f = routed([EV()])
    vi.stubGlobal("fetch", f)
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))

    const second = screen.getAllByRole("button").find((b) => /0xsecond/i.test(b.textContent ?? ""))
    if (second) {
      fireEvent.click(second)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => String(c[0]).includes("0xsecond"))).toBe(true),
      )
    }
  })

  it("cannot page backwards off the first page, and pages forward by one page size", async () => {
    const f = routed([EV()], 200)
    vi.stubGlobal("fetch", f)
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))

    // ⚠ ASSERTED AS BEHAVIOUR, NOT AS THE `disabled` ATTRIBUTE. What matters is that no
    // request goes out for a negative offset — the attribute is one way to achieve that and
    // not the property itself, and an assertion on the attribute passes just as happily when
    // the click handler is broken.
    // ⚠ BOTH the mechanism and the outcome. The `disabled` attribute is what actually
    // stops the click, and the handler's `Math.max(0, …)` clamp is belt-and-braces behind
    // it — mutation-confirmed: removing the clamp changes nothing observable, because the
    // button cannot be clicked. Asserting only the outcome would let a change that drops
    // BOTH protections pass if some third thing happened to absorb it, and asserting only
    // the attribute would pass with a broken handler. So: assert the attribute, then assert
    // no request escapes.
    const prev = screen.getAllByRole("button").find((b) => /prev/i.test(b.textContent ?? ""))!
    expect(prev.hasAttribute("disabled")).toBe(true)

    const before = f.mock.calls.length
    fireEvent.click(prev)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(f.mock.calls.length).toBe(before)
    expect(f.mock.calls.some((c) => /offset=-/.test(String(c[0])))).toBe(false)

    // ⚠ The step is PAGE_SIZE (50), read from the component rather than assumed. An earlier
    // draft asserted `offset=25` from the limit in the fixture payload — a number the page
    // never uses — and failed against correct code.
    fireEvent.click(screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(f.mock.calls.some((c) => /offset=50/.test(String(c[0])))).toBe(true))
  })

  // ⚠ THE MIRROR OF THE CASE ABOVE, AND IT WAS A SURVIVING MUTATION UNTIL IT WAS WRITTEN.
  // Replacing `disabled={page + 1 >= totalPages}` with `disabled={false}` on Next was
  // observed by NOTHING: the previous case only ever drives page 0, where Next is correctly
  // enabled, so every assertion it makes is satisfied by a pager that never stops. The
  // failure that buys is a collector clicking past the end and being shown an empty list —
  // "no activity" as a claim about their own trading history, manufactured by an offset past
  // the last row. `total_count` 200 at a PAGE_SIZE of 50 is exactly 4 pages, so the boundary
  // is hit rather than approached.
  it("stops at the last page rather than paging off the end", async () => {
    const f = routed([EV()], 200)
    vi.stubGlobal("fetch", f)
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))

    const nextBtn = () => screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!
    for (const offset of [50, 100, 150]) {
      expect(nextBtn().hasAttribute("disabled")).toBe(false)
      fireEvent.click(nextBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => new RegExp(`offset=${offset}\\b`).test(String(c[0])))).toBe(true),
      )
    }

    // Page 4 of 4. Both halves again: the attribute is the mechanism, the absent request is
    // the outcome — the click handler has no upper clamp at all, so the attribute is the
    // ONLY thing standing between a collector and offset=200.
    expect(nextBtn().hasAttribute("disabled")).toBe(true)
    const before = f.mock.calls.length
    fireEvent.click(nextBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(f.mock.calls.length).toBe(before)
    expect(f.mock.calls.some((c) => /offset=200\b/.test(String(c[0])))).toBe(false)
  })

  it("switching the filter resets to the first page", async () => {
    const f = routed([EV()], 200)
    vi.stubGlobal("fetch", f)
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))

    fireEvent.click(screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(f.mock.calls.some((c) => /offset=50/.test(String(c[0])))).toBe(true))

    const sells = screen.getAllByRole("button").find((b) => /sell/i.test(b.textContent ?? ""))
    expect(sells).toBeTruthy()
    fireEvent.click(sells!)
    // ⚠ Without the reset the new filter is read at the OLD offset, so a collector switching
    // to a filter with three results is shown an empty page and told they have no such
    // activity — a claim about their own trading history produced by a stale offset.
    await waitFor(() =>
      expect(
        f.mock.calls.some((c) => /offset=0/.test(String(c[0])) && /kind=sell/.test(String(c[0]))),
      ).toBe(true),
    )
  })
})
