// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import CollectionMomentTable, { COLLECTION_PAGE } from "@/components/collection/CollectionMomentTable"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Render coverage for the ~850-line wallet moment table (mobile cards + desktop
// table + expanded panel). It was entirely untested despite being the primary
// collection-page surface. This drives the render tree across the branches that
// change what a collector SEES: tier chip, lock state (incl. the All Day
// "untracked" special case), badge pills (with the three-star rookie
// suppression), cost-basis presence, and the expanded panel; plus the empty
// state. Pure render/prop component — no fetch, no router navigation asserted.

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))

afterEach(() => { cleanup(); pushMock.mockClear() })

// Minimal-but-valid MomentRow. Cast as any: the type has many optional fields
// the render tree tolerates; we only set what a branch reads.
function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-" + (over.momentId ?? "1"),
    flowId: over.flowId ?? "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 1000,
    fmv: 42,
    fmvConfidence: "HIGH",
    badgeInfo: null,
    parallel: null,
    subedition: null,
    editionsOwned: 1,
    editionsLocked: 0,
    ...over,
  }
}

const baseProps = (over: Record<string, any> = {}) => ({
  isMobile: false,
  filteredRows: [row()],
  rowsCount: 1,
  summary: { totalMoments: 1 } as any,
  view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map(),
  costBasis: new Map(),
  collectionSeriesMap: new Map(),
  collectionSlug: "nba-top-shot",
  badgeCollectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  connectedWallet: null,
  ownerKey: "0xabc",
  input: "0xabc",
  hasSearched: true,
  loading: false,
  showDebug: false,
  getPackCount: () => 0,
  accent: "#E03A2F",
  ...over,
})

