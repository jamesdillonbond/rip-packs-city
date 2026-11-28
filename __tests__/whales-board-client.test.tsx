// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"

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
      { rank: 1, username: "cmnkb8", chain: "flow", wallet: null, buys: 34, pack_buys: 3, spent_usd: 10427.48, biggest_usd: 2199, collections: ["nba_top_shot"], top_collection: "nba_top_shot", key: "0x8e655887a360cc3f", last_at: "2026-11-27T15:50:00Z" },
      { rank: 2, username: null, chain: "solana", wallet: "BxtiN3EJMjQzAbCdEfGh9", buys: 104, pack_buys: 0, spent_usd: 3539.94, biggest_usd: 313, collections: ["candy_mlb"], top_collection: "candy_mlb", key: "BxtiN3EJMjQzAbCdEfGh9", last_at: "2026-11-27T10:00:00Z" },
    ],
    "30d": [
      { rank: 1, username: "spinotron", chain: "panini", wallet: null, buys: 30, pack_buys: 0, spent_usd: 90000, biggest_usd: 57500, collections: ["panini_blockchain"], top_collection: "panini_blockchain", key: "spinotron", last_at: "2026-11-26T10:00:00Z" },
    ],
  },
  by_collection: {
    nba_top_shot: {
      "7d": [{ rank: 1, username: "cle_287", chain: "flow", wallet: null, buys: 77, pack_buys: 0, spent_usd: 3199.3, biggest_usd: 1200, collections: ["nba_top_shot"], top_collection: "nba_top_shot", key: "0xabcdef0123456789", last_at: "2026-11-27T15:00:00Z" }],
      "30d": [],
    },
    panini_blockchain: { "7d": [], "30d": [] },
  },
  moves: [
    { at: "2026-11-27T15:50:00Z", collection: "nba_top_shot", kind: "pack", item: "Rookie Debut Case", price_usd: 2020, username: "cmnkb8", chain: "flow", wallet: null, key: "0x8e655887a360cc3f", edition_id: null, link_key: "1820" },
    { at: "2026-11-27T12:00:00Z", collection: "candy_mlb", kind: "pack", item: null, price_usd: 300, username: null, chain: "solana", wallet: "BxtiN3EJMjQzAbCdEfGh9", key: null, edition_id: null, link_key: null },
  ],
  biggest_30d: [
    { at: "2026-11-20T10:00:00Z", collection: "panini_blockchain", kind: "item", item: "Lamine Yamal · Base Prizms Black", price_usd: 57500, username: "spinotron", chain: "panini", wallet: null, key: "spinotron", edition_id: null, link_key: "packcard-1828_348521_9088483_2" },
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

  it("names link to the right collection's wallet page; a row with no key stays plain text", () => {
    const { container } = render(<WhalesBoardClient initialBoard={BOARD} initialFetchedAt={BOARD.computed_at} />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    expect(hrefs.some((h) => h.includes("/nba-top-shot/collection") && h.includes("0x8e655887a360cc3f"))).toBe(true)
    // Solana keys keep their case in the link.
    expect(hrefs.some((h) => h.includes("/candy-mlb/collection") && h.includes("BxtiN3EJMjQzAbCdEfGh9"))).toBe(true)
    // Items link to their page: a pack to its detail page, a Panini card to its edition.
    expect(hrefs).toContain("/nba-top-shot/pack/dist/1820")
    expect(hrefs).toContain("/panini-blockchain/edition/packcard-1828_348521_9088483_2")
    expect(hrefs.some((h) => h.includes("simulator"))).toBe(false)
    expect(Array.from(container.querySelectorAll("a")).every((a) => a.getAttribute("rel") === "nofollow" || !a.getAttribute("href")?.includes("/collection"))).toBe(true)
  })

  it("a collection chip shows that collection's own leaders, and says so when it has none", () => {
    const { container, getByRole } = render(<WhalesBoardClient initialBoard={BOARD} initialFetchedAt={BOARD.computed_at} />)
    const group = getByRole("group", { name: "Collection" })
    fireEvent.click(within(group).getByRole("button", { name: "Top Shot" }))
    const text = container.textContent ?? ""
    expect(text).toContain("cle_287")
    expect(text).not.toContain("Collections")
    fireEvent.click(within(group).getByRole("button", { name: "Panini" }))
    expect(container.textContent).toContain("No tracked whale bought anything on Panini in the last 7 days.")
    fireEvent.click(within(group).getByRole("button", { name: "All collections" }))
    expect(container.textContent).toContain("Collections")
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
