"use client"

// components/insights/OwnWalletLink.tsx
//
// One-click "use my wallet" link under a lookup box, for a signed-in reader
// with a linked Flow wallet (2026-09-28) — so they are never made to paste
// their own wallet. Renders NOTHING when signed out, unlinked, still loading,
// or when the identity read failed (useOwnFlowWallet returns null for all of
// them): the box above stays the only entry point, exactly as before.

import Link from "next/link"
import { useOwnFlowWallet } from "@/lib/hooks/useOwnFlowWallet"

// ⚠ `to` is a STRING, not an href-builder function: this is a client
// component rendered from SERVER components (InsightsWalletSearch), and a
// function prop cannot cross that boundary — it fails only in a real render.
export type OwnWalletDestination = "share" | "tc-report"

export function ownWalletHref(to: OwnWalletDestination, wallet: string): string {
  const enc = encodeURIComponent(wallet)
  return to === "tc-report" ? `/insights/tc-report?wallet=${enc}` : `/share/${enc}`
}

export default function OwnWalletLink({
  to,
  label,
}: {
  to: OwnWalletDestination
  /** Link text; the short wallet is appended in parentheses. */
  label: string
}) {
  const own = useOwnFlowWallet()
  if (!own.wallet) return null
  return (
    <Link
      href={ownWalletHref(to, own.wallet)}
      style={{
        display: "inline-block",
        marginTop: 12,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--rpc-red)",
        textDecoration: "none",
      }}
    >
      {label} ({own.wallet.slice(0, 6)}…{own.wallet.slice(-4)}) →
    </Link>
  )
}
