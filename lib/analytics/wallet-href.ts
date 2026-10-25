// Where a wallet name or address links to, by CONTEXT (2026-10-25).
//
// RPC has two per-wallet pages and they answer different questions:
//   • /share/<wallet>              — the holdings card: what the wallet owns and its
//                                     value across collections. The right page for a
//                                     buyer, a seller, a whale, a pack opener.
//   • /analytics/wallets/<wallet>  — the Flowty LOAN profile: borrower / lender stats,
//                                     loan activity, position transfers. For a wallet
//                                     with no loans it is a page of zeros
//                                     (flowty_analytics_wallet_detail returns zeroed
//                                     roles for any address — measured 2026-10-25).
//
// Until 2026-10-25 market tables (the Analytics tab's whales, Top Buyers, the pack
// page's buyers and sellers) linked the loan profile — which was also sign-in only
// then, so a signed-out click landed on /login. Both pages are public now; the link
// follows what the reader is looking at.

/** A wallet seen in a MARKET context (sales, buyers, sellers, holders). */
export function marketWalletHref(address: string): string {
  return `/share/${encodeURIComponent(address)}`
}

/** A wallet seen in a LOAN context (borrower, lender, defaulted by). */
export function loanWalletHref(address: string): string {
  return `/analytics/wallets/${encodeURIComponent(address)}`
}
