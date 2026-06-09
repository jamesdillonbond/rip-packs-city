"use client"

// components/insights/InsightsWalletSearch.tsx
//
// Above-the-fold wallet-paste box on the /insights hub. A Flow address goes
// straight to the public Top Collector Report (/insights/tc-report?wallet=…); a
// Top Shot username is resolved first via the public /api/wallet-search. Mirrors
// the homepage WalletSearch funnel, pointed at the deep public report rather
// than /share. (2026-06-09 funnel.)

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/

export default function InsightsWalletSearch() {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const go = useCallback(
    (addr: string) => router.push(`/insights/tc-report?wallet=${encodeURIComponent(addr)}`),
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
          aria-label="Run a Top Collector Report for a Top Shot username or Flow wallet"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Run a report — Top Shot username or Flow wallet (0x…)"
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
          {pending ? "…" : "Run →"}
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
