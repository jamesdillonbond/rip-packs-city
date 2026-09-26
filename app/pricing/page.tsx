// app/pricing/page.tsx
//
// Redirects home. Trevor, 2026-09-25: no paid account is mentioned or
// considered anywhere on the website until RPC reaches 100 weekly active users
// — so there is no pricing page to show. It was already out of the footer and
// the sitemap (2026-09-07); this removes the last surface. The Stripe plumbing
// (app/api/stripe/*, components/pricing/StripeSubscribeButton) stays in the
// repo, unreferenced, for the day that gate clears.
//
// A redirect rather than a 404 so an old link (a bookmark, an earlier
// concierge answer) lands somewhere useful. proxy.ts still lists /pricing as
// public so a signed-out visitor is sent home, not to /login.

import type { Metadata } from "next"
import { redirect } from "next/navigation"

export const metadata: Metadata = {
  robots: { index: false, follow: true },
}

export default function PricingPage(): never {
  redirect("/")
}
