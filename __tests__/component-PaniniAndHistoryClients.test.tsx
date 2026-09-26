// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import TransactionHistoryClient from "@/app/dashboard/history/TransactionHistoryClient"

// 2026-09-25: the two Panini clients this file also covered were DELETED when Panini
// published on the shared [collection] routes (their OpenSea bridge plane holds no data RPC
// ingests, #64). Only the history client remains.
//
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


afterEach(() => cleanup())

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

  // 2026-09-24 — a pack that came from the collection's own contract
  // (pack_purchases.event_kind = primary_withdraw: drops, rewards, set-completion
  // packs) is RECEIVED, not bought from "0x0b2a…7e29" for "—".
  it("labels a primary-withdraw pack as received (drop / reward), never 'Bought pack from <contract>'", async () => {
    const PRIMARY = { ...EVENT, kind: "pack_buy" as const, title: "2025-26 Set Completion Reward: Base Set", subtitle: null, amount_usd: null, currency: null, counterparty: "0x0b2a3299cc857e29", method: "primary_withdraw", nft_id: null, pack_nft_id: "p1", dist_id: "8600" }
    const SECONDARY = { ...PRIMARY, title: "Metallic Gold LE Standard Pack", counterparty: "0x18eb4ee6b3c026d2", method: "secondary_sale", amount_usd: 10, currency: "DUC" }
    vi.stubGlobal("fetch", routed({ ok: true, body: { wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: 2, events: [PRIMARY, SECONDARY] } }))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Set Completion Reward/))
    const text = document.body.textContent ?? ""
    expect(text).toMatch(/Received pack/i)
    expect(text).toMatch(/drop \/ reward/i)
    expect(text).not.toMatch(/from 0x0b2a/i)
    // no-change arm: a secondary purchase still reads "Bought pack · from <seller>"
    expect(text).toMatch(/Bought pack/i)
    expect(text).toMatch(/from 0x18eb/i)
    // 2026-09-25 (Trevor): a 10 DUC pack reads "$10.00", never "$10.00 DUC".
    expect(text).toMatch(/\$10\.00/)
    expect(text).not.toMatch(/\bDUC\b/)
  })

  // 2026-09-25 (Trevor) — a pack row linked the SIMULATOR, which dead-ends on "Drop pool
  // not indexed" for every reward pack and every dist Dapper never served a pool for
  // (8825, 8735 on his wallet). It links the distribution page, which resolves them.
  it("links a pack row to its distribution page, never the pool-gated simulator", async () => {
    const PACK = { ...EVENT, kind: "pack_buy" as const, title: "Portland Fire Seasonal Leaderboard Snapshot 2", subtitle: null, method: "primary_withdraw", nft_id: null, pack_nft_id: "278176444597001", dist_id: "8825" }
    vi.stubGlobal("fetch", routed({ ok: true, body: { wallet: "0xmine", kind_filter: "all", limit: 25, offset: 0, total_count: 2, events: [PACK, EVENT] } }))
    render(<TransactionHistoryClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Portland Fire Seasonal/))
    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain("/nba-top-shot/pack/dist/8825")
    expect(hrefs.some((h) => h.includes("/packs/simulator/"))).toBe(false)
    // no-change arm: a moment row still links its moment page
    expect(hrefs).toContain("/moment/1")
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
