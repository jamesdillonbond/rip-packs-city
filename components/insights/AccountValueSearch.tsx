"use client"

// components/insights/AccountValueSearch.tsx
//
// Wallet-paste box for the /insights/account-value landing page. A thin binding
// over the canonical components/WalletSearch — it was the third fork of the same
// input and, like the /insights hub fork, emitted no wallet_paste at all.
// Destination is the public collection-snapshot card (/share/<wallet>), which
// leads with the account's TOTAL FMV — the literal "what's my account worth"
// answer. (2026-06-30; unforked + instrumented 2026-07-25.)
//
// Signed in with a linked Flow wallet (2026-09-28): a one-click link to the
// reader's own card sits under the box, so they need not paste their own wallet.
// The box stays for looking up anyone else.

import Link from "next/link"
import WalletSearch from "@/components/WalletSearch"
import { useOwnFlowWallet } from "@/lib/hooks/useOwnFlowWallet"

export default function AccountValueSearch() {
  const own = useOwnFlowWallet()
  return (
    <>
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
      {own.wallet && (
        <Link
          href={`/share/${encodeURIComponent(own.wallet)}`}
          style={{
            display: "inline-block",
            marginTop: 12,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--rpc-red)",
            textDecoration: "none",
          }}
        >
          See your account&apos;s value ({own.wallet.slice(0, 6)}…{own.wallet.slice(-4)}) →
        </Link>
      )}
    </>
  )
}
