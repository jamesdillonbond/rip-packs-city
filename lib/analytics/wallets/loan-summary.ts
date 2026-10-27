// lib/analytics/wallets/loan-summary.ts
//
// The share card, description and JSON-LD say what WalletProfile says (2026-10-27). Pre-window loans (originated
// before the Dec 29 2025 scan window) are counted by how they closed but carry NO principal, so with no in-window
// loans the volume is UNKNOWN, never "$0" — and a wallet with no loans at all has no role, not "Borrower".
type LoanLeg = { loan_count?: number | null; total_principal_usd?: number | null } | null | undefined
export function summarizeWalletLoans(data: { as_borrower?: LoanLeg; as_lender?: LoanLeg; limbo_as_borrower?: LoanLeg; limbo_as_lender?: LoanLeg }): { role: string | null; sentence: string } {
  const b = data.as_borrower?.loan_count ?? 0, l = data.as_lender?.loan_count ?? 0
  const lb = data.limbo_as_borrower?.loan_count ?? 0, ll = data.limbo_as_lender?.loan_count ?? 0
  const lender = l + ll > 0, borrower = b + lb > 0
  const role = lender && borrower ? "Lender + borrower" : lender ? "Lender" : borrower ? "Borrower" : null
  const inWindow = b + l, preWindow = lb + ll
  const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`
  let sentence: string
  if (inWindow > 0) {
    const vol = (data.as_borrower?.total_principal_usd ?? 0) + (data.as_lender?.total_principal_usd ?? 0)
    sentence = `$${Math.round(vol).toLocaleString()} funded across ${plural(inWindow, "loan")}` +
      (preWindow > 0 ? `, plus ${plural(preWindow, "pre-window loan")} (principal not captured)` : "")
  } else if (preWindow > 0) {
    sentence = `${plural(preWindow, "pre-window loan")} (principal not captured)`
  } else {
    sentence = "No Flowty loans found"
  }
  return { role, sentence }
}