describe("CollectionMomentTable", () => {
  it("renders the desktop table with player, set and tier for a row", () => {
    const { container, getAllByText } = render(<CollectionMomentTable {...baseProps()} />)
    expect(getAllByText("Damian Lillard").length).toBeGreaterThan(0)
    expect(getAllByText("RARE").length).toBeGreaterThan(0)
    // the set name is normalized + linked
    expect(container.querySelector('a[href="/nba-top-shot/set/base-set"]')).toBeTruthy()
    // player link
    expect(container.querySelector('a[href="/nba-top-shot/player/damian-lillard"]')).toBeTruthy()
  })

  it("desktop row reaches the moment by a real focusable link, and the row itself is not a nested-interactive button (#196)", () => {
    // The row navigates to /moment/<id> on click (a mouse convenience). The
    // keyboard/SR path is the thumbnail <Link> to the SAME href. A role="button"
    // <tr> containing links is axe `nested-interactive` (serious), so the row
    // must carry no role and no tabindex.
    const { container } = render(<CollectionMomentTable {...baseProps()} />)
    const tr = container.querySelector("tbody tr")
    expect(tr).toBeTruthy()
    expect(tr?.getAttribute("role")).toBeNull()
    expect(tr?.getAttribute("tabindex")).toBeNull()
    const link = tr!.querySelector('a[href="/moment/m-1"]')
    expect(link).toBeTruthy()
    expect(link?.getAttribute("aria-label")).toContain("Damian Lillard")
    expect(container.querySelector('[role="button"]')).toBeNull()
    // The mouse convenience survives: clicking a non-link cell still navigates.
    fireEvent.click(tr!.querySelector("td:last-child")!)
    expect(pushMock).toHaveBeenCalledWith("/moment/m-1")
  })

  it("renders mobile cards when isMobile is true", () => {
    const { getAllByText } = render(<CollectionMomentTable {...baseProps({ isMobile: true })} />)
    expect(getAllByText("Damian Lillard").length).toBeGreaterThan(0)
  })

  it("mobile card expands from a real disclosure <button>, and the card is not a nested-interactive button (#196)", () => {
    const toggleExpanded = vi.fn()
    const { container } = render(
      <CollectionMomentTable {...baseProps({ isMobile: true, toggleExpanded })} />
    )
    expect(container.querySelector('[role="button"]')).toBeNull()
    const btn = container.querySelector("button[aria-expanded]") as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    expect(btn.getAttribute("aria-label")).toContain("Damian Lillard")
    fireEvent.click(btn)
    // Exactly once: the button stops propagation, so the card's own mouse
    // handler does not toggle it a second time (which would be a no-op toggle).
    expect(toggleExpanded).toHaveBeenCalledTimes(1)
    expect(toggleExpanded).toHaveBeenCalledWith("m-1")
  })

  it("mobile card reflects the expanded state in aria-expanded", () => {
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({ isMobile: true, view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } })}
      />
    )
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true")
  })

  it("suppresses rookie badges on a three-star rookie but keeps non-rookie pills", () => {
    const threeStar = row({
      momentId: "2",
      badgeInfo: {
        is_three_star_rookie: true,
        // "Rookie Year" is in ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR (hidden);
        // "Top Shot Debut" is a pill but not a rookie badge (kept).
        badge_titles: ["Rookie Year", "Top Shot Debut"],
      },
    })
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [threeStar], rowsCount: 1 })} />
    )
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders badge pills for a non-three-star row (rookie badges kept)", () => {
    const withBadges = row({
      momentId: "4",
      badgeInfo: { is_three_star_rookie: false, badge_titles: ["Rookie Year", "Championship Year"] },
    })
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [withBadges], rowsCount: 1 })} />
    )
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders the expanded panel when the row is expanded", () => {
    const props = baseProps({
      view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
      costBasis: new Map([
        ["f1", { buyPrice: 10, acquiredDate: "2026-01-01", fmvAtAcquisition: 8, acquisitionMethod: "pack_pull", costBasisLabel: "Pack pull" }],
      ]),
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    // expanded panel exists → chevron flips to the open glyph somewhere
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders an expanded badge panel with NULL burn/lock/circulation without crashing", () => {
    // Regression: badge_editions.burn_rate_pct/lock_rate_pct/circulation_count are
    // nullable (~16 rendered editions incl. Wembanyama S6). An unguarded
    // .toFixed()/.toLocaleString() on null used to throw and white-screen the whole
    // table when such a row was expanded. Panel is gated on badge_score, so set it.
    const nullBadge = row({
      badgeInfo: {
        badge_score: 5,
        badge_titles: [],
        is_three_star_rookie: false,
        burn_rate_pct: null,
        lock_rate_pct: null,
        circulation_count: null,
        owned: 0,
        burned: 0,
        hidden_in_packs: 0,
      },
    })
    const props = baseProps({
      filteredRows: [nullBadge],
      rowsCount: 1,
      view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    // Renders (no throw) and shows the "—" fallback for the null rate fields.
    expect(container.textContent).toContain("Burn rate: —")
    expect(container.textContent).toContain("Lock rate: —")
  })

  // INVERTED 2026-09-28. This pinned the All Day suppression ("—" for lock
  // figures by collection slug); that was the mirror defect, since All Day's lock
  // data is the freshest of any collection. The property now: the SLUG does not
  // change what the table renders for identical rows.
  it("All Day shows its locked count like any lockable collection (desktop Held / Locked, mobile badge)", () => {
    const rows = [row({ editionsOwned: 3, editionsLocked: 2 })]
    const desktop = render(<CollectionMomentTable {...baseProps({ collectionSlug: "nfl-all-day", filteredRows: rows })} />)
    expect(desktop.container.textContent).toContain("3 / 2")
    expect(desktop.container.textContent).not.toContain("3 / —")
    desktop.unmount()
    const mobile = render(<CollectionMomentTable {...baseProps({ collectionSlug: "nfl-all-day", isMobile: true, filteredRows: rows })} />)
    expect(mobile.container.textContent).toContain("2🔒")
  })

  it("no collection slug decides lock display in the table source", () => {
    const src = readFileSync(join(process.cwd(), "components", "collection", "CollectionMomentTable.tsx"), "utf8")
      .replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/lockUntracked/)
    expect(src).not.toMatch(/collectionSlug\s*===\s*"nfl-all-day"/)
  })

  it("renders an empty state when there are no rows", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [], rowsCount: 0 })} />
    )
    // no player row rendered
    expect(container.textContent).not.toContain("Damian Lillard")
  })

  it("renders a row with no player/set name without crashing (null-name fallbacks)", () => {
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({ filteredRows: [row({ momentId: "3", playerName: null, setName: null, tier: null })], rowsCount: 1 })}
      />
    )
    expect(container).toBeTruthy()
  })
})

