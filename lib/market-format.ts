// Pure display/link helpers for the collection market page
// (app/(collections)/[collection]/market/page.tsx). Extracted so the deal-badge
// classification and the dead-outbound-link rejection are unit-tested (the page
// is outside the coverage include). Generic over a minimal listing shape so this
// module doesn't depend on the page's local types.

/** Comma-separated string → trimmed, non-empty parts. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(",").map((s) => s.trim()).filter(Boolean)
}

/**
 * Deal-discount badge: text + color band. >=25% and >=10% are green shades,
 * a small positive discount is muted, a NEGATIVE discount is a PREMIUM (shown
 * "+N%" in red), and exactly 0 is neutral. A regression here mis-colors deals
 * (e.g. a premium rendered as a discount).
 */
export function fmtDiscount(d: number | null): { text: string; color: string } {
  if (d == null) return { text: "—", color: "var(--rpc-text-ghost)" }
  if (d >= 25) return { text: `-${d.toFixed(0)}%`, color: "#22C55E" }
  if (d >= 10) return { text: `-${d.toFixed(0)}%`, color: "#84CC16" }
  if (d > 0) return { text: `-${d.toFixed(0)}%`, color: "var(--rpc-text-secondary)" }
  if (d < 0) return { text: `+${Math.abs(d).toFixed(0)}%`, color: "#EF4444" }
  return { text: "0%", color: "var(--rpc-text-muted)" }
}

/** Minimal listing shape resolveListingUrl needs (the page's Listing satisfies it). */
export interface ListingLinkFields {
  buyUrl?: string | null
  flowId?: string | null
}

/**
 * Resolve the outbound "View listing" URL, REJECTING known-dead links before
 * returning them: Flowty (marketplace shut 2026-05), and the TopShot
 * `listings/p2p?editionFlowID=<setID:playID>` form (that param carries
 * setID:playID, NOT the numeric edition flowID, so the link is dead). Falls back
 * to the native moment page only when a real on-chain moment id (flowId) exists.
 */
export function resolveListingUrl(
  listing: ListingLinkFields,
  momentUrl: (id: string) => string | null,
): string | null {
  const url = listing.buyUrl?.trim()
  const isDead =
    !url ||
    url.includes("flowty.io") ||
    url.includes("editionFlowID=") ||
    url.includes("/listings/p2p")
  if (url && !isDead) return url
  return listing.flowId ? momentUrl(listing.flowId) : null
}

/** Distinct non-empty values picked from rows, locale-sorted. Generic over the row type. */
export function collectDistinct<T>(rows: T[], pick: (l: T) => string | null | undefined): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    const v = pick(r)
    if (v != null && v !== "") seen.add(String(v))
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}
