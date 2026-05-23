"use client"

import { useState } from "react"

// Copy-link button for the pack detail hero. Server page imports it as a
// client island so the rest of the page can stay server-rendered.
export default function PackShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url)
      } else {
        // Fallback for unsecured contexts that don't expose Clipboard API.
        const ta = document.createElement("textarea")
        ta.value = url
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Silently no-op; the share button is non-critical.
    }
  }

  return (
    <button
      onClick={handleCopy}
      style={{
        display: "inline-block",
        padding: "8px 16px",
        background: "transparent",
        color: copied ? "rgb(110,231,183)" : "rgba(255,255,255,0.85)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontSize: 12,
        borderRadius: 4,
        border: copied ? "1px solid rgba(16,185,129,0.4)" : "1px solid rgba(255,255,255,0.2)",
        cursor: "pointer",
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  )
}