// The cost-basis cell is a label-ladder (Bought / Pack / Loan / Gift / Reward /
// Airdrop / generic / last-purchase / —), the P&L cell branches on sign, and the
// ask cell chooses low-ask vs edition-floor vs —. jsdom ignores the `hidden
// xl:table-cell` classes, so every desktop cell is in the DOM and assertable.
// The base suite only ever rendered a row with none of these set, leaving the
// whole acquisition-accounting surface (what a collector reads to value a moment)
// dark.
describe("CollectionMomentTable — cost basis / P&L / ask cells", () => {
  const desk = (over: Record<string, any>) =>
    render(<CollectionMomentTable {...baseProps({ filteredRows: [row(over)], rowsCount: 1 })} />)

  it("renders a Loan Default acquisition with its principal", () => {
    const { container } = desk({ costBasisLabel: "Loan", costBasis: 50 })
    expect(container.textContent).toContain("Loan Default")
    expect(container.textContent).toContain("$50.00")
  })

  it("renders a Bought price, and the TS source pill when the source is a TS backfill", () => {
    const { container } = desk({ costBasisLabel: "Bought", costBasis: 25, acquisitionSource: "wallet_search" })
    expect(container.textContent).toContain("$25.00")
    expect(container.textContent).toContain("TS") // TS_SOURCES source pill
  })

  it("renders the Pack / Gift / Reward / Airdrop chips", () => {
    expect(desk({ costBasisLabel: "Pack" }).container.textContent).toContain("PACK")
    expect(desk({ costBasisLabel: "Gift" }).container.textContent).toContain("GIFT")
    expect(desk({ costBasisLabel: "Reward" }).container.textContent).toContain("REWARD")
    expect(desk({ costBasisLabel: "Airdrop" }).container.textContent).toContain("AIRDROP")
  })

  it("falls back to the last-purchase price when no cost basis label is present", () => {
    const { container } = desk({ costBasisLabel: null, costBasis: null, lastPurchasePrice: 12.5 })
    expect(container.textContent).toContain("$12.50")
  })

  it("shows a positive P&L for a moment worth more than its basis", () => {
    // basis 20, fmv 42 -> +22.00 / +110%
    const { container } = desk({ costBasisLabel: "Bought", costBasis: 20, fmv: 42 })
    expect(container.textContent).toContain("+22.00")
    expect(container.textContent).toContain("110%")
  })

  it("shows a negative P&L for a moment worth less than its basis", () => {
    // basis 42, fmv 20 -> -22.00 / -52%
    const { container } = desk({ costBasisLabel: "Bought", costBasis: 42, fmv: 20 })
    expect(container.textContent).toContain("-22.00")
    expect(container.textContent).toContain("-52%")
  })

  it("prices the ask cell from lowAsk, and from the edition floor when no per-serial ask exists", () => {
    expect(desk({ lowAsk: 30, fmv: 42 }).container.textContent).toContain("$30.00")
    const floor = desk({ lowAsk: null, editionLowAsk: 35, fmv: 42 }).container
    expect(floor.textContent).toContain("$35.00")
    expect(floor.textContent).toContain("floor")
  })

  it("shows the ×N edition-count badge with a locked count on mobile cards", () => {
    // The ×N (N🔒) duplicate-holdings badge is a mobile-card branch (desktop
    // instead shows a Held / Locked column), so this drives the mobile path.
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({ isMobile: true, filteredRows: [row({ editionsOwned: 3, editionsLocked: 1 })], rowsCount: 1 })}
      />
    )
    expect(container.textContent).toContain("×3")
    expect(container.textContent).toContain("1🔒")
  })
})

describe("CollectionMomentTable — empty state message", () => {
  it("shows the no-moments message after a search returns nothing", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [], rowsCount: 0, hasSearched: true, loading: false })} />
    )
    expect(container.textContent).toContain("No moments found")
  })

  it("does NOT show the no-moments message while still loading", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [], rowsCount: 0, hasSearched: true, loading: true })} />
    )
    expect(container.textContent).not.toContain("No moments found")
  })
})

