// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// /insights/whales client (2026-11-27). Pins the three states the board must keep
// apart: a FAILED read says it failed (never "no whales"), an OK read with no rows
// says so in words, and a populated board names people by username — or a
// shortened wallet marked "…" — never a raw address.

import WhalesBoardClient from "@/app/insights/whales/WhalesBoardClient"
import { EMPTY_WHALE_BOARD, type WhaleWatchBoard } from "@/lib/whale-watch-board"

afterEach(cleanup)

const BOARD: WhaleWatchBoard = {
  computed_at: "2026-11-27T23:48:23Z",
  tracked_wallets: 573,
  active_7d: 185,
  spend_7d_usd: 132742.37,
  new_tracked_7d: 10,
  leaders: {
    "7d": [
      { rank: 1, username: "cmnkb8", chain: "flow", wallet: null, buys: 34, pack_buys: 3, spent_usd: 10427.48, biggest_usd: 2199, collections: ["nba_top_shot"], last_at: "2026-11-27T15:50:00Z" },
      { rank: 2, username: null, chain: "solana", wallet: "BxtiN3EJMjQzAbCdEfGh9", buys: 104, pack_buys: 0, spent_usd: 3539.94, biggest_usd: 313, collections: ["candy_mlb"], last_at: "2026-11-27T10:00:00Z" },
    ],
    "30d": [
      { rank: 1, username: "spinotron", chain: "panini", wallet: null, buys: 30, pack_buys: 0, spent_usd: 90000, biggest_usd: 57500, collections: ["panini_blockchain"], last_at: "2026-11-26T10:00:00Z" },
    ],
  },
  moves: [
    { at: "2026-11-27T15:50:00Z", collection: "nba_top_shot", kind: "pack", item: "Rookie Debut Case", price_usd: 2020, username: "cmnkb8", chain: "flow", wallet: null, edition_id: null },
    { at: "2026-11-27T12:00:00Z", collection: "candy_mlb", kind: "pack", item: null, price_usd: 300, username: null, chain: "solana", wallet: "BxtiN3EJMjQzAbCdEfGh9", edition_id: null },
  ],
  biggest_30d: [
    { at: "2026-11-20T10:00:00Z", collection: "panini_blockchain", kind: "item", item: "Lamine Yamal · Base Prizms Black", price_usd: 57500, username: "spinotron", chain: "panini", wallet: null, edition_id: null },
  ],
}

describe("WhalesBoardClient", () => {
  it("renders leaders, stats and moves from a populated board", () => {
    const { container, getAllByText } = render(<WhalesBoardClient initialBoard={BOARD} initialFetchedAt={BOARD.computed_at} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Whale Watch")
    expect(text).toContain("573")
    expect(text).toContain("$132,742")
    expect(getAllByText("cmnkb8").length).toBeGreaterThan(0)
    expect(text).toContain("$10,427")
    expect(text).toContain("(3 packs)")
    expect(text).toContain("Rookie Debut Case")
    expect(text).toContain("Candy MLB")
    // A buyer with no username shows a SHORTENED wallet, never the raw key.
    expect(text).toContain("Bxti…fGh9")
    expect(text).not.toContain("BxtiN3EJMjQzAbCdEfGh9")
    // A pack with no resolved name still reads as a pack, not a blank.
    expect(text).toContain("Pack")
  })

  it("the 30-day tab swaps in the 30-day leaders", () => {
    const { container, getByRole } = render(<WhalesBoardClient initialBoard={BOARD} initialFetchedAt={BOARD.computed_at} />)
    fireEvent.click(getByRole("tab", { name: "30 days" }))
    expect(getByRole("tab", { name: "30 days" }).getAttribute("aria-selected")).toBe("true")
    expect(container.textContent).toContain("$90,000")
  })

  it("a FAILED read says it failed and states no market fact", () => {
    const { container, getByRole } = render(
      <WhalesBoardClient initialBoard={EMPTY_WHALE_BOARD} initialFetchedAt={null} initialFailed />,
    )
    expect(getByRole("alert").textContent).toMatch(/couldn.t load/i)
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/No tracked whale bought/)
    expect(text).not.toContain("Whales tracked")
  })

  it("an OK read with no rows says so in words, for each section", () => {
    const empty: WhaleWatchBoard = { ...EMPTY_WHALE_BOARD, computed_at: "2026-11-27T23:48:23Z" }
    const { container } = render(<WhalesBoardClient initialBoard={empty} initialFetchedAt={empty.computed_at} />)
    const text = container.textContent ?? ""
    expect(text).toContain("No tracked whale bought anything in the last 7 days.")
    expect(text).toContain("No whale bought anything for $250 or more in the last 7 days.")
    expect(text).toContain("No whale purchases in the last 30 days.")
  })
})
