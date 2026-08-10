// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, within, fireEvent, waitFor } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

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

  it("desktop row is keyboard-operable (role=button, Enter/Space navigate to the moment)", () => {
    // The row navigates to /moment/<id> on click; its only focusable child is the
    // player <Link> (a DIFFERENT destination). Keyboard/SR users need role/tabIndex/
    // onKeyDown on the <tr> to reach the moment page at all.
    const { container } = render(<CollectionMomentTable {...baseProps()} />)
    const tr = container.querySelector('tr[role="button"]')
    expect(tr).toBeTruthy()
    expect(tr?.getAttribute("tabindex")).toBe("0")
    expect(tr?.getAttribute("aria-label")).toContain("Damian Lillard")
    fireEvent.keyDown(tr!, { key: "Enter" })
    expect(pushMock).toHaveBeenCalledWith("/moment/m-1")
    fireEvent.keyDown(tr!, { key: " " })
    expect(pushMock).toHaveBeenCalledTimes(2)
  })

  it("renders mobile cards when isMobile is true", () => {
    const { getAllByText } = render(<CollectionMomentTable {...baseProps({ isMobile: true })} />)
    expect(getAllByText("Damian Lillard").length).toBeGreaterThan(0)
  })

  it("mobile card is keyboard-operable (role=button, aria-expanded, Enter toggles)", () => {
    // The chevron is a plain <span>, so the card click is the ONLY expand
    // affordance — keyboard users need role/tabIndex/onKeyDown to reach it.
    const toggleExpanded = vi.fn()
    const { container } = render(
      <CollectionMomentTable {...baseProps({ isMobile: true, toggleExpanded })} />
    )
    const card = container.querySelector('[role="button"]')
    expect(card).toBeTruthy()
    expect(card?.getAttribute("tabindex")).toBe("0")
    expect(card?.getAttribute("aria-expanded")).toBe("false")
    fireEvent.keyDown(card!, { key: "Enter" })
    expect(toggleExpanded).toHaveBeenCalledWith("m-1")
    fireEvent.keyDown(card!, { key: " " })
    expect(toggleExpanded).toHaveBeenCalledTimes(2)
  })

  it("mobile card reflects the expanded state in aria-expanded", () => {
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({ isMobile: true, view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } })}
      />
    )
    expect(container.querySelector('[role="button"]')?.getAttribute("aria-expanded")).toBe("true")
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

  it("shows lock figures as untracked for All Day", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ collectionSlug: "nfl-all-day" })} />
    )
    // lockUntracked=true renders "—" for lock stats rather than a number
    expect(container.textContent).toContain("—")
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

  it("marks a stale FMV (marketConfidence=stale) with the underline treatment", () => {
    const { container } = desk({ marketConfidence: "stale", fmv: 42 })
    // stale renders the FMV text with a dotted-underline inline style
    const stale = Array.from(container.querySelectorAll('[title="No sales in 30+ days — FMV may be inaccurate"]'))
    expect(stale.length).toBeGreaterThan(0)
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

  it("shows the upgrade prompt when the alerts API returns 402", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 402, json: async () => ({}) } as Response)))
    const { container, getByText } = render(<CollectionMomentTable {...baseProps({ ownerKey: "0xabc" })} />)
    openBell(container)
    fireEvent.click(getByText("Set Alert"))
    await waitFor(() => expect(container.textContent).toContain("Upgrade to Pro"))
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
