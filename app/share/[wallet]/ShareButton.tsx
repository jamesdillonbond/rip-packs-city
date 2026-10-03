"use client"

import { useState } from "react"
import { shareWalletCard, type ShareOutcome } from "@/lib/share-link"

// Shares THIS card with share attribution (lib/share-link.ts). It used to copy
// window.location.href — untagged, and carrying whatever utm the copier had
// arrived with.
export default function ShareButton({ wallet }: { wallet: string }) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null)

  const label =
    outcome === "copied" ? "Link Copied!"
    : outcome === "shared" ? "Shared!"
    : outcome === "failed" ? "Copy failed"
    : "Share"

  return (
    <button
      onClick={async () => {
        const r = await shareWalletCard(wallet)
        if (r === "cancelled") return
        setOutcome(r)
        setTimeout(() => setOutcome(null), 2000)
      }}
      style={{
        padding: "12px 24px",
        background: "var(--rpc-red)",
        border: "none",
        borderRadius: 8,
        // brand-exception: white label on the red button — theme-independent
        color: "#fff",
        fontWeight: 700,
        fontSize: 14,
        cursor: "pointer",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </button>
  )
}
