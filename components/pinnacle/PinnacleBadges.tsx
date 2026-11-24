// components/pinnacle/PinnacleBadges.tsx
//
// Disney Pinnacle's own badge icons (2026-11-23) — the art Pinnacle publishes, served same-origin through
// /api/badge-image?src=pinnacle. Which badges a pin earns: lib/pinnacle/pin-badges.ts. A badge whose image fails to
// load hides itself (decorative; the label/tooltip carries the meaning). No hooks, so it renders on server and client.

import {
  PINNACLE_BADGE_LABELS,
  PINNACLE_BADGE_MEANINGS,
  pinnacleBadgeIconUrl,
  type PinnacleBadgeSlug,
} from "@/lib/pinnacle/pin-badges"

export default function PinnacleBadges({
  badges,
  size = 22,
  showLabels = false,
}: {
  badges: PinnacleBadgeSlug[]
  size?: number
  showLabels?: boolean
}) {
  if (badges.length === 0) return null
  return (
    <span data-testid="pinnacle-badges" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: showLabels ? 10 : 4 }}>
      {badges.map((b) => (
        <span
          key={b}
          title={`${PINNACLE_BADGE_LABELS[b]} — ${PINNACLE_BADGE_MEANINGS[b]}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pinnacleBadgeIconUrl(b)}
            alt={PINNACLE_BADGE_LABELS[b]}
            width={size}
            height={size}
            loading="lazy"
            style={{ width: size, height: size, borderRadius: "50%" }}
          />
          {showLabels ? (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", letterSpacing: "0.04em" }}>
              {PINNACLE_BADGE_LABELS[b]}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  )
}
