// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini edition "Ask history" (2026-10-25). Absence of the false claims: a failed read never reads
 * as "nothing recorded"; an empty history never says the edition was never listed; a day with no
 * confirmed ask never renders as "$0"; the recording start is always stated.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import { PaniniAskHistorySection, fmtDay } from "@/components/entity/PaniniEditionExtras"

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
