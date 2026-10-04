"use client"

// Signed-in viewers of /share/<wallet> can attach that wallet to their account
// in one click (2026-10-04). The funnel watch caught a new open-door signup who
// pasted their username into the home box, landed here on their own collection,
// and left: nothing on this page could save it, so their /dashboard stayed empty.
//
// ⚠ Anonymous viewers see NOTHING from this island. The share card is the
// top-of-funnel wedge (components/WalletSearch.tsx routes every paste here on
// purpose); it must render exactly as before for them.
//
// Save semantics are the dashboard's, not new ones (DashboardClient
// resolveAndAssociate): a Flow address fans out across every published Flow
// collection via resolve-and-associate; a Candy (Solana, base58) address is one
// saved_wallets row. normalizeAddress, never toLowerCase: base58 is
// case-sensitive.

import { useEffect, useState } from "react"
import Link from "next/link"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"
import { detectAddressChain, normalizeAddress } from "@/lib/address"
import { getPublishedCollection } from "@/lib/collections"
import { fetchJson } from "@/lib/analytics/fetch-json"

type State =
  | { kind: "unknown" } // session not known yet — render nothing (no flash)
  | { kind: "anon" } // render nothing
  | { kind: "ready" }
  | { kind: "already" } // this wallet is already on the viewer's account
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "signed-out" } // session lapsed between load and click (401)
  | { kind: "failed" }

export default function SaveToCollectionCTA({ wallet }: { wallet: string }) {
  const [state, setState] = useState<State>({ kind: "unknown" })
  const address = normalizeAddress(wallet)
  const chain = detectAddressChain(address)

  useEffect(() => {
    let active = true
    const supabase = getSupabaseBrowser()
    const onSession = async (signedIn: boolean) => {
      if (!active) return
      if (!signedIn) {
        setState({ kind: "anon" })
        return
      }
      // Already saved? A FAILED read is not "not saved": fall through to the
      // button, because saving again is an upsert and harmless.
      const r = await fetchJson<{ wallets?: Array<{ wallet_addr?: string }> }>("/api/profile/saved-wallets", { cache: "no-store" })
      if (!active) return
      const saved = r.ok && (r.json?.wallets ?? []).some((w) => normalizeAddress(String(w.wallet_addr ?? "")) === address)
      setState(saved ? { kind: "already" } : { kind: "ready" })
    }
    supabase.auth.getUser().then(({ data }: { data: { user: unknown } | null }) => onSession(!!data?.user))
    const { data: sub } = supabase.auth.onAuthStateChange((_e: string, session: { user?: unknown } | null) => {
      if (!session?.user && active) setState({ kind: "anon" })
    })
    return () => {
      active = false
      sub?.subscription?.unsubscribe()
    }
  }, [address])

  if (state.kind === "unknown" || state.kind === "anon") return null

  // A share wallet is always an address; anything else (a username) is not
  // this island's job, so it does not offer a save it would get wrong.
  const candy = getPublishedCollection("candy-mlb")
  const savable = chain === "cadence" || (chain === "solana" && !!candy?.supabaseCollectionId)
  if (!savable) return null

  async function save() {
    setState({ kind: "saving" })
    try {
      const res =
        chain === "solana"
          ? await fetch("/api/profile/saved-wallets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ walletAddr: address, collectionId: candy!.supabaseCollectionId }),
            })
          : await fetch("/api/profile/resolve-and-associate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ address }),
            })
      if (res.status === 401) return setState({ kind: "signed-out" })
      setState(res.ok ? { kind: "saved" } : { kind: "failed" })
    } catch {
      setState({ kind: "failed" })
    }
  }

  const linkStyle = { color: "var(--rpc-red)", fontWeight: 700, textDecoration: "none" } as const
  const noteStyle = { fontSize: 13, color: "var(--rpc-text-secondary)", alignSelf: "center" } as const

  if (state.kind === "already") {
    return (
      <Link
        href="/dashboard"
        style={{ padding: "12px 24px", border: "1px solid var(--rpc-border)", borderRadius: 8, color: "var(--rpc-text-secondary)", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.04em" }}
      >
        In your collection — open dashboard →
      </Link>
    )
  }
  if (state.kind === "saved") {
    return (
      <span role="status" style={noteStyle}>
        Saved — indexing your moments, usually 30–60 seconds.{" "}
        <Link href="/dashboard" style={linkStyle}>Open your dashboard →</Link>
      </span>
    )
  }
  if (state.kind === "signed-out") {
    return (
      <span role="status" style={noteStyle}>
        Your session ended. <Link href="/login" style={linkStyle}>Sign in again</Link> to save this wallet.
      </span>
    )
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <button
        onClick={save}
        disabled={state.kind === "saving"}
        style={{
          padding: "12px 24px",
          background: "var(--rpc-red)",
          border: "none",
          borderRadius: 8,
          // brand-exception: white label on the red button — theme-independent
          color: "#fff",
          fontWeight: 700,
          fontSize: 14,
          cursor: state.kind === "saving" ? "wait" : "pointer",
          letterSpacing: "0.04em",
          opacity: state.kind === "saving" ? 0.7 : 1,
        }}
      >
        {state.kind === "saving" ? "Saving…" : "Save to my collection"}
      </button>
      {state.kind === "failed" && (
        // Says what failed (our save), never anything about the wallet.
        <span role="alert" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
          Couldn&apos;t save just now. This says nothing about the wallet. Try again in a moment.
        </span>
      )}
    </span>
  )
}
