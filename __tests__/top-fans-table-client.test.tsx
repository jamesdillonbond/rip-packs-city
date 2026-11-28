// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// components/entity/TopFansTable (Top Collector Leaderboard, 2026-11-27). Pins the panel states
// the table must keep apart — waiting on a census, a FAILED read, a measured empty, and rows —
// plus the collection chips, the rank-by switch, and the partial-FMV marker. Added 11-27 after the
// component shipped with no component test and the coverage ratchet went red on main.

import TopFansTable from "@/components/entity/TopFansTable"
import type { TopFansData, TopFansPanel } from "@/lib/entity/top-fans-format"

afterEach(cleanup)

const DATA: TopFansData = {
  refreshed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  source: "panini_card_serials",
  special_tracked: true,
  holders: 42,
  items: 900,
  rows: [
    { owner: "alice_owner", username: "alice", items: 5, special_items: 2, fmv_usd: 100, fmv_items: 5 },
    { owner: "0x1234567890abcdef", username: null, items: 50, special_items: 0, fmv_usd: 10, fmv_items: 20 },
  ],
}

const panel = (over: Partial<TopFansPanel> = {}): TopFansPanel => ({
  collectionId: "c1",
  urlSlug: "panini-blockchain",
  label: "Panini",
  units: "Cards",
  ok: true,
  data: DATA,
  ...over,
})

describe("TopFansTable", () => {
  it("renders nothing with no panels", () => {
    const { container } = render(<TopFansTable panels={[]} subject="Damian Lillard" />)
    expect(container.textContent).toBe("")
  })

  it("a collection without a full census says the board is coming — no ranking, no 'no collectors'", () => {
    const { container } = render(<TopFansTable panels={[panel({ pending: true, ok: false, data: null })]} subject="Damian Lillard" />)
    expect(container.textContent).toMatch(/waiting on a full on-chain count/)
    expect(container.textContent).not.toMatch(/No collector RPC can see/)
    expect(container.querySelectorAll("a").length).toBe(0)
  })

  it("a FAILED read says it failed, never that nobody holds it", () => {
    const { container } = render(<TopFansTable panels={[panel({ ok: false, data: null })]} subject="Damian Lillard" />)
    expect(container.textContent).toMatch(/Couldn.t load the Panini leaderboard/)
    expect(container.textContent).not.toMatch(/No collector RPC can see/)
  })

  it("a measured empty says so in words", () => {
    const { container } = render(<TopFansTable panels={[panel({ data: { ...DATA, rows: [] } })]} subject="Damian Lillard" />)
    expect(container.textContent).toMatch(/No collector RPC can see holds Damian Lillard on Panini yet/)
  })

  it("ranks by FMV by default, names a username with @ and a wallet shortened, and marks a partial FMV", () => {
    const { container } = render(<TopFansTable panels={[panel()]} subject="Damian Lillard" />)
    const links = [...container.querySelectorAll("a")]
    expect(links.length).toBe(2)
    expect(links[0].textContent).toMatch(/@alice/) // $100 ranks first by FMV
    expect(links[1].textContent).not.toContain("0x1234567890abcdef") // shortened for display
    expect(links[1].textContent).toMatch(/\*/) // 20 of 50 priced
    expect(links[0].getAttribute("rel")).toBe("nofollow")
    expect(container.textContent).toMatch(/42 collectors seen holding 900 cards/)
  })

  it("re-ranks by item count and by special serials", () => {
    const { container, getByText, getByRole } = render(<TopFansTable panels={[panel()]} subject="Damian Lillard" />)
    fireEvent.click(getByRole("button", { name: "Cards" }))
    expect(container.querySelectorAll("a")[0].textContent).not.toMatch(/@alice/) // 50 items ranks first
    fireEvent.click(getByText("Special serials"))
    const links = [...container.querySelectorAll("a")]
    expect(links[0].textContent).toMatch(/@alice/)
  })

  it("a special-serial ranking with no special holder says that, not that nobody holds it", () => {
    const rows = DATA.rows.map((r) => ({ ...r, special_items: 0 }))
    const { container, getByText } = render(<TopFansTable panels={[panel({ data: { ...DATA, rows } })]} subject="Damian Lillard" />)
    fireEvent.click(getByText("Special serials"))
    expect(container.querySelectorAll("a").length).toBe(0)
    expect(container.textContent).toMatch(/No collector RPC can see holds a special serial of Damian Lillard on Panini/)
  })

  it("disables the special-serial ranking where serials are not tracked and shows a dash", () => {
    const { container, getByText } = render(<TopFansTable panels={[panel({ data: { ...DATA, special_tracked: false } })]} subject="Damian Lillard" />)
    const btn = getByText("Special serials") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain("—")
    expect(container.textContent).not.toMatch(/Special serials are #1/)
  })

  it("collection chips switch the panel", () => {
    const two = [panel(), panel({ collectionId: "c2", urlSlug: "candy-mlb", label: "Candy", units: "Moments", ok: false, data: null })]
    const { container, getByText } = render(<TopFansTable panels={two} subject="Batman" />)
    expect(container.querySelectorAll("a").length).toBe(2)
    fireEvent.click(getByText("Candy"))
    expect(container.textContent).toMatch(/Couldn.t load the Candy leaderboard/)
    expect(getByText("Candy").getAttribute("aria-pressed")).toBe("true")
  })
})
