// components/insights/AccountValueSearch.tsx
//
// Wallet-paste box for the /insights/account-value landing page. A thin binding
// over the canonical components/WalletSearch — it was the third fork of the same
// input and, like the /insights hub fork, emitted no wallet_paste at all.
// Destination is the public collection-snapshot card (/share/<wallet>), which
// leads with the account's TOTAL FMV — the literal "what's my account worth"
// answer. (2026-06-30; unforked + instrumented 2026-07-25.)

import WalletSearch from "@/components/WalletSearch"

export default function AccountValueSearch() {
  return (
    <WalletSearch
      surface="insights_account_value"
      variant="inline"
      destination="share"
      placeholder="Top Shot username or Flow wallet (0x…)"
      ariaLabel="See your account's total value — Top Shot username or Flow wallet"
      submitLabel="See value →"
      pendingLabel="…"
      style={{ marginTop: 22 }}
    />
  )
}
