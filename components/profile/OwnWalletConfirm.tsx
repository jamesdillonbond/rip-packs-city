"use client"

// components/profile/OwnWalletConfirm.tsx
//
// "Is this your wallet?" — the step between a click on a save-as-mine button
// and the save itself (2026-11-16). The binder and the share card offer the
// save right where a collector is LOOKING at a wallet, usually after typing a
// friend's username. Saving makes the wallet theirs on RPC: binder, FMV totals,
// pack history, and possibly their public /profile/<handle>. Nothing checks
// ownership (2 of 57 accounts were verified on 11-16), so this step is the
// check. It names the wallet and points a friend-watcher at Follow.

import { useEffect, type CSSProperties } from "react"
import { track } from "@/lib/telemetry/track"

// Measured (2026-11-16): own-wallet-confirm {step: shown | yes | cancel, surface}.
// A high cancel share means people were about to save a wallet that wasn't theirs.

export default function OwnWalletConfirm({
  label,
  onConfirm,
  onCancel,
  followHint = true,
  align = "start",
  surface,
}: {
  /** "@handle" when known, else a shortened address. */
  label: string
  onConfirm: () => void
  onCancel: () => void
  /** Mention Follow as the friend path (only where a Follow button is beside it). */
  followHint?: boolean
  align?: "start" | "center"
  /** Where the confirm sits, for the usage event ("binder" | "share"). */
  surface?: string
}) {
  useEffect(() => {
    track("own-wallet-confirm", { step: "shown", surface: surface ?? null })
  }, [surface])
  const btn: CSSProperties = {
    padding: "8px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 700,
    cursor: "pointer",
  }
  return (
    <div
      role="group"
      aria-label={`Confirm ${label} is your wallet`}
      data-testid="own-wallet-confirm"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: align === "center" ? "center" : "flex-start",
        textAlign: align === "center" ? "center" : "left",
        padding: "12px 14px",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-md)",
        background: "var(--rpc-surface)",
        maxWidth: 420,
      }}
    >
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--rpc-text-primary)" }}>
        Is {label} your wallet?
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
        Saving makes it your collection on RPC: your binder, your value totals and your public profile.
        {followHint ? " Looking at a friend's? Use Follow instead to see their buys and sells on your dashboard." : " Only save a wallet you own."}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => {
            track("own-wallet-confirm", { step: "yes", surface: surface ?? null })
            onConfirm()
          }}
          // brand-exception: white label on the red button — theme-independent
          style={{ ...btn, background: "var(--rpc-red-fill)", border: "none", color: "#fff" }}
        >
          Yes, it&apos;s mine — save it
        </button>
        <button
          type="button"
          onClick={() => {
            track("own-wallet-confirm", { step: "cancel", surface: surface ?? null })
            onCancel()
          }}
          style={{ ...btn, background: "transparent", border: "1px solid var(--rpc-border)", color: "var(--rpc-text-secondary)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
