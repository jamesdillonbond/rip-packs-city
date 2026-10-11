// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => new URLSearchParams(),
}))

import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// The mobile binder card shows each moment's lock state (2026-10-10). It has
// THREE states: a lock that was never READ must not render as "Unlocked" —
// getLocked() collapses undefined to false, and "Unlocked" about an unchecked
// moment is a false claim about whether the user can sell it. Pinnacle pins
// cannot lock at all, so they get no pill.

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-1",
    flowId: "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "LEGENDARY",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 28,
    fmv: 42,
    badgeInfo: null,
    editionsOwned: 1,
    editionsLocked: 0,
    ...over,
  }
}

const props = (r: any, slug = "nba-top-shot") => ({
  isMobile: true,
  filteredRows: [r],
  rowsCount: 1,
  summary: { totalMoments: 1, remainingMoments: 0 } as any,
  view: { expandedRows: {}, sortKey: "fmv", sortDir: "desc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map(),
  costBasis: new Map(),
  collectionSeriesMap: new Map(),
  collectionSlug: slug,
  badgeCollectionId: "x",
  connectedWallet: null,
  ownerKey: "0xabc",
  input: "0xabc",
  hasSearched: true,
  loading: false,
  showDebug: false,
  getPackCount: () => 0,
  accent: "#E03A2F",
})

afterEach(cleanup)

const pill = (c: HTMLElement) => c.querySelector("[data-rpc-lock-state]")

describe("mobile binder card — lock pill", () => {
  it("a read lock that is true renders Locked", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: true }))} />)
    expect(pill(container)?.getAttribute("data-rpc-lock-state")).toBe("locked")
    expect(pill(container)?.textContent).toContain("Locked")
  })

  it("a read lock that is false renders Unlocked", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: false }))} />)
    expect(pill(container)?.getAttribute("data-rpc-lock-state")).toBe("unlocked")
  })

  it("an UNREAD lock never renders as Unlocked", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: false, enrichFailed: true }))} />)
    expect(pill(container)?.getAttribute("data-rpc-lock-state")).toBe("unknown")
    expect(pill(container)?.textContent).not.toMatch(/unlocked/i)
  })

  it("Disney Pinnacle (no locking) gets no pill", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: false }), "disney-pinnacle")} />)
    expect(pill(container)).toBeNull()
  })

  it("the thumbnail column holds its place even with no art", () => {
    const { container } = render(<CollectionMomentTable {...props(row())} />)
    expect(container.querySelector("[data-rpc-mobile-thumb]")).not.toBeNull()
  })
})

describe("mobile binder card — a source that SAYS it never checked", () => {
  // get_wallet_moments_with_fmv returns is_locked = false (the column DEFAULT)
  // with lock_known = false for every never-checked row. Before 2026-10-10
  // isLockKnown read the non-null `false` as a measurement, so these rendered
  // "Unlocked".
  it("lockKnown:false + isLocked:false renders Lock ?, never Unlocked", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: false, lockKnown: false }))} />)
    expect(pill(container)?.getAttribute("data-rpc-lock-state")).toBe("unknown")
  })

  it("lockKnown:true + isLocked:false is a real Unlocked", () => {
    const { container } = render(<CollectionMomentTable {...props(row({ isLocked: false, lockKnown: true }))} />)
    expect(pill(container)?.getAttribute("data-rpc-lock-state")).toBe("unlocked")
  })

  it("Golazos and UFC (no locking on-chain) get no pill at all", () => {
    for (const slug of ["laliga-golazos", "ufc"]) {
      const { container, unmount } = render(<CollectionMomentTable {...props(row({ isLocked: false, lockKnown: false }), slug)} />)
      expect(pill(container)).toBeNull()
      unmount()
    }
  })
})
