// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini products index (2026-10-25). Absence of the false claims: a failed read never renders as "no products";
 * an empty (ok) list says it refreshes; products group by sport, biggest sport first, and each links its page.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniProductIndex, { type PaniniProductIndexRow } from "@/components/entity/PaniniProductIndex"

afterEach(cleanup)

const row = (over: Partial<PaniniProductIndexRow>): PaniniProductIndexRow => ({
  name: "P", slug: "p", sport: "Soccer", editions: 1, sets: 1, fmv_total_usd: 10, listed_editions: 1, sales_30d: 0, ...over,
})

describe("PaniniProductIndex", () => {
  it("a failed read says couldn't load — never an empty list", () => {
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={null} />).container
    expect(c.querySelector('[data-testid="panini-product-index-failed"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="panini-product-index-empty"]')).toBeNull()
  })
  it("an ok empty read says the list refreshes", () => {
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={[]} />).container
    expect(c.querySelector('[data-testid="panini-product-index-empty"]')).not.toBeNull()
  })
  it("groups by sport (largest first), sorts within, and links each product page", () => {
    const rows = [
      row({ name: "Small soccer", slug: "s1", sport: "Soccer", editions: 5 }),
      row({ name: "Big hoops", slug: "b1", sport: "Basketball", editions: 900 }),
      row({ name: "Big soccer", slug: "s2", sport: "Soccer", editions: 50 }),
      row({ name: "No sport", slug: "x", sport: null, editions: 2 }),
    ]
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={rows} />).container
    const h2 = [...c.querySelectorAll("h2")].map((h) => h.textContent)
    expect(h2).toEqual(["Basketball", "Soccer", "Other"])
    const soccer = [...c.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Soccer")!
    expect([...soccer.querySelectorAll("tbody a")].map((a) => a.textContent)).toEqual(["Big soccer", "Small soccer"])
    expect(c.querySelector('a[href="/panini-blockchain/product/b1"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
  })
  it("heads the WNBA group 'WNBA', never Panini's 'Womens Basketball' (2026-10-26)", () => {
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={[row({ name: "Prizm WNBA", slug: "w", sport: "Womens Basketball", editions: 3 })]} />).container
    expect(c.textContent).toContain("WNBA")
    expect(c.textContent).not.toMatch(/womens basketball/i)
  })
})
