// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, within } from "@testing-library/react"
import WalletProfile from "@/components/analytics/WalletProfile"

// 2026-10-25, live /analytics/wallets/0xbd94cade097e50ac: a lender with 8 loans,
// all originated before the Dec 29 2025 scan window, plus 8 position transfers
// worth $1.1k, rendered "TOTAL VOLUME $0", "FUNDED VOLUME $0 … AVG APR 0.0%",
// "Repaid 0 · Settled 0" beside "Repaid: 3 · Settled: 5", and concluded
// "No funded loans in this wallet's history." Pre-window loans carry no
// principal (only their terminal event is seen), so their volume is UNKNOWN.

vi.mock("@/components/analytics/WalletIdenticon", () => ({ default: () => <div /> }))
vi.mock("@/lib/analytics/username-resolver", async (orig) => {
  const real = (await orig()) as any
  return { ...real, useResolveUsernames: () => ({}) }
})
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
afterEach(() => cleanup())

const preWindowLender: any = {
  addr: "0xbd94cade097e50ac",
  as_borrower: { loan_count: 0, total_principal_usd: 0, total_repayment_usd: 0, active_count: 0, repaid_count: 0, settled_count: 0, default_rate_pct: null, avg_loan_size_usd: 0, first_seen_at: null, last_seen_at: null },
  as_lender: { loan_count: 0, total_principal_usd: 0, total_repayment_usd: 0, active_count: 0, repaid_count: 0, settled_count: 0, default_rate_pct: null, avg_loan_size_usd: 0, avg_apr: 0, first_seen_at: null, last_seen_at: null },
  limbo_as_borrower: { loan_count: 0, repaid_count: 0, settled_count: 0, first_terminal: null, last_terminal: null },
  limbo_as_lender: { loan_count: 8, repaid_count: 3, settled_count: 5, first_terminal: "2025-12-29T00:00:00Z", last_terminal: "2026-02-02T00:00:00Z" },
  recent_as_borrower: [],
  recent_as_lender: [],
}
const transfers: any = {
  has_activity: true,
  outgoing: { count: 0, principal_usd: 0, unique_recipients: 0, loans: [] },
  incoming: { count: 8, principal_usd: 1100, unique_origins: 1, loans: [] },
}

describe("a pre-window-only wallet does not publish zeros it never measured", () => {
  it("Total volume is unknown with a reason, not $0", () => {
    const { container, getByText } = render(<WalletProfile data={preWindowLender} positionTransfers={transfers} />)
    const kpi = getByText(/^Total volume$/i).parentElement as HTMLElement
    expect(within(kpi).queryByText("$0")).toBeNull()
    expect(kpi.textContent).toContain("—")
    expect(kpi.textContent).toMatch(/pre-window loans only/i)
    expect(container.textContent).toContain("8") // the loans are still counted
  })

  it("the role panel shows the pre-window closures, not an in-window grid of zeros", () => {
    const { container } = render(<WalletProfile data={preWindowLender} positionTransfers={transfers} />)
    const t = container.textContent ?? ""
    expect(t).not.toMatch(/Funded volume/i)
    expect(t).not.toMatch(/Avg APR/i)
    expect(t).toMatch(/Repaid:\s*3/)
    expect(t).toMatch(/Settled:\s*5/)
  })

  it("the empty activity list does not conclude the wallet has no loan history", () => {
    const { container } = render(<WalletProfile data={preWindowLender} positionTransfers={transfers} />)
    const t = container.textContent ?? ""
    expect(t).not.toMatch(/No funded loans in this wallet.s history/i)
    expect(t).not.toMatch(/Last 0 loans/i)
    expect(t).toMatch(/since our scan window opened/i)
  })

  it("a wallet with genuinely no loans says so plainly (no-change control)", () => {
    const empty = { ...preWindowLender, limbo_as_lender: { loan_count: 0, repaid_count: 0, settled_count: 0, first_terminal: null, last_terminal: null } }
    const { container } = render(<WalletProfile data={empty} />)
    expect(container.textContent).toMatch(/No Flowty loans found for this wallet/i)
  })

  it("an in-window wallet with pre-window extras still shows its real volume, and says what it leaves out", () => {
    const mixed = {
      ...preWindowLender,
      as_lender: { ...preWindowLender.as_lender, loan_count: 2, total_principal_usd: 250, avg_apr: 0.1 },
      recent_as_lender: [{ funding_resource_id: "f1", counterparty_addr: "0xcccccccccccccccc", principal_usd: null, funded_at: "2026-07-01T00:00:00Z", status: "active", collection: "topshot" }],
    }
    const { getByText, container } = render(<WalletProfile data={mixed} />)
    const kpi = getByText(/^Total volume$/i).parentElement as HTMLElement
    expect(kpi.textContent).toContain("$250")
    expect(kpi.textContent).toMatch(/Excludes 8 pre-window loans/)
    // A loan row whose principal was never captured reads unknown, not $0.
    const row = container.querySelector("tbody tr") as HTMLElement
    expect(row.textContent).not.toContain("$0")
    expect(row.textContent).toContain("—")
  })
})
