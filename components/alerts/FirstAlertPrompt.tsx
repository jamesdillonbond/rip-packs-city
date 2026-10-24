"use client"

// components/alerts/FirstAlertPrompt.tsx
//
// Dashboard card that makes an alert the first thing a new account sets up
// (2026-10-14). Measured 10-08..10-14: alerts were the feature real users went
// to — every signed-in outbound click (4) came from an alert, and the one
// concierge conversation was about alerts — while the week's new signup
// browsed for three minutes, set nothing up, and did not return.
//
// Honesty: the card states "you have no alerts yet", so it renders ONLY when
// BOTH alert reads (per-moment fmv_alerts via /api/alerts, including paused
// ones, and deal subscriptions via /api/alerts/subscriptions) came back ok AND
// empty. A failed or unknown read renders nothing — telling a collector with
// five alerts to "set up your first" is the false claim this rule prevents.

import { useEffect, useState } from "react"
import Link from "next/link"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { track } from "@/lib/telemetry/track"

export type FirstAlertState = "unknown" | "show" | "hide"

export function firstAlertState(
  moment: { ok: boolean; json: unknown },
  subs: { ok: boolean; json: unknown },
): FirstAlertState {
  if (!moment.ok || !subs.ok) return "hide"
  const momentRows = Array.isArray(moment.json) ? moment.json : null
  const subRows = (subs.json as { subscriptions?: unknown } | null)?.subscriptions
  if (momentRows === null || !Array.isArray(subRows)) return "hide" // unexpected shape = unknown
  return momentRows.length === 0 && subRows.length === 0 ? "show" : "hide"
}

export default function FirstAlertPrompt() {
  const [state, setState] = useState<FirstAlertState>("unknown")

  useEffect(() => {
    let active = true
    Promise.all([
      fetchJson<unknown>("/api/alerts?include_inactive=1", { cache: "no-store" }),
      fetchJson<unknown>("/api/alerts/subscriptions", { cache: "no-store" }),
    ]).then(([moment, subs]) => {
      if (!active) return
      const next = firstAlertState(moment, subs)
      setState(next)
      if (next === "show") track("first-alert-prompt-shown", { surface: "dashboard" })
    })
    return () => {
      active = false
    }
  }, [])

  if (state !== "show") return null

  return (
    <section
      className="rpc-card"
      data-rpc-first-alert
      style={{ marginBottom: 20, padding: "18px 20px", border: "1px solid var(--rpc-red-border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 280px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
          Set up your first alert
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
          Get notified when a listing drops below FMV — by player, set, team, tier, price or discount — on email, Telegram or Discord.
        </span>
      </div>
      <Link
        href="/alerts"
        onClick={() => track("first-alert-prompt-click", { surface: "dashboard" })}
        // brand-exception: white label on the red CTA button — theme-independent
        style={{ padding: "12px 20px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}
      >
        Create an alert →
      </Link>
    </section>
  )
}
