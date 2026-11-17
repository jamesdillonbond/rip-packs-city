// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini edition "Ask history" (2026-10-25). Absence of the false claims: a failed read never reads
 * as "nothing recorded"; an empty history never says the edition was never listed; a day with no
 * confirmed ask never renders as "$0"; the recording start is always stated.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import { PaniniAskHistorySection, fmtDay, PANINI_ASK_CHART_MIN_POINTS } from "@/components/entity/PaniniEditionExtras"

afterEach(cleanup)

describe("PaniniAskHistorySection", () => {
  it("a failed read says couldn't load — never 'hasn't recorded'", () => {
    const c = render(<PaniniAskHistorySection rows={null} />).container
    expect(c.querySelector('[data-testid="panini-ask-history-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/hasn't recorded/)
  })
  it("an empty ok read says nothing is recorded since the start — never 'never listed'", () => {
    const c = render(<PaniniAskHistorySection rows={[]} />).container
    expect(c.querySelector('[data-testid="panini-ask-history-empty"]')?.textContent).toContain("since Oct 21, 2026")
    expect(c.textContent).not.toMatch(/never (been )?listed/i)
  })
  it("rows show each change, the move vs the previous ask, and a null ask as words, not $0", () => {
    const c = render(
      <PaniniAskHistorySection rows={[
        { day: "2026-10-25", lowAskUsd: null },
        { day: "2026-10-24", lowAskUsd: 15 },
        { day: "2026-10-21", lowAskUsd: 12 },
      ]} />,
    ).container
    const t = c.querySelector('[data-testid="panini-ask-history"]')!.textContent!
    expect(t).toContain("Oct 24, 2026")
    expect(t).toContain("+25.0%")
    expect(t).toContain("no confirmed ask")
    expect(t).not.toContain("$0")
    expect(c.textContent).toContain("Recorded since Oct 21, 2026")
  })
})

describe("fmtDay", () => {
  it("reads a calendar day without a timezone shift", () => {
    expect(fmtDay("2026-10-01")).toBe("Oct 1, 2026")
    expect(fmtDay("nope")).toBe("nope")
  })
})

describe("PaniniAskHistorySection — ask chart (2026-11-04)", () => {
  it("under the minimum number of recorded asks there is NO chart — the table alone", () => {
    expect(PANINI_ASK_CHART_MIN_POINTS).toBe(3)
    const c = render(<PaniniAskHistorySection rows={[
      { day: "2026-10-25", lowAskUsd: null },
      { day: "2026-10-24", lowAskUsd: 15 },
      { day: "2026-10-21", lowAskUsd: 12 },
    ]} />).container
    expect(c.querySelector('[data-testid="panini-ask-chart"]')).toBeNull()
    expect(c.querySelector('[data-testid="panini-ask-history"]')).not.toBeNull()
  })
  it("with 3+ asks it draws the chart above the table, and a day with no ask BREAKS the line (never $0, never held)", () => {
    const c = render(<PaniniAskHistorySection rows={[
      { day: "2026-11-03", lowAskUsd: 20 },
      { day: "2026-11-01", lowAskUsd: null },
      { day: "2026-10-28", lowAskUsd: 18 },
      { day: "2026-10-21", lowAskUsd: 12 },
    ]} />).container
    const fig = c.querySelector('[data-testid="panini-ask-chart"]')!
    expect(fig).not.toBeNull()
    expect(c.querySelector('[data-testid="panini-ask-history"]')).not.toBeNull()
    // three priced dots, one open gap marker
    expect(fig.querySelectorAll("circle[fill='var(--rpc-red)']")).toHaveLength(3)
    expect(fig.querySelectorAll("circle[fill='none']")).toHaveLength(1)
    // 10-21→10-28 and 10-28→11-01 are drawn; NOTHING starts at the gap day (11-01 → 11-03 is broken)
    const paths = Array.from(fig.querySelectorAll("path")).map((p) => p.getAttribute("d") ?? "")
    expect(paths).toHaveLength(2)
    // the segment INTO the gap is horizontal only — it never drops to a $0 baseline
    expect(paths[1]).not.toMatch(/ V/)
    expect(fig.querySelector("svg")!.getAttribute("aria-label")).toContain("from $12")
    expect(fig.textContent).not.toContain("$0")
  })
})
