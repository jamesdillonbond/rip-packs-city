// components/FunnelTracker.tsx
//
// Client wrapper that emits a top-of-funnel event (funnel_events) on mount.
// Used on server-rendered pages (/share/<wallet>, /insights/*) where the page
// is a server component but the event must fire a client-side beacon.
// Fire-and-forget — it renders nothing and never blocks.
//
// perPath: when true, re-fires whenever the pathname changes (so a single
// instance mounted in the /insights layout logs an insights_view for the hub
// AND each /insights/* surface as the visitor navigates between them).

"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import { trackFunnelEvent, type FunnelEventType } from "@/lib/track-funnel"

export default function FunnelTracker({
  eventType,
  walletAddress,
  surface,
  perPath = false,
}: {
  eventType: FunnelEventType
  walletAddress?: string | null
  surface?: string | null
  perPath?: boolean
}) {
  const pathname = usePathname()
  const lastFired = useRef<string | null>(null)

  useEffect(() => {
    const key = perPath ? `${eventType}:${pathname}` : eventType
    if (lastFired.current === key) return
    lastFired.current = key
    trackFunnelEvent({
      eventType,
      walletAddress: walletAddress ?? null,
      surface: surface ?? pathname,
      // referrer is deliberately NOT passed: lib/track-funnel resolves the
      // session's campaign attribution (utm_* + the INITIAL external referrer)
      // once on the landing hit and stamps it on every event. Passing the live
      // document.referrer here overwrote that with our own origin as soon as
      // the visitor navigated internally, which is why /insights arrivals all
      // looked referrer-less. (2026-07-25)
    })
  }, [eventType, pathname, perPath, walletAddress, surface])

  return null
}
