// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

/**
 * PaniniAnalytics — the Panini sales analytics tab (2026-09-28), over panini_sales with
 * per-day coverage. Stated as the ABSENCE of false claims: a partial day draws no bar (its
 * height is the read-timing artefact that once showed a false ~90% collapse), a partial window
 * reads "at least", a failed read is not zeros, and no buyer/seller handle is shown.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniAnalytics, { COMPLETE_PCT, isCompleteDay, type PaniniSalesAnalytics } from "@/components/collection/PaniniAnalytics"
import { parsePaniniSalesAnalytics } from "@/lib/panini/sales-analytics"

function payload(over: Partial<PaniniSalesAnalytics> = {}): PaniniSalesAnalytics {
  return {
    generated_at: "2026-09-29T16:00:00Z",
    days: 3,
    coverage: { active_editions: 100, editions_read: 97, editions_whole_history: 40, editions_with_gaps: 2, first_read_at: "2026-09-29T09:00:00Z", last_read_at: "2026-09-29T15:00:00Z", sales_held: 60000, sales_from_full_records: 8000 },
    daily: [
      { day: "2026-09-27", sales: 300, volume_usd: 6000, median_usd: 5, covered_pct: 97 },
      { day: "2026-09-28", sales: 250, volume_usd: 5000, median_usd: 6, covered_pct: 96 },
      { day: "2026-09-29", sales: 12, volume_usd: 90, median_usd: 4, covered_pct: 10 },
    ],
    window: { sales: 562, volume_usd: 11090, median_usd: 5, editions_traded: 80, cards_traded: 550 },
    top_sales_window: [{ sku: "packcard-1__1_10", edition_external_id: "packcard-1", sold_at: "2026-09-28T18:00:00Z", amount_usd: 900, player_name: "Lionel Messi", set_name: "Base Prizms Gold", tier: "LEGENDARY", serial_number: 1, mint_cap: 10 }],
    top_sales_all_time: [{ sku: "packcard-2__10_10", edition_external_id: "packcard-2", sold_at: "2026-06-29T19:03:01Z", amount_usd: 100010, player_name: "Lionel Messi", set_name: "Base Prizms Gold", tier: "LEGENDARY", serial_number: 10, mint_cap: 10 }],
    most_traded: [{ edition_external_id: "packcard-3", player_name: "Kylian Mbappe", set_name: "Base", tier: "COMMON", sales: 40, volume_usd: 200, median_usd: 5 }],
    by_tier: [{ tier: "COMMON", sales: 500, volume_usd: 2500, median_usd: 4 }],
    by_parallel: [{ parallel: "Base", sales: 400, volume_usd: 2000, median_usd: 4 }],
    by_player: [{ player_name: "Kylian Mbappé", sales: 22, volume_usd: 5742, median_usd: 115, editions_traded: 8 }],
    serial_premium: [
      { kind: "serial_1", print_run: "100+", sales: 216, median_multiple: 2.18, p25_multiple: 1.2, p75_multiple: 5.73 },
      { kind: "serial_2_10", print_run: "100+", sales: 1356, median_multiple: 1, p25_multiple: 0.83, p75_multiple: 1.43 },
    ],
    ...over,
  }
}
afterEach(cleanup)

describe("PaniniAnalytics", () => {
  it("draws bars only for complete days; a partial day is an empty slot that says why", () => {
    const c = render(<PaniniAnalytics data={payload()} />).container
    const slots = [...c.querySelectorAll("[data-complete]")]
    expect(slots.map((s) => s.getAttribute("data-complete"))).toEqual(["true", "true", "false"])
    expect(slots[2].getAttribute("title")).toContain("not complete — 10%")
    // the partial slot carries no proportional bar
    expect((slots[2].firstElementChild as HTMLElement).style.height).toBe("2px")
  })

  it("a partial window reads 'at least' — never a total", () => {
    const c = render(<PaniniAnalytics data={payload()} />).container
    expect(c.textContent).toContain("≥ 562")
    expect(c.textContent).toContain("2 of 3 days complete")
    // the daily table marks the partial day as a floor
    expect(c.textContent).toContain("≥ 12")
  })

  it("control: a fully complete window drops the 'at least'", () => {
    const d = payload()
    d.daily[2].covered_pct = 99
    const c = render(<PaniniAnalytics data={d} />).container
    expect(c.textContent).not.toContain("≥ 562")
    expect(c.textContent).toContain("complete")
  })

  it("no complete day at all says the history is still building — no chart", () => {
    const d = payload({ daily: payload().daily.map((x) => ({ ...x, covered_pct: 0 })) })
    const c = render(<PaniniAnalytics data={d} />).container
    expect(c.querySelector('[data-testid="panini-analytics-building"]')).not.toBeNull()
    expect(c.querySelector("[data-complete]")).toBeNull()
  })

  it("a failed read says couldn't load — never zeros", () => {
    const c = render(<PaniniAnalytics data={null} />).container
    expect(c.querySelector('[role="alert"]')).not.toBeNull()
    expect(c.textContent).toContain("not the same as there being no sales")
    expect(c.textContent).not.toMatch(/\$0\b|≥ 0/)
  })

  it("top sales toggle to all-time and link the edition page; no buyer/seller handle is rendered", () => {
    const c = render(<PaniniAnalytics data={payload()} />).container
    expect(c.textContent).toContain("$900")
    fireEvent.click([...c.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "All time")!)
    expect(c.textContent).toContain("$100,010")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-2"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/buyer|seller/i)
  })

  // 2026-09-29 link crawl: a sale whose edition is not in our catalogue (no player name, since
  // the name comes from the panini_editions join) linked /panini-blockchain/edition/<key>, a 404.
  it("a sale or edition with no catalogue entry shows a plain dash, not a link to a 404", () => {
    const orphan = { sku: "packcard-9__1_10", edition_external_id: "packcard-9", sold_at: "2026-09-28T19:00:00Z", amount_usd: 500, player_name: null, set_name: null, tier: null, serial_number: 1, mint_cap: 10 }
    const d = payload({
      top_sales_window: [...payload().top_sales_window, orphan],
      most_traded: [...payload().most_traded, { edition_external_id: "packcard-8", player_name: null, set_name: null, tier: null, sales: 3, volume_usd: 30, median_usd: 10 }],
    })
    const c = render(<PaniniAnalytics data={d} />).container
    expect(c.textContent).toContain("$500")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-9"]')).toBeNull()
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-8"]')).toBeNull()
    // control: a catalogued edition still links
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-3"]')).not.toBeNull()
  })

  it("top players link the player page, and a partial window reads their counts AND volume as floors", () => {
    const c = render(<PaniniAnalytics data={payload()} />).container
    expect(c.querySelector('a[href="/panini-blockchain/player/kylian-mbappe"]')?.textContent).toBe("Kylian Mbappé")
    expect(c.textContent).toContain("≥ $5,742")
    expect(c.textContent).toContain("≥ 22")
    // grouped tables: a partial window's volume is a floor too, never a total
    expect(c.textContent).toContain("≥ $2,500")
    expect(c.textContent).not.toMatch(/(?<!≥ )\$5,742/)
  })

  it("control: a complete window shows the players' volume without a floor", () => {
    const d = payload()
    d.daily[2].covered_pct = 99
    const c = render(<PaniniAnalytics data={d} />).container
    expect(c.textContent).toContain("$5,742")
    expect(c.textContent).not.toContain("≥ $5,742")
  })

  it("a payload without the players list hides the section — it never says 'no sale'", () => {
    const c = render(<PaniniAnalytics data={payload({ by_player: null })} />).container
    expect(c.textContent).not.toContain("Top players")
    const p = parsePaniniSalesAnalytics({ ...payload(), by_player: undefined })
    expect(p?.by_player).toBeNull()
  })

  it("serial premiums render as multiples with their spread; an absent table is hidden, not '1.00x'", () => {
    const c = render(<PaniniAnalytics data={payload()} />).container
    const one = c.querySelector('[data-serial-kind="serial_1"]')!
    expect(one.textContent).toContain("2.18×")
    expect(one.textContent).toContain("1.20× – 5.73×")
    expect(c.querySelector('[data-serial-kind="serial_2_10"]')!.textContent).toContain("1.00×")
    const hidden = render(<PaniniAnalytics data={payload({ serial_premium: null })} />).container
    expect(hidden.textContent).not.toContain("Serial premiums")
    expect(hidden.querySelector("[data-serial-kind]")).toBeNull()
  })

  it("COMPLETE_PCT is the bar a day must clear", () => {
    expect(isCompleteDay({ day: "d", sales: 1, volume_usd: 1, median_usd: 1, covered_pct: COMPLETE_PCT })).toBe(true)
    expect(isCompleteDay({ day: "d", sales: 1, volume_usd: 1, median_usd: 1, covered_pct: COMPLETE_PCT - 0.1 })).toBe(false)
    expect(isCompleteDay({ day: "d", sales: 1, volume_usd: 1, median_usd: 1, covered_pct: null })).toBe(false)
  })
})

describe("parsePaniniSalesAnalytics", () => {
  const raw = {
    generated_at: "2026-09-29T16:00:00Z", days: 30,
    coverage: { active_editions: 4115, editions_read: 0, editions_whole_history: 0, editions_with_gaps: 0, first_read_at: null, last_read_at: null, sales_held: 52202, sales_from_full_records: 0 },
    daily: [{ day: "2026-09-28", sales: 3, volume_usd: 66, median_usd: 10, covered_pct: 0 }],
    window: { sales: 9952, volume_usd: 249802, median_usd: 3, editions_traded: 2187, cards_traded: 9952 },
    top_sales_window: [], top_sales_all_time: [{ sku: "a__1_1", edition_external_id: "a", sold_at: "2026-06-29T19:03:01+00:00", amount_usd: 100010 }],
    most_traded: [], by_tier: [{ tier: "COMMON", sales: 1, volume_usd: 1, median_usd: 1 }], by_parallel: [],
    by_player: [{ player_name: "Lamine Yamal", sales: 42, volume_usd: 42319, median_usd: 251.5, editions_traded: 15 }, { player_name: null, sales: 3, volume_usd: 9, median_usd: 3, editions_traded: 1 }],
  }
  it("parses the live shape (measured 2026-09-28)", () => {
    const p = parsePaniniSalesAnalytics(raw)
    expect(p?.coverage.sales_held).toBe(52202)
    expect(p?.daily[0].covered_pct).toBe(0)
    expect(p?.top_sales_all_time[0].serial_number).toBeNull()
    // a premium row missing its multiple (or of an unknown kind) is dropped, never shown as 0x
    const sp = parsePaniniSalesAnalytics({ ...raw, serial_premium: [
      { kind: "serial_1", print_run: "1-10", sales: 142, median_multiple: 1.62, p25_multiple: 1, p75_multiple: 2.14 },
      { kind: "serial_1", print_run: "11-25", sales: 5, median_multiple: null },
      { kind: "jersey", print_run: "1-10", sales: 5, median_multiple: 3 },
    ] })
    expect(sp?.serial_premium).toEqual([{ kind: "serial_1", print_run: "1-10", sales: 142, median_multiple: 1.62, p25_multiple: 1, p75_multiple: 2.14 }])
    expect(p?.serial_premium).toBeNull()
    // a nameless player row is dropped, never rendered as a blank link
    expect(p?.by_player).toEqual([{ player_name: "Lamine Yamal", sales: 42, volume_usd: 42319, median_usd: 251.5, editions_traded: 15 }])
  })
  it("a payload missing its coverage, window or daily series is rejected, not zeros", () => {
    const without = (k: string) => { const o: Record<string, unknown> = { ...raw }; delete o[k]; return o }
    const noCov = without("coverage"), noWin = without("window"), noDaily = without("daily")
    for (const bad of [null, {}, noCov, noWin, noDaily, { ...raw, coverage: { ...raw.coverage, sales_held: null } }]) {
      expect(parsePaniniSalesAnalytics(bad)).toBeNull()
    }
  })
})
