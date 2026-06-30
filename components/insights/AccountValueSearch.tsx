"use client"

// components/insights/AccountValueSearch.tsx
//
// Wallet-paste box for the /insights/account-value landing page. A Flow address
// goes straight to the public collection-snapshot card (/share/<wallet>), which
// leads with the account's TOTAL FMV — the literal "what's my account worth"
// answer. A Top Shot username is resolved first via the public /api/wallet-search.
// Mirrors the homepage WalletSearch + InsightsWalletSearch funnels. (2026-06-30.)

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/

export default function AccountValueSearch() {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const go = useCallback(
    (addr: string) => router.push(`/share/${encodeURIComponent(addr)}`),
    [router]
  )

  const submit = useCallback(async () => {
    const raw = value.trim()
    if (!raw || pending) return
    setError(null)
    if (FLOW_ADDRESS.test(raw)) {
      go(raw)
      return
    }
    setPending(true)
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: raw, limit: 1 }),
      })
      const data = await res.json().catch(() => null)
      const addr: string | undefined = data?.walletAddress
      if (addr && FLOW_ADDRESS.test(addr)) {
        go(addr)
        return
      }
      setError(data?.error || "Couldn't find that. Try a Flow wallet address (0x…).")
    } catch {
      setError("Something went wrong. Try again in a moment.")
    } finally {
      setPending(false)
    }
  }, [value, pending, go])

  return (
    <div style={{ maxWidth: 560, marginTop: 22 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--rpc-surface)",
          border: "1px solid var(--rpc-border)",
          borderRadius: 8,
          overflow: "hidden",
          height: 52,
        }}
      >
        <input
          aria-label="See your account's total value — Top Shot username or Flow wallet"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Top Shot username or Flow wallet (0x…)"
          style={{
            flex: 1,
            minWidth: 0,
            padding: "0 16px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--rpc-text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            background: "var(--rpc-red)",
            border: "none",
            color: "#fff",
            padding: "0 22px",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.7 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {pending ? "…" : "See value →"}
        </button>
      </form>
      {error ? (
        <div
          role="alert"
          style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-red)" }}
        >
          {error}
        </div>
      ) : null}
    </div>
  )
}
