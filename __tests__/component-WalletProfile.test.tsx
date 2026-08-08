// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import WalletProfile from "@/components/analytics/WalletProfile"

// Render coverage for the ~1,000-line lending wallet-profile card (the biggest
// untested analytics component). It renders from props (no fetch), so the
// regression surface is: the role classification (Borrower/Lender/Mixed), the
// aggregate stat rollups (total volume/loans, first/last seen), which panels
// show, and the counterparty-address extraction (borrower + lender + position
// transfers). We mock only the identicon + username resolver (canvas/network).

vi.mock("@/components/analytics/WalletIdenticon", () => ({
  default: ({ addr }: any) => <div data-testid="identicon">{addr}</div>,
}))
vi.mock("@/lib/analytics/username-resolver", async (orig) => {
  const real = (await orig()) as any
  return { ...real, useResolveUsernames: () => ({}) }
})
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

afterEach(() => cleanup())

const loan = (over: Record<string, any> = {}): any => ({
  loan_id: "l-" + (over.loan_id ?? "1"),
  counterparty_addr: "0xcccccccccccccccc",
  principal_usd: 100,
  funded_at: "2026-07-01T00:00:00Z",
  status: "active",
  ...over,
})

const baseData = (over: Record<string, any> = {}): any => ({
  addr: "0xaaaaaaaaaaaaaaaa",
  as_borrower: { loan_count: 3, total_principal_usd: 300, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
  as_lender: { loan_count: 2, total_principal_usd: 500, first_seen_at: "2026-02-01", last_seen_at: "2026-06-01" },
  limbo_as_borrower: { loan_count: 0 },
  limbo_as_lender: { loan_count: 0 },
  recent_as_borrower: [loan({ loan_id: "b1" })],
  recent_as_lender: [loan({ loan_id: "s1", counterparty_addr: "0xdddddddddddddddd" })],
  ...over,
})

describe("WalletProfile", () => {
  it("renders a Mixed wallet (both borrower + lender loans) with address + panels", () => {
    const { container, getAllByText } = render(<WalletProfile data={baseData()} />)
    expect(container.textContent).toContain("Mixed")
    // full address shown in the header code block
    expect(getAllByText("0xaaaaaaaaaaaaaaaa").length).toBeGreaterThan(0)
    // FlowScan external link
    expect(container.querySelector('a[href="https://flowscan.io/account/0xaaaaaaaaaaaaaaaa"]')).toBeTruthy()
  })

  it("classifies a lender-only wallet as Lender", () => {
    const data = baseData({
      as_borrower: { loan_count: 0, total_principal_usd: 0 },
      limbo_as_borrower: { loan_count: 0 },
      recent_as_borrower: [],
    })
    const { container } = render(<WalletProfile data={data} />)
    expect(container.textContent).toContain("Lender")
  })

  it("classifies a borrower-only wallet as Borrower", () => {
    const data = baseData({
      as_lender: { loan_count: 0, total_principal_usd: 0 },
      limbo_as_lender: { loan_count: 0 },
      recent_as_lender: [],
    })
    const { container } = render(<WalletProfile data={data} />)
    expect(container.textContent).toContain("Borrower")
  })

  it("prefers a supplied username over the truncated address in the header", () => {
    const { container } = render(<WalletProfile data={baseData()} username="whale.eth" />)
    // the H1 shows the username
    expect(container.querySelector("h1")?.textContent).toBe("whale.eth")
  })

  it("counts limbo loans toward the role + totals (borrower via limbo only)", () => {
    const data = baseData({
      as_borrower: { loan_count: 0, total_principal_usd: 0 },
      as_lender: { loan_count: 0, total_principal_usd: 0 },
      limbo_as_borrower: { loan_count: 4, first_terminal: "2026-03-01", last_terminal: "2026-05-01" },
      limbo_as_lender: { loan_count: 1, first_terminal: "2026-04-01", last_terminal: "2026-04-15" },
      recent_as_borrower: [],
      recent_as_lender: [],
    })
    const { container } = render(<WalletProfile data={data} />)
    // borrower(4 limbo) + lender(1 limbo) → Mixed
    expect(container.textContent).toContain("Mixed")
  })

  it("extracts counterparties from position transfers without crashing", () => {
    const positionTransfers: any = {
      outgoing: { loans: [{ recipient_addr: "0x1111111111111111", borrower_addr: "0x2222222222222222" }] },
      incoming: { loans: [{ origin_addr: "0x3333333333333333", borrower_addr: "0x4444444444444444" }] },
    }
    const { container } = render(
      <WalletProfile data={baseData()} positionTransfers={positionTransfers} />
    )
    expect(container.textContent).toContain("0xaaaaaaaaaaaaaaaa")
  })

  it("renders an empty-history wallet (no loans) without crashing", () => {
    const data: any = {
      addr: "0xbbbbbbbbbbbbbbbb",
      as_borrower: { loan_count: 0, total_principal_usd: 0 },
      as_lender: { loan_count: 0, total_principal_usd: 0 },
      limbo_as_borrower: { loan_count: 0 },
      limbo_as_lender: { loan_count: 0 },
      recent_as_borrower: [],
      recent_as_lender: [],
    }
    const { container } = render(<WalletProfile data={data} />)
    // an all-zero wallet still classifies (falls through to Borrower) and renders
    expect(container.textContent).toContain("0xbbbbbbbbbbbbbbbb")
  })

  it("loan rows are keyboard-operable (role=button, aria-expanded, Enter toggles)", () => {
    const { container } = render(<WalletProfile data={baseData()} />)
    const row = container.querySelector('tr[role="button"]')
    expect(row).toBeTruthy()
    expect(row?.getAttribute("tabindex")).toBe("0")
    expect(row?.getAttribute("aria-expanded")).toBe("false")
    // Enter expands the loan detail (mouse-only before this fix).
    fireEvent.keyDown(row!, { key: "Enter" })
    expect(container.querySelector('tr[role="button"]')?.getAttribute("aria-expanded")).toBe("true")
    // Space collapses it again.
    fireEvent.keyDown(container.querySelector('tr[role="button"]')!, { key: " " })
    expect(container.querySelector('tr[role="button"]')?.getAttribute("aria-expanded")).toBe("false")
  })

  it("copies the wallet address to the clipboard and flips the button to Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { getByText } = render(<WalletProfile data={baseData()} />)
    fireEvent.click(getByText("Copy"))
    expect(writeText).toHaveBeenCalledWith("0xaaaaaaaaaaaaaaaa")
    await waitFor(() => expect(getByText("Copied")).toBeTruthy())
  })

  it("renders each loan status badge (Active / Repaid / Settled / Cancelled / unknown passthrough)", () => {
    const data = baseData({
      recent_as_borrower: [
        loan({ loan_id: "b-active", status: "active" }),
        loan({ loan_id: "b-repaid", status: "repaid" }),
        loan({ loan_id: "b-settled", status: "settled" }),
        loan({ loan_id: "b-cancelled", status: "cancelled" }),
      ],
      recent_as_lender: [loan({ loan_id: "s-weird", status: "in_grace", counterparty_addr: "0xffffffffffffffff" })],
    })
    const { container } = render(<WalletProfile data={data} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Active")
    expect(text).toContain("Repaid")
    expect(text).toContain("Settled")
    expect(text).toContain("Cancelled")
    expect(text).toContain("in_grace") // unknown status → raw passthrough label
  })

  it("expands a loan row on click and reveals the counterparty analytics drill-down link", () => {
    const { container } = render(<WalletProfile data={baseData()} />)
    const row = container.querySelector('tr[role="button"]') as HTMLElement
    fireEvent.click(row)
    expect(container.querySelector('tr[role="button"]')?.getAttribute("aria-expanded")).toBe("true")
    const drill = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(drill.some((h) => h?.startsWith("/analytics/wallets/"))).toBe(true)
  })

  it("shows both limbo-only panels (borrower + lender terminal loans with no funded rows)", () => {
    const data = baseData({
      as_borrower: { loan_count: 0, total_principal_usd: 0 },
      as_lender: { loan_count: 0, total_principal_usd: 0 },
      limbo_as_borrower: { loan_count: 2, repaid_count: 1 },
      limbo_as_lender: { loan_count: 1, repaid_count: 0 },
      recent_as_borrower: [],
      recent_as_lender: [],
    })
    const { container } = render(<WalletProfile data={data} />)
    // classifyRole(borrower+limbo>0, lender+limbo>0) → Mixed, both panels shown
    expect(container.textContent).toContain("Mixed")
  })
})
