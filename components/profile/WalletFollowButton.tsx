"use client"

// components/profile/WalletFollowButton.tsx
//
// Follow a WALLET (2026-11-16) — the friend path, kept apart from the
// save-as-mine path. Saving a friend's wallet made it "yours" on RPC (binder,
// totals, profile claim); following only feeds their buys and sells into
// Friend Activity on /dashboard. Works for a friend who never signed up,
// which FollowButton (member → member) cannot.
//
// Probe on mount: GET /api/profile/followed-wallets?wallet= answers
// { authed, following, own }. Renders nothing for the viewer's OWN wallet and
// while loading. A failed probe is "unknown", never "not following" and never
// "signed out" (the FollowButton 10-23 lesson).

import { useEffect, useState } from "react"
import { normalizeAddress } from "@/lib/address"
import { isOnChainAddress } from "@/lib/postgrest-safe"
import { fetchJson } from "@/lib/analytics/fetch-json"

type State = "loading" | "hidden" | "anon" | "following" | "not-following" | "unknown" | "refused"

export default function WalletFollowButton({
  wallet,
  label,
  size = "sm",
}: {
  wallet: string
  /** "@handle" or shortened address, for the button's title. */
  label?: string
  size?: "sm" | "lg"
}) {
  const addr = wallet ? normalizeAddress(wallet) : ""
  const valid = !!addr && isOnChainAddress(addr)
  const [state, setState] = useState<State>("loading")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!valid) return
    let cancelled = false
    void fetchJson<{ authed?: unknown; following?: unknown; own?: unknown }>(
      "/api/profile/followed-wallets?wallet=" + encodeURIComponent(addr),
      { cache: "no-store" },
    ).then((r) => {
      if (cancelled) return
      const j = r.json
      if (!r.ok || !j || typeof j.authed !== "boolean") return setState("unknown")
      if (!j.authed) return setState("anon")
      if (j.own === true) return setState("hidden")
      setState(j.following === true ? "following" : "not-following")
    })
    return () => {
      cancelled = true
    }
  }, [addr, valid])

  if (!valid || state === "loading" || state === "hidden") return null

  const big = size === "lg"
  const base = {
    display: "inline-block",
    padding: big ? "12px 24px" : "8px 12px",
    borderRadius: big ? 8 : "var(--radius-md)",
    fontSize: big ? 14 : "var(--text-sm)",
    fontWeight: big ? 700 : 400,
    letterSpacing: big ? "0.04em" : undefined,
    background: "transparent",
    border: "1px solid var(--rpc-border)",
    color: "var(--rpc-text-secondary)",
    textDecoration: "none",
    cursor: "pointer",
  } as const

  if (state === "unknown") {
    return (
      <span data-testid="wallet-follow-unknown" title="Follow status couldn't be loaded — refresh to try again" style={{ ...base, cursor: "default", opacity: 0.7 }}>
        Follow unavailable
      </span>
    )
  }

  if (state === "anon") {
    const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/dashboard"
    return (
      <a href={"/login?next=" + encodeURIComponent(next)} style={base} title="Sign in to follow this wallet's buys and sells">
        + Follow (sign in)
      </a>
    )
  }

  async function toggle(on: boolean) {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const previous: State = on ? "not-following" : "following"
    setState(on ? "following" : "not-following")
    try {
      const res = await fetch("/api/profile/followed-wallets", {
        method: on ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: addr }),
      })
      if (res.status === 401) return setState("anon")
      if (res.status === 409) {
        // The status is the fact (refused); the body only names why.
        let data: { error?: unknown; message?: unknown } | null = null
        try {
          data = await res.json()
        } catch {
          // unreadable body: still a refusal
        }
        if (data?.error === "own_wallet") return setState("hidden")
        setState(previous)
        setMessage(typeof data?.message === "string" ? data.message : "Couldn't follow this wallet.")
        return
      }
      if (!res.ok) {
        setState(previous)
        setMessage("Couldn't update follow just now. Try again in a moment.")
      }
    } catch {
      setState(previous)
      setMessage("Couldn't reach RPC. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  const following = state === "following"
  const who = label ?? "this wallet"
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        onClick={() => toggle(!following)}
        disabled={busy}
        aria-pressed={following}
        data-testid="wallet-follow"
        title={following ? `Unfollow ${who}` : `Follow ${who} — their buys and sells show up in Friend Activity on your dashboard. Doesn't add it to your collection.`}
        style={{ ...base, opacity: busy ? 0.6 : 1, color: following ? "var(--rpc-text-primary)" : base.color }}
      >
        {following ? "✓ Following" : "+ Follow"}
      </button>
      {message && (
        <span role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-danger-text)", maxWidth: 280 }}>
          {message}
        </span>
      )}
    </span>
  )
}
