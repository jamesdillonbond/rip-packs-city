// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// ActionCell's own logic is: given the URL resolvers, render View/Dapper
// anchors (or an em-dash when both are null) and fire trackClick on click.
// Mock the helpers so we drive each branch deterministically without pulling in
// lib/collections URL builders.
const trackClick = vi.fn()
let viewUrl: string | null = null
let dapperUrl: string | null = null
vi.mock("@/lib/sniper/helpers", () => ({
  resolveViewUrl: () => viewUrl,
  resolveDapperUrl: () => dapperUrl,
  trackClick: (...a: unknown[]) => trackClick(...a),
}))

import { ActionCell } from "@/components/sniper/ActionCell"

const deal: any = { momentId: "1", playerName: "x" }

afterEach(() => {
  cleanup()
  trackClick.mockClear()
  viewUrl = null
  dapperUrl = null
})

describe("ActionCell", () => {
  it("renders an em-dash and no links when neither URL resolves", () => {
    viewUrl = null
    dapperUrl = null
    const { container } = render(<ActionCell deal={deal} accent="#f00" collectionSlug="nba-top-shot" />)
    expect(container.querySelectorAll("a")).toHaveLength(0)
    expect(container.textContent).toContain("—")
  })

  it("renders only the View Listing link when just the view URL resolves", () => {
    viewUrl = "https://ts.example/listing/1"
    dapperUrl = null
    const { container } = render(<ActionCell deal={deal} accent="#0f0" collectionSlug="nba-top-shot" />)
    const links = container.querySelectorAll("a")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("https://ts.example/listing/1")
    expect(links[0].textContent).toContain("View Listing")
    expect(links[0].getAttribute("target")).toBe("_blank")
  })

  it("renders both links when both URLs resolve and fires trackClick on click", () => {
    viewUrl = "https://ts.example/v"
    dapperUrl = "https://dapper.market/d"
    const { container } = render(<ActionCell deal={deal} accent="#00f" collectionSlug="nba-top-shot" />)
    const links = container.querySelectorAll("a")
    expect(links).toHaveLength(2)
    expect(links[1].textContent).toContain("Dapper")
    fireEvent.click(links[0])
    fireEvent.click(links[1])
    expect(trackClick).toHaveBeenCalledTimes(2)
  })
})