// The desktop player cell renders an acquisition-method chip (acqConfig), the
// Acquired column renders a second chip (acqPillMap), the serial/mint cell shows
// a primary-serial badge, the Held/Locked column shows circulation intel, the
// Packs column links when a count exists, and the FMV cell shows a Paid line and
// a best-offer Flip. None of those were driven by the base suite.
describe("CollectionMomentTable — desktop chips / badges / offer cells", () => {
  const desk = (over: Record<string, any>, propsOver: Record<string, any> = {}) =>
    render(<CollectionMomentTable {...baseProps({ filteredRows: [row(over)], rowsCount: 1, ...propsOver })} />)

  it("renders the acquisition-method chips (pack / mkt / reward / gift / loan / airdrop / unverified)", () => {
    expect(desk({ momentId: "1", acquisitionMethod: "pack_pull" }).container.textContent).toContain("PACK")
    expect(desk({ momentId: "2", acquisitionMethod: "marketplace" }).container.textContent).toContain("MKT")
    expect(desk({ momentId: "3", acquisitionMethod: "challenge_reward" }).container.textContent).toContain("REWARD")
    expect(desk({ momentId: "4", acquisitionMethod: "gift" }).container.textContent).toContain("GIFT")
    expect(desk({ momentId: "5", acquisitionMethod: "loan_default" }).container.textContent).toContain("LOAN DEFAULT")
    expect(desk({ momentId: "6", acquisitionMethod: "airdrop" }).container.textContent).toContain("AIRDROP")
    // "unknown" hits acqConfig's UNVERIFIED chip AND the acqPillMap null-branch.
    expect(desk({ momentId: "7", acquisitionMethod: "unknown" }).container.textContent).toContain("UNVERIFIED")
  })

  it("renders the primary-serial badge (#1) in the serial cell", () => {
    const { container } = desk({ specialSerialTraits: ["#1"], serialNumber: 1 })
    expect(container.textContent).toContain("#1")
  })

  it("renders circulation intelligence in the Held/Locked column", () => {
    const { container } = desk({
      badgeInfo: { circulation_count: 500, owned: 100, for_sale_by_collectors: 20, hidden_in_packs: 5, burned: 10, badge_titles: [] },
    })
    expect(container.textContent).toContain("500 minted")
    expect(container.textContent).toContain("10 burned")
    expect(container.textContent).toContain("5 in packs")
  })

  it("renders the 1/1 marker for a single-mint edition", () => {
    const { container } = desk({ badgeInfo: { circulation_count: 1, owned: 1, burned: 0, hidden_in_packs: 0, badge_titles: [] } })
    expect(container.textContent).toContain("1/1")
  })

  it("links the Packs column when the wallet holds packs from the set", () => {
    expect(desk({}, { getPackCount: () => 2 }).container.textContent).toContain("2 packs")
    expect(desk({}, { getPackCount: () => 1 }).container.textContent).toContain("1 pack")
  })

  it("shows the Paid line in the FMV cell from lastPurchasePrice", () => {
    const { container } = desk({ lastPurchasePrice: 15, costBasis: null, costBasisLabel: null })
    expect(container.textContent).toContain("Paid")
    expect(container.textContent).toContain("$15.00")
  })

  it("shows a best-offer with a Flip badge when the offer beats the best ask", () => {
    const { container } = desk({ bestOffer: 100, lowAsk: 50, fmv: 42 })
    expect(container.textContent).toContain("Flip")
    expect(container.textContent).toContain("$100.00")
  })

  it("shows a plain best-offer (no Flip) when it does not beat the ask", () => {
    const { container } = desk({ editionBestOffer: 10, lowAsk: null, fmv: 42 })
    expect(container.textContent).toContain("$10.00")
    expect(container.textContent).not.toContain("Flip")
  })

  it("renders a serial-fmv badge beside the FMV when present", () => {
    const { container } = desk({ serialFmv: { estimate_usd: 5000, multiplier: 3, serial_bucket: "first" } })
    expect(container.textContent).toContain("#1 est")
  })

  it("renders a muted em-dash FMV for a row with no FMV", () => {
    const { container } = desk({ fmv: null, fmvUsd: null })
    expect(container.textContent).toContain("—")
  })

  // 2026-10-18 (Trevor): confidence is internal only. A stale FMV renders
  // PLAIN — no dotted underline, not greyed, no "may be inaccurate" — and keeps
  // only the factual "No sales in 30+ days" tooltip.
  it("renders a stale FMV (marketConfidence=stale) plain: no underline, no muting, no inaccuracy claim", () => {
    const { container } = desk({ marketConfidence: "stale", fmv: 42 })
    const stale = (Array.from(container.querySelectorAll("[title]")) as HTMLElement[]).filter((el) => el.getAttribute("title") === "No sales in 30+ days")
    expect(stale.length).toBeGreaterThan(0)
    for (const el of stale) {
      expect(el.style.textDecoration).toBe("")
      expect(el.className).not.toContain("--rpc-text-muted")
      expect(el.textContent).toContain("$42.00")
    }
    expect(container.querySelector('[title*="may be inaccurate"]')).toBeNull()
  })

  it("renders the three-star rookie mint badge when has_rookie_mint is set", () => {
    const { container } = desk({
      badgeInfo: { is_three_star_rookie: true, has_rookie_mint: true, badge_titles: [] },
    })
    expect(container.querySelector('[title="Three-Star Rookie"]')).toBeTruthy()
  })
})

