// app/giveaways/[slug]/page.tsx
//
// A community pack giveaway (v1: one admin). Server shell; the page itself is
// GiveawayClient, which reads /api/giveaways/<slug> so a signed-in visitor sees
// their own pack. Not indexed: a giveaway is shared by its sponsor, not searched.

import type { Metadata } from "next"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import SiteFooter from "@/components/SiteFooter"
import GiveawayClient from "./GiveawayClient"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return {
    title: "Free pack giveaway",
    description: "A free, provably fair pack giveaway on Rip Packs City. Claim a pack; the sponsor gifts it to your Top Shot account.",
    robots: { index: false, follow: false },
    alternates: { canonical: `https://www.rippackscity.com/giveaways/${slug}` },
  }
}

export default async function GiveawayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (
    <>
      <GlobalSiteHeader />
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 16px 96px" }}>
        <GiveawayClient slug={slug} />
      </main>
      <SiteFooter />
    </>
  )
}
