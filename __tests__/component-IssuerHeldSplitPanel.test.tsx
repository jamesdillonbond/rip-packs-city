// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The Top Shot issuer-held split panel on /insights/market-cap, and its fetcher.
// Pins the three states: a failed read says so (no numbers), a split that is not
// provable yet renders its status and NO in-pack / reserve figure (never 0), and a
// known split renders both. Plus: the fetcher throws on an error and on a row set
// missing its collection-total row, and never coerces a null figure to 0.

import IssuerHeldSplitPanel from "@/components/insights/IssuerHeldSplitPanel"
import {
  fetchTopShotIssuerSplit,
  shapeIssuerSplitRow,
  splitStatusCopy,
  type IssuerSplitRow,
} from "@/lib/insights/topshot-issuer-split"

afterEach(cleanup)

function row(over: Partial<IssuerSplitRow>): IssuerSplitRow {
  return {
    tier: "COMMON", editions: 10, hidden: 3_448_191, in_packs: null, reserve: null, editions_split_known: 0,
    editions_stale: 0, hidden_stale: 0, packs_unopened: null, packs_owned_by_collectors: null,
    split_status: "pending: 4210 distribution(s) never read", as_of: null, ...over,
  }
}

describe("fetchTopShotIssuerSplit", () => {
  it("throws on an RPC error rather than returning an empty split", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "57014 canceling statement" } }) }
    await expect(fetchTopShotIssuerSplit(db)).rejects.toThrow("57014")
  })
  it("throws when the collection-total row is missing (the function always returns one)", async () => {
    const db = { rpc: async () => ({ data: [{ tier: "COMMON", editions: 1, editions_split_known: 0, editions_stale: 0, hidden_stale: 0, split_status: "ok" }], error: null }) }
    await expect(fetchTopShotIssuerSplit(db)).rejects.toThrow("collection-total")
  })
  it("keeps a null in-pack / reserve figure null — never 0", () => {
    const r = shapeIssuerSplitRow({ tier: null, editions: 5, hidden: 100, in_packs: null, reserve: null, editions_split_known: 0,
      editions_stale: 0, hidden_stale: 0, packs_unopened: null, packs_owned_by_collectors: null, split_status: "pending: x", as_of: null })
    expect(r.in_packs).toBeNull()
    expect(r.reserve).toBeNull()
    expect(r.packs_unopened).toBeNull()
  })
})

describe("IssuerHeldSplitPanel", () => {
  it("a failed read says so and prints no figures", () => {
    const { container } = render(<IssuerHeldSplitPanel rows={[]} failed />)
    expect(container.textContent).toContain("failed read, not an empty result")
    expect(container.querySelector("table")).toBeNull()
  })

  it("a pending split shows its status and no in-pack or reserve number (not 0)", () => {
    const rows = [row({}), row({ tier: null, hidden: 3_645_405 })]
    const { container } = render(<IssuerHeldSplitPanel rows={rows} failed={false} />)
    expect(container.textContent).toContain("Not known yet")
    const cells = Array.from(container.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent))
    for (const c of cells) {
      expect(c[2]).toBe("—")
      expect(c[3]).toBe("—")
      expect(c[2]).not.toBe("0")
    }
    // The issuer-held total is known independently and is shown.
    expect(container.textContent).toContain("3,645,405")
  })

  it("a known split renders in-packs and reserve, the pack counts, and discloses stale rows", () => {
    const rows = [
      row({ in_packs: 3_000_000, reserve: 448_191, split_status: "ok", editions_split_known: 10, as_of: "2026-10-05T16:00:00Z" }),
      row({ tier: null, hidden: 3_645_405, in_packs: 3_100_000, reserve: 545_405, split_status: "ok", packs_unopened: 1_000_000,
        packs_owned_by_collectors: 900_000, editions_stale: 7, hidden_stale: 22_961, as_of: "2026-10-05T16:00:00Z" }),
    ]
    const { container } = render(<IssuerHeldSplitPanel rows={rows} failed={false} />)
    expect(container.textContent).toContain("3,100,000")
    expect(container.textContent).toContain("545,405")
    expect(container.textContent).toContain("1,000,000 unopened packs, 900,000 of them already bought by collectors")
    expect(container.textContent).toContain("7 editions whose issuer-held count has not refreshed")
    expect(container.textContent).not.toContain("Not known yet")
  })
})

describe("splitStatusCopy", () => {
  it("names a contradiction instead of printing a negative", () => {
    expect(splitStatusCopy("contradicted: more in packs than issuer-held")).toContain("disagree")
  })
})
