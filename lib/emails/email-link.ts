// lib/emails/email-link.ts
//
// Campaign tags for links in the emails RPC sends (2026-11-17).
//
// Before this, a click from the weekly digest, a reward-claim email or a
// feedback-shipped email landed with no referrer and no utm_*, so the page-view
// beacon (components/TelemetryPageView.tsx → metadata.ref) filed it as a DIRECT
// visit and scripts/demand-read.sql could not count what any email brought
// back. The Day-1 email already tagged its CTA (utm_source=email&utm_medium=day1);
// this is the same vocabulary for every other email:
//
//   utm_source=email · utm_medium=<which email> · utm_campaign=<which link>
//
// Only links to our own site are tagged. Unsubscribe / pause links are never
// passed through here (they are API routes, not landings).

const OWN_HOSTS = new Set(["www.rippackscity.com", "rippackscity.com"])

export function emailLink(url: string, medium: string, campaign: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const own = OWN_HOSTS.has(u.hostname) || u.hostname.endsWith(".vercel.app") || u.hostname === "localhost"
  if (!own) return url
  if (u.searchParams.has("utm_source")) return url
  u.searchParams.set("utm_source", "email")
  u.searchParams.set("utm_medium", medium)
  u.searchParams.set("utm_campaign", campaign)
  return u.toString()
}
