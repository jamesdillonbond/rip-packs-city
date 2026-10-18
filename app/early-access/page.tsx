// app/early-access/page.tsx
//
// Thin server shell. The signup form is a controlled client form with its own
// validation, an on-blur on-chain nudge and a submit state machine, so the body
// lives in EarlyAccessClient.tsx — which the component coverage gate measures
// (`app/**/*Client.tsx`). A `page.tsx` matches NEITHER gate's include.

import type { Metadata } from "next"
import EarlyAccessClient from "./EarlyAccessClient"
import SupportChatConnected from "@/components/SupportChatConnected"
import { OG_INHERITED, TWITTER_INHERITED, publishedCollectionsPhrase } from "@/lib/seo"

// 2026-10-11 (review §3 E8): this page inherited the ROOT title + description
// verbatim and is anon-public, so Google saw a duplicate of the home page with
// no inbound links. Own copy + self-canonical; noindex because the home page is
// the page that should rank for this, and nothing links here. `follow` stays
// true: the sign-in / insights links out are real pages.
export const metadata: Metadata = {
  title: "Early Access",
  description:
    `Join the Rip Packs City early-access list — collector intelligence for ${publishedCollectionsPhrase()}. Free, no credit card.`,
  alternates: { canonical: "https://www.rippackscity.com/early-access" },
  robots: { index: false, follow: true },
  openGraph: {
    ...OG_INHERITED,
    title: "Early Access — Rip Packs City",
    description: "Join the early-access list for free digital collectibles intelligence.",
    url: "https://www.rippackscity.com/early-access",
  },
  twitter: {
    ...TWITTER_INHERITED,
    title: "Early Access — Rip Packs City",
    description: "Join the early-access list for free digital collectibles intelligence.",
  },
}

export default function EarlyAccessPage() {
  return (
    <>
      <EarlyAccessClient />
      {/* Concierge, added 2026-09-02 with the /insights + home mounts: this is a
          public entry point a stranger lands on and it had no way to ask a
          question. No sub-layout here carries the launcher, so there is no
          double-mount. Revert: delete this line and the import. */}
      <SupportChatConnected />
    </>
  )
}
