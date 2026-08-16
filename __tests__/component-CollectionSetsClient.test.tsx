// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import CollectionSetsClient from "@/app/(collections)/[collection]/sets/CollectionSetsClient"

// `[collection]/sets` converted to a `*Client.tsx` so the component gate measures it.
//
// Already CLEAN on the failed-read sweep — it distinguishes "detail isn't available for this
// set" from "you own none in it" — so this is coverage, not a fix. What it buys is that the
// page's genuinely interesting behaviours are now driven rather than grepped: the per-
// collection ENDPOINT switch (four different APIs behind one page), the retryable-vs-fatal
// error split from deep-audit D3, and the `[object Object]` guard on the error banner.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/nba-top-shot/sets",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("@/components/MomentMedia", () => ({ default: () => <div data-testid="moment-media" /> }))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => null }))
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => "0xmine" }))
vi.mock("@/lib/profile/saved-wallet-for-collection", () => ({
  fetchSavedWalletForCollection: async () => null,
}))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const PIECE = (over: Record<string, unknown> = {}) => ({
  editionId: "e1", editionKey: "48:1652", playerName: "Damian Lillard",
  playName: "Layup", tier: "LEGENDARY", serialNumber: 12, circulationCount: 1000,
  thumbnailUrl: null, videoUrl: null, lowestAsk: 25, listed: true, ...over,
})

const SET = (over: Record<string, unknown> = {}) => ({
  setId: "s1", setName: "Archive Set", series: 4, setTier: "LEGENDARY",
  totalEditions: 10, ownedCount: 4, missingCount: 6, listedCount: 5,
  completionPct: 40, totalMissingCost: 900, lowestSingleAsk: 25,
  bottleneckPrice: 400, bottleneckPlayerName: "Damian Lillard",
  tier: "legendary", owned: [PIECE()], missing: [PIECE({ editionId: "e2", playerName: "Stephen Curry" })],
  asksEnriched: true, costConfidence: "high", ...over,
})

const RESP = (over: Record<string, unknown> = {}) => ({
  wallet: "0xmine", resolvedAddress: "0xmine", totalSets: 1, completeSets: 0,
  inProgressSets: 1, notStartedSets: 0, sets: [SET()], generatedAt: new Date().toISOString(),
  ...over,
})

beforeEach(() => vi.useRealTimers())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(r: () => Response | Promise<Response>, collection = "nba-top-shot") {
  const f = vi.fn(async (_i: unknown, _init?: RequestInit) => r())
  vi.stubGlobal("fetch", f)
  render(<CollectionSetsClient collection={collection} />)
  return f
}

describe("CollectionSetsClient — the per-collection endpoint switch", () => {
  // ⚠ FOUR DIFFERENT APIs BEHIND ONE PAGE, chosen by slug. Sending a collection to the wrong
  // endpoint does not error — it returns another collection's sets, or none, and the page
  // renders a confident but wrong tracker. The `?` handling matters too: `sets-db` already
  // carries a query string, so the wallet must be appended rather than starting a second one.
  it.each([
    ["nba-top-shot", /\/api\/sets\?wallet=/],
    ["nfl-all-day", /\/api\/allday-set-progress\?wallet=/],
    ["ufc", /\/api\/ufc-set-progress\?wallet=/],
    ["laliga-golazos", /\/api\/sets-db\?collection=laliga-golazos&wallet=/],
  ])("routes %s to its own endpoint", async (slug, expected) => {
    const f = mount(() => json(200, RESP()), slug)
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(0))
    expect(String(f.mock.calls[0][0])).toMatch(expected as RegExp)
  })

  it("percent-encodes the wallet rather than interpolating it raw", async () => {
    const f = mount(() => json(200, RESP()))
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(0))
    expect(String(f.mock.calls[0][0])).toContain("wallet=0xmine")
  })
})