// The FMV-alert popover (bell → target price → notify channel → POST /api/alerts)
// and the debug-column / rich-badge expanded panel both mount fetch-backed
// children, so they get their own stubbed describe.
describe("CollectionMomentTable — FMV alert popover + rich expanded panel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ sales: [] }) } as Response)))
  })
  afterEach(() => vi.unstubAllGlobals())

  function openBell(container: HTMLElement) {
    const bell = container.querySelector('[title="Set FMV alert"]') as HTMLElement
    expect(bell).toBeTruthy()
    fireEvent.click(bell)
  }

  it("opens the alert popover, switches to telegram, submits and confirms success", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)))
    const { container, getByText } = render(<CollectionMomentTable {...baseProps({ ownerKey: "0xabc" })} />)
    openBell(container)
    expect(container.textContent).toContain("SET FMV ALERT")
    const telegram = Array.from(container.querySelectorAll('input[type="radio"]'))[1] as HTMLElement
    fireEvent.click(telegram)
    fireEvent.click(getByText("Set Alert"))
    await waitFor(() => expect(container.textContent).toContain("Alert set!"))
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/api/alerts"))
    expect(JSON.parse(call[1].body).channel).toBe("telegram")
  })

  // INVERTED 2026-09-25 (Trevor): no paid account is mentioned anywhere on
  // the site until 100 weekly active users. A refused alert says it failed —
  // it never offers an upgrade or names a Pro tier.
  it("a refused alert (402) shows a plain failure, never an upgrade prompt", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 402, json: async () => ({}) } as Response)))
    const { container, getByText } = render(<CollectionMomentTable {...baseProps({ ownerKey: "0xabc" })} />)
    openBell(container)
    fireEvent.click(getByText("Set Alert"))
    await waitFor(() => expect(container.textContent).toContain("Failed to set alert"))
    expect(container.textContent).not.toMatch(/upgrade|\bpro\b|free tier/i)
  })

  it("shows the sign-in prompt when there is no owner wallet", () => {
    const { container, getByText } = render(
      <CollectionMomentTable {...baseProps({ ownerKey: "", input: "", connectedWallet: null })} />
    )
    openBell(container)
    fireEvent.click(getByText("Set Alert"))
    expect(container.textContent).toContain("Sign in")
  })

  it("renders the rich expanded panel with debug columns, traits, fmv method and badge stats", () => {
    const richRow = row({
      fmvMethod: "band",
      specialSerialTraits: ["Rookie Trait"],
      badgeInfo: {
        badge_score: 7,
        badge_titles: [],
        is_three_star_rookie: false,
        burn_rate_pct: 12.5,
        lock_rate_pct: 3.2,
        circulation_count: 500,
        effective_supply: 480,
        owned: 100,
        for_sale_by_collectors: 20,
        hidden_in_packs: 5,
        burned: 10,
        low_ask: 33,
      },
    })
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({
          filteredRows: [richRow],
          rowsCount: 1,
          showDebug: true,
          view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
        })}
      />
    )
    expect(container.textContent).toContain("Scope Key")
    expect(container.textContent).toContain("Avg sales price") // fmvMethod=band label
    expect(container.textContent).toContain("Rookie Trait")
    expect(container.textContent).toContain("Circ:")
    expect(container.textContent).toContain("Edition ask:")
  })
})

