"use client"

// components/profile/FollowedWalletsList.tsx
//
// The wallets a collector follows (2026-11-16), shown at the top of Friend
// Activity on /dashboard so a follow is visible and reversible from the place
// its activity lands. A follow is NOT a saved wallet: nothing here adds to the
// binder or the value totals. Three states: failed read says so (never "you
// follow nobody"), empty renders nothing, rows render as chips.

import { useEffect, useState } from "react"
import Link from "next/link"
import { truncateAddressForDisplay } from "@/lib/address"
import { fetchJson } from "@/lib/analytics/fetch-json"

type Row = { wallet_addr: string; username: string | null }
type State = { kind: "loading" } | { kind: "failed" } | { kind: "ok"; rows: Row[] }

export default function FollowedWalletsList() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchJson<{ wallets?: unknown }>("/api/profile/followed-wallets", { cache: "no-store" }).then((r) => {
      if (cancelled) return
      if (!r.ok || !Array.isArray(r.json?.wallets)) return setState({ kind: "failed" })
      setState({ kind: "ok", rows: r.json!.wallets as Row[] })
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function unfollow(addr: string) {
    if (busy || state.kind !== "ok") return
    setBusy(addr)
    try {
      const res = await fetch("/api/profile/followed-wallets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: addr }),
      })
      if (res.ok) setState({ kind: "ok", rows: state.rows.filter((r) => r.wallet_addr !== addr) })
    } catch {
      // network failure: the row stays, which is the truth — still followed
    } finally {
      setBusy(null)
    }
  }

  const mono = "var(--font-mono)"
  if (state.kind === "loading") return null
  if (state.kind === "failed") {
    return (
      <div role="status" style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10 }}>
        Couldn&apos;t load the wallets you follow. This is a loading problem — nothing was unfollowed.
      </div>
    )
  }
  if (state.rows.length === 0) return null

  return (
    <div data-testid="followed-wallets" style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 6 }}>
        Wallets you follow · not part of your collection
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {state.rows.map((r) => {
          const name = r.username ? "@" + r.username : truncateAddressForDisplay(r.wallet_addr)
          return (
            <span key={r.wallet_addr} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", border: "1px solid var(--rpc-border)", borderRadius: 6, fontFamily: mono, fontSize: 11 }}>
              <Link href={"/share/" + encodeURIComponent(r.wallet_addr)} style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>
                {name}
              </Link>
              <button
                type="button"
                onClick={() => unfollow(r.wallet_addr)}
                disabled={busy === r.wallet_addr}
                aria-label={`Unfollow ${name}`}
                title={`Unfollow ${name}`}
                style={{ background: "transparent", border: "none", color: "var(--rpc-text-muted)", cursor: "pointer", fontSize: 12, padding: 0 }}
              >
                ✕
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}