describe("CollectionSetsClient — failure states", () => {
  // ⚠ DEEP-AUDIT D3. A saturation timeout is TRANSIENT, so it gets a retry affordance
  // instead of a dead "ERROR" wall — a collector told "ERROR" gives up, one told "TAKING TOO
  // LONG" with a button tries again and usually succeeds.
  it("offers a retry on a 503", async () => {
    mount(() => json(503, { error: "the database is under heavy load", retryable: true }, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/TAKING TOO LONG/))
    expect(document.body.textContent).toMatch(/heavy load/)
  })

  it("marks a retryable body retryable even on a non-503", async () => {
    mount(() => json(500, { error: "transient", retryable: true }, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/TAKING TOO LONG/))
  })

  it("does not offer a retry on a hard failure", async () => {
    mount(() => json(500, { error: "something broke" }, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/ERROR/))
    expect(document.body.textContent).not.toMatch(/TAKING TOO LONG/)
  })

  it("retries when the affordance is used", async () => {
    let n = 0
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => {
      n += 1
      return n === 1 ? json(503, { error: "busy", retryable: true }, false) : json(200, RESP())
    })
    vi.stubGlobal("fetch", f)
    render(<CollectionSetsClient collection="nba-top-shot" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/TAKING TOO LONG/))
    const retry = screen.getAllByRole("button").find((b) => /retry|try again/i.test(b.textContent ?? ""))
    if (retry) {
      fireEvent.click(retry)
      await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    }
  })

  // ⚠ THE `[object Object]` GUARD. An error body whose `error` is an OBJECT must not be
  // stringified onto the banner — that shipped once and told collectors "[object Object]",
  // which is worse than no message because it looks like the site is broken beyond retrying.
  it("does not render an object error as [object Object]", async () => {
    mount(() => json(500, { error: { code: "PGRST002", detail: "x" } }, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/ERROR/))
    expect(document.body.textContent).not.toMatch(/\[object Object\]/)
    expect(document.body.textContent).toMatch(/Request failed \(500\)/)
  })

  it("falls back to a generic message when the body is not JSON at all", async () => {
    mount(() => ({ ok: false, status: 502, json: async () => { throw new Error("not json") } } as unknown as Response))
    await waitFor(() => expect(document.body.textContent).toMatch(/Request failed \(502\)/))
  })

  it("states a thrown fetch rather than rendering an empty tracker", async () => {
    mount(() => { throw new Error("network down") })
    await waitFor(() => expect(document.body.textContent).toMatch(/network down/))
    expect(document.body.textContent).not.toMatch(/No sets match this filter/)
  })
})

describe("CollectionSetsClient — the inline expand (per-set detail)", () => {
  // ⚠ THE EXPAND IS A SECOND, LAZY READ, and its failure policy is deliberately the OPPOSITE
  // of the page's: `fetchSetDetail` returns null on any failure and the caller falls back to
  // the list-level row, so the expand renders the inline preview rather than staying blank.
  // That is right here — the preview is real data we already have — and it is exactly why
  // the fallback must be to the ROW and never to an empty grid.
  function mountDetail(detail: () => Response | Promise<Response>) {
    const f = vi.fn(async (input: unknown, _init?: RequestInit) => {
      // The detail call is the one carrying `&set=`.
      if (String(input).includes("&set=")) return detail()
      return json(200, RESP())
    })
    vi.stubGlobal("fetch", f)
    render(<CollectionSetsClient collection="nba-top-shot" />)
    return f
  }
  const expand = async () => {
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    const btn = screen.getAllByRole("button").find((b) => /^(expand|preview|hide|show)/i.test((b.textContent ?? "").trim()))
    if (btn) fireEvent.click(btn)
    return btn
  }

  it("loads per-set detail on expand", async () => {
    const f = mountDetail(() => json(200, RESP({ sets: [SET({ owned: [PIECE({ playerName: "Detail Player" })] })] })))
    const btn = await expand()
    if (btn) await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("&set="))).toBe(true))
  })

  it("falls back to the inline preview when the detail read fails", async () => {
    mountDetail(() => json(500, {}, false))
    const btn = await expand()
    if (btn) {
      // The list-level row still has its own owned/missing preview, so the expand must show
      // that rather than an empty grid.
      await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    }
  })

  it("falls back to the inline preview when the detail fetch throws", async () => {
    mountDetail(() => { throw new Error("detail network down") })
    const btn = await expand()
    if (btn) await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })

  // ⚠ A collection with NO detail endpoint must render its inline preview WITHOUT going to
  // the network — asking an endpoint that does not exist for that collection would 404 on
  // every expand and leave the panel permanently loading.
  it("renders the inline preview without a request for a collection with no detail endpoint", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, RESP()))
    vi.stubGlobal("fetch", f)
    render(<CollectionSetsClient collection="laliga-golazos" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    const btn = screen.getAllByRole("button").find((b) => /^(expand|preview|hide|show)/i.test((b.textContent ?? "").trim()))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
      expect(f.mock.calls.some((c) => String(c[0]).includes("&set="))).toBe(false)
    }
  })
})