// 2026-10-20: on desktop the tab auto-fetches every page of the wallet and
// rendered every row (~21,000 elements for the test wallet's 365 moments). The
// RENDER now pages by COLLECTION_PAGE; every loaded row still feeds filters/sort.
describe("CollectionMomentTable — rows render a page at a time", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row({ momentId: String(i), flowId: `f${i}`, playerName: `Player ${i}` }))
  const has = (c: HTMLElement, name: string) => (c.textContent ?? "").includes(name)

  for (const isMobile of [false, true]) {
    it(`renders the first COLLECTION_PAGE rows, then SHOW MORE adds the next page (${isMobile ? "mobile" : "desktop"})`, () => {
      const { container, getByRole } = render(<CollectionMomentTable {...baseProps({ isMobile, filteredRows: many(250), rowsCount: 250 })} />)
      expect(has(container, `Player ${COLLECTION_PAGE - 1}`)).toBe(true)
      expect(has(container, `Player ${COLLECTION_PAGE}`)).toBe(false)
      expect(container.textContent).toContain(`SHOWING ${COLLECTION_PAGE} OF 250`)
      fireEvent.click(getByRole("button", { name: `SHOW ${COLLECTION_PAGE} MORE` }))
      expect(has(container, `Player ${2 * COLLECTION_PAGE - 1}`)).toBe(true)
      expect(container.textContent).toContain(`SHOWING ${2 * COLLECTION_PAGE} OF 250`)
    })
  }

  it("a background page appending rows does NOT snap SHOW MORE back to the first page", () => {
    const props = baseProps({ filteredRows: many(150), rowsCount: 150 })
    const { container, getByRole, rerender } = render(<CollectionMomentTable {...props} />)
    fireEvent.click(getByRole("button", { name: "SHOW 50 MORE" }))
    expect(has(container, "Player 149")).toBe(true)
    // The auto-paginate loop delivers 100 more: a NEW array, same view.
    rerender(<CollectionMomentTable {...props} filteredRows={many(250)} rowsCount={250} />)
    expect(has(container, "Player 149")).toBe(true)
    // The click asked for one more page (100 + 100), so the new rows fill it in;
    // the failure this pins is a reset to the first 100.
    expect(container.textContent).toContain(`SHOWING ${2 * COLLECTION_PAGE} OF 250`)
    expect(container.textContent).not.toContain(`SHOWING ${COLLECTION_PAGE} OF 250`)
  })

  it("a sort or filter change starts again at the first page", () => {
    const props = baseProps({ filteredRows: many(250), rowsCount: 250 })
    const { container, getByRole, rerender } = render(<CollectionMomentTable {...props} />)
    fireEvent.click(getByRole("button", { name: `SHOW ${COLLECTION_PAGE} MORE` }))
    rerender(<CollectionMomentTable {...props} view={{ ...props.view, sortKey: "fmv" }} />)
    expect(container.textContent).toContain(`SHOWING ${COLLECTION_PAGE} OF 250`)
    rerender(<CollectionMomentTable {...props} view={{ ...props.view, sortKey: "fmv", rarityFilter: "RARE" }} />)
    expect(has(container, `Player ${COLLECTION_PAGE}`)).toBe(false)
  })

  it("a wallet of COLLECTION_PAGE or fewer shows no pager", () => {
    const { container } = render(<CollectionMomentTable {...baseProps({ filteredRows: many(40), rowsCount: 40 })} />)
    expect(has(container, "Player 39")).toBe(true)
    expect(container.textContent).not.toContain("SHOWING")
  })
})

// 10-28 axe (surfaced while Dapper's image host was down): the moment-art fallback painted white initials on the
// collection accent — 4.36:1 on Top Shot's #E03A2F, 2.2–4.0:1 on the others. It now takes the house pair from
// lib/accent-text.ts: accentFill() under labelOn() (white on the deeper red fill; near-black on every other accent).
describe("CollectionMomentTable — moment-art fallback reads on every collection accent", () => {
  const fallbackFor = (accent: string) => {
    const { container } = render(<CollectionMomentTable {...baseProps({ accent, filteredRows: [row({ momentId: "9" })], rowsCount: 1 })} />)
    for (const img of container.querySelectorAll("td img")) fireEvent.error(img)
    const el = (container.querySelector("[data-rpc-fallback]") ??
      [...container.querySelectorAll("td a")].find((a) => a.textContent === "DL")) as HTMLElement | undefined
    expect(el, "a fallback tile renders").toBeTruthy()
    return el!
  }

  it("Top Shot red: white on the deeper --rpc-red-fill, never on #E03A2F itself", () => {
    const el = fallbackFor("#E03A2F")
    expect(el.style.background).toBe("var(--rpc-red-fill)")
    expect(el.style.color).toMatch(/^(#fff|rgb\(255, 255, 255\))$/)
  })

  it("a light accent (Golazos green): near-black initials, the accent kept as the fill", () => {
    const el = fallbackFor("#22C55E")
    expect(el.style.color).toMatch(/^(#0B0B0D|rgb\(11, 11, 13\))$/i)
    expect(el.style.background.toLowerCase()).toMatch(/#22c55e|rgb\(34, 197, 94\)/)
  })
})
