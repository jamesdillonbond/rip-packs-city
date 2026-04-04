"use client"

import { useState } from "react"

export default function ShareButton() {
  const [copied, setCopied] = useState(false)

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(window.location.href)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      style={{
        padding: "12px 24px",
        background: "#E03A2F",
        border: "none",
        borderRadius: 8,
        color: "#fff",
        fontWeight: 700,
        fontSize: 14,
        cursor: "pointer",
        letterSpacing: "0.04em",
      }}
    >
      {copied ? "Link Copied!" : "Share"}
    </button>
  )
}
