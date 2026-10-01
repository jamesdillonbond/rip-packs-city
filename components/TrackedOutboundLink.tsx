// components/TrackedOutboundLink.tsx
//
// Client wrapper for an outbound marketplace link that logs the click to
// outbound_clicks (via lib/track-click) before the browser follows the href.
// Exists for SERVER components (the /moment/[id], [collection]/edition/[slug]
// and [collection]/pack/dist/[distId] pages), which cannot attach an onClick
// themselves; client components may use it too (the Pack Sniper does).
// Fire-and-forget — the beacon never blocks navigation.
//
// The payload must carry `collection` — a moment id is unique only within a
// collection, so a click without one cannot be matched to the sale that
// followed it. __tests__/outbound-clicks-carry-their-collection.test.ts reds
// any <TrackedOutboundLink> whose payload omits it.

"use client"

import { trackOutboundClick, type OutboundClickPayload } from "@/lib/track-click"

export default function TrackedOutboundLink({
  href,
  payload,
  children,
  className,
  style,
}: {
  href: string
  // `collection` is REQUIRED here (it is optional on OutboundClickPayload only
  // for legacy callers): pass null explicitly when it is genuinely unknown.
  payload: OutboundClickPayload & { collection: string | null }
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={style}
      onClick={() => trackOutboundClick({ ...payload, collection: payload.collection, buyUrl: payload.buyUrl ?? href })}
    >
      {children}
    </a>
  )
}
