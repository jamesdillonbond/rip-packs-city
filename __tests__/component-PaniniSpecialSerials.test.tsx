// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { PaniniSpecialSerialsSection, ptDay } from "@/components/entity/PaniniEditionExtras"
import { toSpecialSerialRow, fetchPaniniSpecialSerials } from "@/lib/panini/edition-extras"

afterEach(cleanup)
const NOW = Date.parse("2026-10-26T20:00:00Z")
const SINCE = NOW - 7 * 86_400_000

describe("toSpecialSerialRow", () => {
  it("tags all three specials; a fresh listing is an ask, a stale one is 'not re-read', never a live price", () => {
    const fresh = toSpecialSerialRow({ serial_number: 1, mint_cap: 25, is_number_one: true, is_jersey_mint: true, is_listed: true, price_usd: 500, captured_at: "2026-10-25T00:00:00Z", owner: "someone" }, SINCE)
    expect(fresh.tags).toEqual(["#1", "jersey"])
    expect(fresh.askUsd).toBe(500)
    const stale = toSpecialSerialRow({ serial_number: 25, mint_cap: 25, is_perfect_mint: true, is_listed: true, price_usd: 900, captured_at: "2026-10-01T00:00:00Z", owner: "x" }, SINCE)
    expect(stale.askUsd).toBeNull()
    expect(stale.askUnconfirmed).toBe(true)
  })
  it("a blank owner is 'still in a pack'; a $0 last sale is no sale, never $0", () => {
    const r = toSpecialSerialRow({ serial_number: 7, is_jersey_mint: true, owner: "", last_sale_usd: 0 }, SINCE)
    expect(r.sealed).toBe(true)
    expect(r.lastSaleUsd).toBeNull()
  })
})

describe("PaniniSpecialSerialsSection", () => {
  it("three states: failed, ok-empty, rows — and never an owner", () => {
    let c = render(<PaniniSpecialSerialsSection rows={null} />).container
    expect(c.querySelector('[data-testid="panini-specials-failed"]')).not.toBeNull()
    cleanup()
    c = render(<PaniniSpecialSerialsSection rows={[]} />).container
    expect(c.querySelector('[data-testid="panini-specials-empty"]')!.textContent).toMatch(/hasn't read/)
    cleanup()
    const rows = [
      toSpecialSerialRow({ serial_number: 1, mint_cap: 25, is_number_one: true, is_listed: false, owner: "secretowner", last_sale_usd: 1200, last_sale_at: "2026-10-26T06:30:00Z" }, SINCE),
      toSpecialSerialRow({ serial_number: 25, mint_cap: 25, is_perfect_mint: true, is_listed: true, price_usd: 900, captured_at: "2026-10-01T00:00:00Z", owner: "" }, SINCE),
    ]
    c = render(<PaniniSpecialSerialsSection rows={rows} />).container
    const t = c.textContent ?? ""
    expect(t).toContain("#1/25")
    expect(t).toContain("Perfect (last mint)")
    expect(t).toContain("not listed")
    expect(t).toContain("ask not re-read in 7 days")
    expect(t).toContain("still in a pack")
    // 06:30Z on Oct 26 is Oct 25 in PT — the sale day is PT, never the UTC day.
    expect(t).toContain("Oct 25, 2026")
    expect(t).not.toContain("secretowner")
  })
})

describe("ptDay", () => {
  it("is the PT calendar day, and null for no/invalid input", () => {
    expect(ptDay("2026-10-26T06:30:00Z")).toBe("Oct 25, 2026")
    expect(ptDay(null)).toBeNull()
    expect(ptDay("garbage")).toBeNull()
  })
})

describe("fetchPaniniSpecialSerials", () => {
  function db(result: { data: unknown; error: unknown }) {
    const chain: any = {}
    for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
    return { from: () => chain }
  }
  it("a failed read is null (couldn't load), a burnt serial is excluded", async () => {
    expect((await fetchPaniniSpecialSerials("packcard-1", db({ data: null, error: { message: "x" } }), NOW)).rows).toBeNull()
    const ok = await fetchPaniniSpecialSerials("packcard-1", db({ data: [
      { serial_number: 1, is_number_one: true, owner: "a" },
      { serial_number: 2, is_jersey_mint: true, owner: "b", serial_state: "BURNT" },
    ], error: null }), NOW)
    expect(ok.rows!.map((r) => r.serial)).toEqual([1])
  })
})
