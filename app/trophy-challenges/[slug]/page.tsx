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
  return {
    title: named ? `${probe.title} · Trophy case challenge` : "Trophy case challenge",
    description:
      named && probe.tagline
        ? probe.tagline
        : "Collectors show off their trophy cases for a Rip Packs City challenge.",
    robots: { index: false, follow: true },
    alternates: { canonical: `https://www.rippackscity.com/trophy-challenges/${slug}` },
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
