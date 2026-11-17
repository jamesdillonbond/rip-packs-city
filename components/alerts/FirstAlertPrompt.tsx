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

// 2026-10-31: blaise_27 was shown this card 4 times across 2 days and never acted.
// A card that repeats on every dashboard load turns into wallpaper. It now shows
// on at most FIRST_ALERT_MAX_SHOWS loads per browser and has a "Not now".
export const FIRST_ALERT_MAX_SHOWS = 3
const SHOWS_KEY = "rpc_first_alert_shows"

export function firstAlertCapped(shows: number): boolean {
  return shows >= FIRST_ALERT_MAX_SHOWS
}

// 2026-11-10: two more rules, from the 11-03..11-10 week (84 shows, 2 clicks).
// (1) Not on a new member's first visit: the card sat beside the challenge
//     invite on every brand-new dashboard, and new members acted on the
//     challenge (27 entries) and not on this. It waits until FIRST_ALERT_DELAY_MS
//     after this browser first saw the dashboard.
// (2) One count per page load: the dashboard mounts the card twice per load
//     (both logged within seconds on every new account), so the 3-show cap was
//     spent in under two visits and the shown count was doubled.
export const FIRST_ALERT_DELAY_MS = 12 * 60 * 60 * 1000
const FIRST_SEEN_KEY = "rpc_first_alert_first_seen"

/** True while the card should wait: this browser has not seen the dashboard
 *  before (null) or saw it less than FIRST_ALERT_DELAY_MS ago. */
export function firstAlertTooSoon(firstSeenMs: number | null, nowMs: number): boolean {
  if (firstSeenMs == null || !Number.isFinite(firstSeenMs)) return true
  return nowMs - firstSeenMs < FIRST_ALERT_DELAY_MS
}

function readFirstSeen(nowMs: number): number | null {
  try {
    const raw = localStorage.getItem(FIRST_SEEN_KEY)
    const n = raw == null ? NaN : Number(raw)
    if (Number.isFinite(n) && n > 0) return n
    localStorage.setItem(FIRST_SEEN_KEY, String(nowMs))
    return null
  } catch {
    // storage unavailable: no way to know it is a later visit, so never wait —
    // the 3-show cap is equally unavailable, which is the pre-11-10 behaviour.
    return 0
  }
}

// Module state survives a re-mount within one page load and resets on a reload.
let decidedThisLoad: FirstAlertState | null = null
/** Test seam: start a fresh "page load". */
export function resetFirstAlertPageLoad(): void {
  decidedThisLoad = null
}

function readShows(): number {
  try {
    const n = Number(localStorage.getItem(SHOWS_KEY) ?? "0")
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function writeShows(n: number): void {
  try {
    localStorage.setItem(SHOWS_KEY, String(n))
  } catch {
    /* storage unavailable: the card simply is not capped in this browser */
  }
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
      // A second mount in the same page load reuses the first decision: no new
      // count, no second "shown" event.
      if (decidedThisLoad !== null) {
        setState(decidedThisLoad === "show" ? firstAlertState(moment, subs) : "hide")
        return
      }
      let next = firstAlertState(moment, subs)
      // hydration-safe: inside a fetch callback in useEffect — never during render, nothing server-rendered reads it
      const nowMs = Date.now()
      if (next === "show" && firstAlertTooSoon(readFirstSeen(nowMs), nowMs)) next = "hide"
      if (next === "show") {
        const shows = readShows()
        if (firstAlertCapped(shows)) next = "hide"
        else writeShows(shows + 1)
      }
      if (next !== "unknown") decidedThisLoad = next
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
      <button
        type="button"
        className="rpc-chip"
        aria-label="Hide the alert suggestion"
        onClick={() => {
          writeShows(FIRST_ALERT_MAX_SHOWS)
          decidedThisLoad = "hide"
          setState("hide")
          track("first-alert-prompt-dismissed", { surface: "dashboard" })
        }}
      >
        Not now
      </button>
    </section>
  )
}
