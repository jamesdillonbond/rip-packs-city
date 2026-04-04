"use client"

import React, { useState, useEffect } from "react"

const condensedFont = "'Barlow Condensed', sans-serif"
const monoFont = "'Share Tech Mono', monospace"
const RED = "#E03A2F"

type ProGateProps = {
  children: React.ReactNode
  walletAddress: string | null
}

/**
 * ProGate — gates children behind RPC Pro subscription status.
 * - No wallet: shows "Connect wallet" message
 * - Wallet but not Pro: shows upgrade prompt
 * - Pro: renders children
 */
export default function ProGate({ children, walletAddress }: ProGateProps) {
  const [isPro, setIsPro] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!walletAddress) {
      setIsPro(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/pro-status?wallet=${encodeURIComponent(walletAddress)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!cancelled) setIsPro(d?.isPro ?? false)
      })
      .catch(() => {
        if (!cancelled) setIsPro(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [walletAddress])

  if (!walletAddress) {
    return (
      <div style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: "32px 24px",
        textAlign: "center",
      }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 16, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em" }}>
          Connect wallet to access Pro features
        </div>
      </div>
    )
  }

  if (loading || isPro === null) {
    return <>{children}</>
  }

  if (!isPro) {
    return (
      <div style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${RED}33`,
        borderRadius: 12,
        padding: "32px 24px",
        maxWidth: 420,
      }}>
        <div style={{
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 28,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#F1F1F1",
          marginBottom: 4,
        }}>
          RPC <span style={{ color: RED }}>Pro</span>
        </div>
        <div style={{
          fontFamily: monoFont,
          fontSize: 24,
          color: RED,
          fontWeight: 700,
          marginBottom: 16,
        }}>
          $9/month
        </div>
        <ul style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 24px 0",
          fontFamily: monoFont,
          fontSize: 12,
          color: "rgba(255,255,255,0.7)",
          letterSpacing: "0.04em",
          lineHeight: 2,
        }}>
          <li>&#x2713; Unlimited FMV alerts</li>
          <li>&#x2713; Priority sniper updates</li>
          <li>&#x2713; Advanced portfolio analytics</li>
          <li>&#x2713; Export to CSV</li>
        </ul>
        <a
          href="mailto:trevor@rippackscity.com?subject=RPC%20Pro%20Early%20Access"
          style={{
            display: "inline-block",
            background: RED,
            color: "#fff",
            fontFamily: condensedFont,
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            padding: "10px 24px",
            borderRadius: 6,
            textDecoration: "none",
            transition: "opacity 0.15s",
          }}
        >
          Get Early Access
        </a>
      </div>
    )
  }

  return <>{children}</>
}
