"use client"

// components/FirstTouchCapture.tsx
//
// Records this browser's FIRST landing (attribution + path + time) in
// localStorage, and once the browser is signed in, sends it to
// /api/profile/attribution so the account keeps how the collector found us
// (2026-11-09, signup-wave remediation P2 — the magic link opens a new tab, and
// the sessionStorage attribution died with the old one). Renders nothing.
//
// Mounted once in the root layout beside RefCapture. Cost when signed out: one
// localStorage read. The sign-in check is the local supabase session (no
// network); the POST runs at most until it is answered once per account.

import { useEffect } from "react"
import { getCampaignAttribution, getVisitorId, hasPrivacySignal } from "@/lib/track-funnel"
import { buildFirstTouch, parseFirstTouch, FIRST_TOUCH_KEY, FIRST_TOUCH_CLAIMED_KEY } from "@/lib/first-touch"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"

export default function FirstTouchCapture() {
  useEffect(() => {
    let cancelled = false
    try {
      if (hasPrivacySignal()) {
        try {
          localStorage.removeItem(FIRST_TOUCH_KEY)
        } catch {
          /* ignore */
        }
        return
      }
      let ft = parseFirstTouch(localStorage.getItem(FIRST_TOUCH_KEY))
      if (!ft) {
        ft = buildFirstTouch(getCampaignAttribution(), window.location.pathname, getVisitorId())
        localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(ft))
      }
      const record = ft
      void (async () => {
        try {
          const { data } = await getSupabaseBrowser().auth.getSession()
          const uid = data?.session?.user?.id
          if (!uid || cancelled) return
          if (localStorage.getItem(FIRST_TOUCH_CLAIMED_KEY) === uid) return
          const res = await fetch("/api/profile/attribution", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(record),
          })
          // 200 (stored or already on record) and 400 (will never be accepted)
          // are both FINAL for this account; anything else retries on a later page.
          if (res.status === 200 || res.status === 400) {
            localStorage.setItem(FIRST_TOUCH_CLAIMED_KEY, uid)
          }
        } catch {
          // Instrumentation must never break a page.
        }
      })()
    } catch {
      // localStorage can throw in private mode — non-fatal.
    }
    return () => {
      cancelled = true
    }
  }, [])
  return null
}
