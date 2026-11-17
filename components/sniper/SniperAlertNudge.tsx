"use client"

// components/sniper/SniperAlertNudge.tsx
//
// 2026-10-31: the people who hunt on the Sniper are the ones alerts are for, and
// they never meet the alert offer. shashmeister (signed up 10-21) re-ran a "not
// owned, ≤ $5, ≥ 15 % under FMV" Sniper search across 9 days and never set an
// alert; the only prompt lives on the dashboard. The 🔔 ALERT ME chip (10-24) is
// one of many chips. After a few REAL filter changes in a tab, with filters an
// alert can carry, this line offers the alert in place. Dismissal is remembered.

import Link from "next/link"
import { useEffect, useState } from "react"
import { track } from "@/lib/telemetry/track"

export const NUDGE_AFTER_CHANGES = 3
const DISMISS_KEY = "rpc_sniper_alert_nudge_dismissed"

/** True when an /alerts prefill carries at least one real criterion beyond its collection. */
export function alertHrefHasCriteria(href: string | null | undefined): boolean {
  if (!href) return false
  const q = new URLSearchParams(href.split("?")[1] ?? "")
  return ["tier", "parallel", "player", "team", "maxPrice", "minDiscount"].some((k) => q.has(k))
}

export function shouldNudge(changes: number, href: string | null | undefined, dismissed: boolean): boolean {
  return !dismissed && changes >= NUDGE_AFTER_CHANGES && alertHrefHasCriteria(href)
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

export default function SniperAlertNudge({ alertHref, changes }: { alertHref: string | null; changes: number }) {
  // Lazy read is hydration-safe: the server and first client render both have
  // changes=0 (no real filter change yet), so both render nothing either way.
  const [dismissed, setDismissed] = useState(readDismissed)
  const show = shouldNudge(changes, alertHref, dismissed)
  useEffect(() => {
    if (show) track("sniper-alert-nudge-shown", {})
  }, [show])
  if (!show || !alertHref) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      /* per-tab only then */
    }
    track("sniper-alert-nudge-dismissed", {})
  }
  return (
    <div
      data-rpc-sniper-alert-nudge
      role="note"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, margin: "0 0 12px", padding: "10px 14px", border: "1px solid var(--rpc-red-border)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--rpc-text-secondary)" }}
    >
      <span style={{ flex: "1 1 220px", minWidth: 0 }}>Hunting this search? Get told when a new listing matches it instead of checking back.</span>
      <Link href={alertHref} onClick={() => track("sniper-alert-nudge-click", {})} className="rpc-chip" style={{ textDecoration: "none" }}>
        🔔 Alert me on these filters
      </Link>
      <button type="button" onClick={dismiss} className="rpc-chip" aria-label="Dismiss the alert suggestion">
        Not now
      </button>
    </div>
  )
}
