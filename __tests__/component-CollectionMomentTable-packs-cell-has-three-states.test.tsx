// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// ⚠ THE PROPERTY, NOT THE SPELLING. This does NOT assert that a "?" appears or
// that any particular copy is used — either would die on a wording change while
// the defect stayed fixed, and neither states the contract. It asserts the
// DISTINCTION: the Packs cell must render something different when the
// sealed-pack read FAILED than when it answered "this wallet holds none".
//
// WHY IT EXISTS (2026-08-29). /api/wallet-packs degrades on purpose — when Top
// Shot GraphQL is down it returns a 200 carrying `{ packsByTitle: {}, error }`,
// and its own comment says the caller "renders nothing". The caller did exactly
// that: `if (d && d.packsByTitle) setPacksByTitle(d.packsByTitle)` treated `{}`
// as an answer, `getPackCount` returned 0, and the column drew the SAME em-dash
// it draws for a real zero. The honest signal was already on the wire; this
// client was the layer dropping it. Live case: `public-api.nbatopshot.com`
// returned Cloudflare 530/503 for 21 h across 2026-08-28/29, which is precisely
// when that branch runs.
//
// ⚠ The failure and the zero must ALSO both differ from a real count, or a
// guard that only compared two of the three would pass on a component that
// rendered "—" for everything.

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))

afterEach(() => { cleanup(); pushMock.mockClear() })

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-1", flowId: "f1", playerName: "Damian Lillard",
    setName: "Base Set", tier: "RARE", editionKey: "73:2785",
    serialNumber: 5, mintCount: 1000, fmv: 42, fmvConfidence: "HIGH",
    badgeInfo: null, parallel: null, subedition: null,
    editionsOwned: 1, editionsLocked: 0, ...over,
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

// Read the one body cell that sits under the "Packs" header, located by the
// header's own column index rather than by a class or nth-child literal, so a
// reordered or added column cannot silently point this test at another cell.
function packsCellText(getPackCount: (setName: string) => number | null): string {
  const { container } = render(
    <CollectionMomentTable {...(baseProps({ getPackCount }) as any)} />,
  )
  const headers = Array.from(container.querySelectorAll("thead th"))
  const idx = headers.findIndex((th) => (th.textContent ?? "").trim() === "Packs")
  expect(idx, "no <th>Packs</th> in the desktop table header").toBeGreaterThanOrEqual(0)
  const firstBodyRow = container.querySelector("tbody tr")
  expect(firstBodyRow, "no body row rendered").not.toBeNull()
  const cells = Array.from(firstBodyRow!.querySelectorAll("td"))
  expect(cells.length, "body row has fewer cells than the header").toBeGreaterThan(idx)
  return (cells[idx].textContent ?? "").trim()
}

describe("the Packs column distinguishes a failed read from a measured zero", () => {
  it("renders a failed read differently from 'this wallet holds no packs'", () => {
    const failed = packsCellText(() => null)
    cleanup()
    const zero = packsCellText(() => 0)
    expect(
      failed,
      "a failed sealed-pack read renders the SAME cell as a real zero — the reader " +
        "cannot tell 'we could not check' from 'you own none'",
    ).not.toBe(zero)
  })

  it("renders a real count differently from both, so the guard is not satisfied by a component that draws one glyph for everything", () => {
    const failed = packsCellText(() => null)
    cleanup()
    const zero = packsCellText(() => 0)
    cleanup()
    const three = packsCellText(() => 3)
    expect(three).toContain("3")
    expect(three).not.toBe(zero)
    expect(three).not.toBe(failed)
  })

  it("still shows the count and its pack link when the read succeeded — the fix must not cost the working case", () => {
    const { container } = render(
      <CollectionMomentTable {...(baseProps({ getPackCount: () => 2 }) as any)} />,
    )
    const link = container.querySelector('a[href*="/packs?wallet="]')
    expect(link, "the pack-count link disappeared").not.toBeNull()
    expect(link!.textContent).toContain("2 packs")
  })
})
