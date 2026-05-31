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
      referrer: typeof document !== "undefined" ? document.referrer || null : null,
    })
  }, [eventType, pathname, perPath, walletAddress, surface])

  return null
}
