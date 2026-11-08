// app/trophy-challenges/[slug]/page.tsx
//
// A trophy-case challenge board (2026-11-06; first: /trophy-challenges/dame-time).
// Server shell; ChallengeBoardClient reads /api/public/trophy-challenges/<slug>.
// Not indexed: a challenge is shared by the people in it, and its entries change
// by the minute (an ISR'd board would also cache a failed read — CLAUDE.md #33).
//
// An unknown slug is a real 404 (probeTrophyChallenge — a SUCCESSFUL read that
// returned nothing). A failed probe still renders the board, whose client shows
// its own retry notice: a failed read is never published as "no such challenge".

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import { probeTrophyChallengeLive } from "@/lib/trophy/challenge-probe"
import ChallengeBoardClient from "./ChallengeBoardClient"
import { challengeDescription } from "@/lib/trophy/challenge-copy"

export const dynamic = "force-dynamic"

// One read per request, shared by generateMetadata and the page.
const probeOnce = cache((slug: string) => probeTrophyChallengeLive(slug))

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const probe = await probeOnce(slug)
  if (probe.kind === "missing") {
    // The page will notFound(); this object still streams into the 404's <head>.
    // Mirror app/not-found.tsx — no canonical/og naming a URL that does not exist.
    return {
      title: "404",
      description: "The page you're looking for isn't here.",
      robots: { index: false, follow: false },
      alternates: null,
      openGraph: null,
      twitter: null,
    }
  }
  const named = probe.kind === "found"
  const title = named ? `${probe.title} · Trophy case challenge` : "Trophy case challenge"
  const description = challengeDescription(named ? probe : null)
  const canonical = `https://www.rippackscity.com/trophy-challenges/${slug}`
  // Its OWN card (2026-11-07, Trevor: challenges "should have their own special
  // link preview"). ⚠ Every og/twitter field restated — Next REPLACES these
  // objects per route, so the root defaults would not survive.
  // `?s=` = what the card draws (#239): a new entry is a new image URL for every cache.
  const token = named ? probe.cardToken : null
  const image = `https://www.rippackscity.com/api/og/trophy-challenge/${encodeURIComponent(slug)}${token ? `?s=${token}` : ""}`
  const alt = named ? `${probe.title} — a Rip Packs City trophy case challenge` : "A Rip Packs City trophy case challenge"
  return {
    title,
    description,
    robots: { index: false, follow: true },
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

export default async function TrophyChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const probe = await probeOnce(slug)
  if (probe.kind === "missing") notFound()
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
