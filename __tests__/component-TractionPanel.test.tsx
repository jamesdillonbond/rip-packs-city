// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The admin Traction panel (platform review 2026-10-11, M3) —
// app/admin/analytics/AdminAnalyticsClient.tsx TractionPanel.
//
// It renders get_rpc_traction_activity()'s payload as tiles. The property that
// matters is the one every honesty defect on this platform violates: a FAILED
// read must show "—" with its error, never a 0; and a NULL rate (empty cohort)
// must also be "—". A measured 0 is a real number and stays a 0.

import { TractionPanel } from "@/app/admin/analytics/AdminAnalyticsClient"

afterEach(() => cleanup())

const tiles = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".rpc-stat-tile")).map((t) => ({
    label: t.querySelector(".rpc-stat-eyebrow")?.textContent ?? "",
    value: t.querySelector(".rpc-stat-value")?.textContent ?? "",
  }))

describe("TractionPanel — a failed read", () => {
  it("renders '—' in every tile and prints the error; no tile reads 0", () => {
    const { container } = render(<TractionPanel traction={null} error="function get_rpc_traction_activity() does not exist" />)
    expect(container.querySelector('[data-state="read-failed"]')).not.toBeNull()
    const ts = tiles(container)
    expect(ts.length).toBe(7)
    for (const t of ts) expect(t.value).toBe("—")
    expect(container.textContent).toMatch(/could not be read/)
    expect(container.textContent).toMatch(/does not exist/)
    expect(container.textContent).not.toMatch(/\b0\b/)
  })
})

describe("TractionPanel — a good read", () => {
  it("renders the measured values, a null rate as '—', and a measured 0 as 0", () => {
    const { container } = render(
      <TractionPanel
        traction={{
          accounts_total: 35,
          signups_7d: 1,
          signups_30d: 12,
          wau: 6,
          mau: 14,
          d7_cohort: 7,
          d7_returned: 2,
          d7_return_pct: 28.6,
          d30_cohort: 0,
          d30_returned: 0,
          d30_return_pct: null,
          basis: "accounts = auth.users minus internal_accounts",
        }}
        error={null}
      />
    )
    expect(container.querySelector('[data-state="ok"]')).not.toBeNull()
    const by = Object.fromEntries(tiles(container).map((t) => [t.label, t.value]))
    expect(by["WAU (7d)"]).toBe("6")
    expect(by["MAU (30d)"]).toBe("14")
    expect(by["Accounts"]).toBe("35")
    expect(by["Signups 7d"]).toBe("1")
    expect(by["Signups 30d"]).toBe("12")
    expect(by["D7 return"]).toBe("28.6%")
    // empty cohort → the function returns null → "—", not "0.0%"
    expect(by["D30 return"]).toBe("—")
    expect(container.textContent).toMatch(/D7: 2 of 7 returned/)
    expect(container.textContent).toMatch(/D30: 0 of 0 returned/)
    expect(container.textContent).toMatch(/auth\.users minus internal_accounts/)
    expect(container.textContent).not.toMatch(/could not be read/)
  })
})
