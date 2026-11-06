// app/trophy-challenges/[slug]/page.tsx
//
// A trophy-case challenge board (2026-11-06; first: /trophy-challenges/dame-time).
// Server shell; ChallengeBoardClient reads /api/public/trophy-challenges/<slug>.
// Not indexed: a challenge is shared by the people in it, and its entries change
// by the minute (an ISR'd board would also cache a failed read — CLAUDE.md #33).

import type { Metadata } from "next"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import ChallengeBoardClient from "./ChallengeBoardClient"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return {
    title: "Trophy case challenge",
    description: "Collectors show off their trophy cases for a Rip Packs City challenge.",
    robots: { index: false, follow: true },
    alternates: { canonical: `https://www.rippackscity.com/trophy-challenges/${slug}` },
  }
}

export default async function TrophyChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (
    <>
      <GlobalSiteHeader />
      <PageContentAnchor />
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 16px 96px" }}>
        <ChallengeBoardClient slug={slug} />
      </main>
      <SiteFooter />
    </>
  )
}
