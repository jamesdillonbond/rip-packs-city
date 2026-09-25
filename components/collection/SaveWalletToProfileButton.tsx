"use client"

// components/collection/SaveWalletToProfileButton.tsx
//
// One-click "save this wallet to my profile" for a wallet loaded on a
// collection tab (2026-09-25). Built for Candy MLB: the dashboard's one-field
// add has accepted a base58 address since 2026-09-06, yet `saved_wallets` held
// ZERO Candy rows on 2026-09-25 — a Candy collector searches their wallet HERE,
// and this page offered no way to keep it.
//
// Renders nothing until it knows the viewer is signed in: a 401 from
// /api/profile/saved-wallets means "not signed in", and a failed read is not
// an invitation to save (it could be a wallet that is already saved).
//
// ⚠ The address is passed through normalizeAddress, never `.toLowerCase()` —
// base58 is case-sensitive, and a folded Candy key matches no row.

import { useEffect, useState } from "react"
import { normalizeAddress, isValidAddressForChain } from "@/lib/address"
import { fetchJson } from "@/lib/analytics/fetch-json"

type State = "unknown" | "hidden" | "can-save" | "saving" | "saved" | "error"

export default function SaveWalletToProfileButton({
  wallet,
  collectionUuid,
  dbChain,
}: {
  wallet: string
  collectionUuid: string
  dbChain: string | null | undefined
}) {
  const [state, setState] = useState<State>("unknown")
  const [message, setMessage] = useState<string | null>(null)
  const addr = wallet ? normalizeAddress(wallet) : ""
  const valid = !!addr && isValidAddressForChain(addr, dbChain)

  // The mount site keys this component on the wallet, so a new wallet is a
  // fresh mount starting at "unknown" — no synchronous reset needed here.
  useEffect(() => {
    if (!valid) return
    let cancelled = false
    void fetchJson<{ wallets?: { wallet_addr?: unknown }[] }>(
      "/api/profile/saved-wallets?collectionId=" + encodeURIComponent(collectionUuid),
      { cache: "no-store" },
    ).then((r) => {
      if (cancelled) return
      // Not ok = signed out (401) OR we could not tell. Hide both: a failed
      // read is not an invitation to save a wallet that may already be saved.
      if (!r.ok || !Array.isArray(r.json?.wallets)) {
        setState("hidden")
        return
      }
      const already = r.json!.wallets!.some(
        (w) => typeof w?.wallet_addr === "string" && normalizeAddress(w.wallet_addr) === addr,
      )
      setState(already ? "saved" : "can-save")
    })
    return () => {
      cancelled = true
    }
  }, [addr, valid, collectionUuid])

  if (!valid || state === "unknown" || state === "hidden") return null

  async function save() {
    setState("saving")
    setMessage(null)
    try {
      const res = await fetch("/api/profile/saved-wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddr: addr, collectionId: collectionUuid }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setState("error")
        setMessage(
          typeof data?.message === "string" ? data.message : `Couldn't save this wallet (HTTP ${res.status}).`,
        )
        return
      }
      setState("saved")
    } catch {
      setState("error")
      setMessage("Couldn't reach RPC. Try again in a moment.")
    }
  }

  const baseStyle = {
    background: "transparent",
    border: "1px solid var(--rpc-border)",
    borderRadius: "var(--radius-md)",
    padding: "8px 12px",
    fontSize: "var(--text-sm)",
    color: "var(--rpc-text-secondary)",
  } as const

  if (state === "saved") {
    return (
      <span style={{ ...baseStyle, cursor: "default" }} title="This wallet is saved to your RPC profile">
        ✓ Saved to profile
      </span>
    )
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button
        onClick={save}
        disabled={state === "saving"}
        title="Save this wallet to your RPC profile and dashboard"
        style={{ ...baseStyle, cursor: state === "saving" ? "wait" : "pointer" }}
      >
        {state === "saving" ? "Saving…" : "Save to my profile"}
      </button>
      {message && (
        <span role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-danger)", maxWidth: 280 }}>
          {message}
        </span>
      )}
    </span>
  )
}
