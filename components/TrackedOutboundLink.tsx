// components/TrackedOutboundLink.tsx
//
// Client wrapper for an outbound marketplace link that logs the click to
// outbound_clicks (via lib/track-click) before the browser follows the href.
// Used on the public server-rendered detail pages (/moment, /pinnacle/moment)
// where the page itself is a server component but the click must fire a
// client-side beacon. Fire-and-forget — the beacon never blocks navigation.

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
  payload: OutboundClickPayload
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
      onClick={() => trackOutboundClick({ ...payload, buyUrl: payload.buyUrl ?? href })}
    >
      {children}
    </a>
  )
}