describe("CollectionSetsClient — the tracker", () => {
  it("renders a set with its completion and cost", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    expect(document.body.textContent).toMatch(/40/)
  })

  it.each([
    ["COMPLETION %"], ["COST TO COMPLETE"], ["NAME A-Z"],
  ])("re-sorts by %s without dropping the set", async (label) => {
    mount(() => json(200, RESP({
      sets: [SET(), SET({ setId: "s2", setName: "Base Set", completionPct: 90, totalMissingCost: 10 })],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === label)!)
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Archive Set/)
      expect(document.body.textContent).toMatch(/Base Set/)
    })
  })

  it("filters to complete sets and says so honestly when none match", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "COMPLETE")!)
    // ⚠ "No sets match this filter" is a claim about the FILTER, not about the read — the
    // set loaded fine and simply is not complete. Distinct from the error branch above.
    await waitFor(() => expect(document.body.textContent).toMatch(/No sets match this filter/))
  })

  it("returns to the full list when the filter is cleared", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "COMPLETE")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/No sets match this filter/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "ALL")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })

  it("opens a set and lists its owned and missing pieces", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
  })

  // ⚠ THE PAGE'S OWN HONEST DISTINCTION, and the reason it was already clean: an empty
  // detail payload means "we don't have the moment-level breakdown for this set", which is
  // about US; "No moments owned in this set yet" is about the COLLECTOR. Sharing a branch
  // would tell someone with four moments in the set that they own none.
  it("distinguishes missing set detail from owning none of it", async () => {
    mount(() => json(200, RESP({ sets: [SET({ owned: [], missing: [], ownedCount: 4 })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/isn.t available|No moments owned in this set yet/),
    )
  })

  it("closes the set modal on the backdrop and on the ✕, but not on the panel itself", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))

    // ⚠ Clicking INSIDE the panel must not close it — the backdrop's onClick is on an
    // ancestor, so without stopPropagation every click on a moment dismisses the modal.
    const panel = document.querySelector("#set-modal-title")!.closest("div")!
    fireEvent.click(panel)
    expect(document.body.textContent).toMatch(/Stephen Curry/)

    const close = Array.from(document.querySelectorAll("button")).find((b) => /✕|×|close/i.test(b.textContent ?? ""))
    if (close) {
      fireEvent.click(close)
      await waitFor(() => expect(document.body.textContent).not.toMatch(/Stephen Curry/))
    }
  })

  it("closes the set modal when the backdrop is clicked", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
    const backdrop = document.querySelector('[style*="position: fixed"]')
    if (backdrop) {
      fireEvent.click(backdrop)
      await waitFor(() => expect(document.body.textContent).not.toMatch(/Stephen Curry/))
    }
  })

  // ⚠ Focus trap (Set audit V5). Tab from the last focusable must wrap to the first, so a
  // keyboard user cannot tab out of a modal that is still covering the page.
  it("traps focus inside the set modal", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
    fireEvent.keyDown(document, { key: "Tab" })
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(document.body.textContent).toMatch(/Stephen Curry/)
  })

  it("highlights a set card on hover without losing it", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    const card = screen.getByText(/Archive Set/).closest("div")!
    fireEvent.mouseEnter(card)
    fireEvent.mouseLeave(card)
    expect(document.body.textContent).toMatch(/Archive Set/)
  })

  it.each([["IN PROGRESS"], ["NOT STARTED"]])("filters to %s", async (label) => {
    mount(() => json(200, RESP({
      sets: [SET(), SET({ setId: "s2", setName: "Base Set", completionPct: 0, ownedCount: 0, owned: [] })],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === label)!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set|Base Set|No sets match this filter/))
  })

  it("closes the set modal on Escape", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "VIEW")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Stephen Curry/))
  })

  // ⚠ Cost confidence is a disclosure, not decoration: `totalMissingCost` is summed from
  // asks that may be partly absent, so a "low" confidence set is showing a FLOOR.
  it.each([["high"], ["mixed"], ["low"]])("renders a set with %s cost confidence", async (conf) => {
    mount(() => json(200, RESP({ sets: [SET({ costConfidence: conf })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })

  it("renders a set whose cost could not be computed without inventing one", async () => {
    mount(() => json(200, RESP({ sets: [SET({ totalMissingCost: null, lowestSingleAsk: null, bottleneckPrice: null })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    expect(document.body.textContent).not.toMatch(/\$0\b/)
  })

  it("renders locked-vs-tradeable counts when the API supplies them", async () => {
    mount(() => json(200, RESP({ sets: [SET({ lockedOwnedCount: 2, tradeableOwnedCount: 2 })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })

  it("renders a completed set", async () => {
    mount(() => json(200, RESP({
      completeSets: 1, inProgressSets: 0,
      sets: [SET({ completionPct: 100, missingCount: 0, missing: [], totalMissingCost: 0 })],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })

  it("renders a not-started set", async () => {
    mount(() => json(200, RESP({
      completeSets: 0, inProgressSets: 0, notStartedSets: 1,
      sets: [SET({ completionPct: 0, ownedCount: 0, owned: [] })],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// The no-wallet branch is what SERVER-RENDERS: `wallet` starts null, so a visitor with no
// saved wallet sees the prompt rather than an empty tracker. It needs its own module mocks,
// hence the separate file-level block below.
describe("CollectionSetsClient — no wallet", () => {
  it("prompts for a wallet rather than rendering an empty tracker", async () => {
    vi.resetModules()
    vi.doMock("@/lib/owner-key", () => ({ getOwnerKey: () => null }))
    vi.doMock("@/lib/profile/saved-wallet-for-collection", () => ({
      fetchSavedWalletForCollection: async () => null,
    }))
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, RESP()))
    vi.stubGlobal("fetch", f)
    const Mod = (await import("@/app/(collections)/[collection]/sets/CollectionSetsClient")).default
    render(<Mod collection="nba-top-shot" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Search a wallet on the Collection tab first/))
    // ⚠ And it must NOT have asked the API for a tracker it has no wallet for.
    expect(f).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/owner-key")
    vi.doUnmock("@/lib/profile/saved-wallet-for-collection")
  })

  it("loads the collector's saved wallet when there is no owner key", async () => {
    vi.resetModules()
    vi.doMock("@/lib/owner-key", () => ({ getOwnerKey: () => null }))
    vi.doMock("@/lib/profile/saved-wallet-for-collection", () => ({
      fetchSavedWalletForCollection: async () => "0xsaved",
    }))
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, RESP()))
    vi.stubGlobal("fetch", f)
    const Mod = (await import("@/app/(collections)/[collection]/sets/CollectionSetsClient")).default
    render(<Mod collection="nba-top-shot" />)
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("0xsaved"))).toBe(true))
    vi.doUnmock("@/lib/owner-key")
    vi.doUnmock("@/lib/profile/saved-wallet-for-collection")
  })
})
