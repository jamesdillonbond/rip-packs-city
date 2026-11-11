// app/giveaways/[slug]/page.tsx
//
// A community pack giveaway (v1: one admin). Server shell; the page itself is
// GiveawayClient, which reads /api/giveaways/<slug> so a signed-in visitor sees
// their own pack. Not indexed: a giveaway is shared by its sponsor, not searched.

import type { Metadata } from "next"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import GiveawayClient from "./GiveawayClient"
import { giveawayMeta } from "@/lib/giveaways/drop-meta"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  // The drop's own name and card (2026-11-10, Trevor sharing the Dame Time
  // reward packs on X: "This needs a link preview"). A failed read names no
  // drop: the generic title, still with the card (which falls back the same way).
  const named = await giveawayMeta(slug)
  const title = named ? named.title : "Free pack giveaway"
  const description = named?.gated
    ? "Free reward packs for every collector who completed the challenge. Claim yours on Rip Packs City; the Moments land in your Top Shot account in seconds."
    : "A free, provably fair pack giveaway on Rip Packs City. Claim a pack; the sponsor gifts it to your Top Shot account."
  const canonical = `https://www.rippackscity.com/giveaways/${slug}`
  const image = `https://www.rippackscity.com/api/og/giveaway/${encodeURIComponent(slug)}`
  const alt = named ? `${named.title} — a Rip Packs City pack giveaway` : "A Rip Packs City pack giveaway"
  // ⚠ Every og/twitter field restated — Next REPLACES these objects per route.
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "Rip Packs City",
      url: canonical,
      title: `${title} | Rip Packs City`,
      description,
      images: [{ url: image, width: 1200, height: 630, alt }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@RipPacksCity",
      creator: "@RipPacksCity",
      title: `${title} | Rip Packs City`,
      description,
      images: [{ url: image, alt }],
    },
  }
}

export default async function GiveawayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (
    <>
      <GlobalSiteHeader />
      <PageContentAnchor />
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 16px 96px" }}>
        <GiveawayClient slug={slug} />
      </main>
      <SiteFooter />
    </>
  )
}
