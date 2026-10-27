import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { summarizeWalletLoans } from "@/lib/analytics/wallets/loan-summary"

// 2026-10-27: the wallet loan page's description / share card / JSON-LD said "$0 funded across 0 loans" for a
// wallet whose loans all predate the scan window (their principal was never captured), and called a wallet with
// no loans at all a "Borrower". WalletProfile's body was fixed 10-25 (f6f6c55e9); this is the same rule for the head.
describe("summarizeWalletLoans", () => {
  it("pre-window loans only: no dollar figure, never '$0'", () => {
    const r = summarizeWalletLoans({ as_borrower: { loan_count: 0, total_principal_usd: 0 }, as_lender: { loan_count: 0 }, limbo_as_lender: { loan_count: 8 } })
    expect(r.sentence).not.toMatch(/\$0|0 loans/)
    expect(r.sentence).toBe("8 pre-window loans (principal not captured)")
    expect(r.role).toBe("Lender")
  })
  it("no loans at all: no role, not 'Borrower'", () => {
    const r = summarizeWalletLoans({ as_borrower: { loan_count: 0 }, as_lender: { loan_count: 0 } })
    expect(r.role).toBeNull()
    expect(r.sentence).toBe("No Flowty loans found")
  })
  it("in-window loans: the measured volume, and says what it leaves out", () => {
    const r = summarizeWalletLoans({ as_borrower: { loan_count: 2, total_principal_usd: 150 }, as_lender: { loan_count: 1, total_principal_usd: 50 }, limbo_as_borrower: { loan_count: 1 } })
    expect(r.sentence).toBe("$200 funded across 3 loans, plus 1 pre-window loan (principal not captured)")
    expect(r.role).toBe("Lender + borrower")
  })
})

describe("the wallet page's head uses it", () => {
  const src = readFileSync(`${process.cwd()}/app/(analytics)/analytics/wallets/[address]/page.tsx`, "utf8")
  it("no description or JSON-LD builds a dollar figure from the in-window legs alone", () => {
    expect(src).not.toMatch(/Math\.round\(totalVolume\)/)
    expect(src).not.toMatch(/: "Borrower"\s*$/m)
    expect((src.match(/summarizeWalletLoans\(data\)/g) ?? []).length).toBe(2)
  })
})
