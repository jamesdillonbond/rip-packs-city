"use client"

// components/TelemetryPageView.tsx
//
// Mounts in the root layout; fires a `page-view` beacon to usage_events
// on every route change. Pathname-only — no query strings — so we don't
// fan out the analytics dimension to ~∞ unique values.
//
// Static asset paths and in-page hash navigations are
// intentionally skipped so the beacon stream stays signal.
//
// 2026-10-03: each beacon also carries `sid` (the per-tab "rpc_sess" id that
// funnel_events and outbound_clicks already use, same key the client_error
// beacon writes) and `ref` (the session's landing attribution: our utm_* /
// share_ref params and the external referrer's origin+path, resolved once per
// session by lib/track-funnel). Without them a page view could not be joined
// to the visit it belonged to — one ChatGPT-referred visitor on 10-03 showed
// up as 23 unrelated rows. Nothing new is collected: both values are already
// sent by the funnel tracker on the same page.

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { track } from "@/lib/telemetry/track"
import { getFunnelContext } from "@/lib/track-funnel"

const SKIP_PREFIXES = ["/_next", "/api", "/favicon", "/robots", "/sitemap", "/icons"]

export default function TelemetryPageView() {
  const pathname = usePathname() ?? "/"

  useEffect(() => {
    if (!pathname) return
    if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return
    const { sessionId, referrer, visitorId } = getFunnelContext()
    track("page-view", {
      path: pathname,
      ...(sessionId ? { sid: sessionId } : {}),
      ...(referrer ? { ref: referrer } : {}),
      // returning-visitor id (rpc_vid; absent under GPC/DNT) — lib/track-funnel.ts
      ...(visitorId ? { vid: visitorId } : {}),
    })
  }, [pathname])

  return null
}
