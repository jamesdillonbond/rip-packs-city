// Server shell for /profile/<username>/trophy-case/<challenge> — ONE collector's
// entry in one trophy challenge (e.g. Dame Time), shareable on its own with its
// own social card (2026-11-07). Same narrow page as the main-case share page
// (../page.tsx), fed the entry's slabs instead of the main case.
//
// ⚠ Only ANSWERED reads may 404: no such collector, or the collector has no
// entry in this challenge. A FAILED read renders the shell with an honest
// notice — this URL gets pasted into chats, and a DB blip must not tell
// someone the case they just shared does not exist.
// ⚠ NEVER SUBSTITUTE the main case (or another challenge's) for a missing entry.

import { notFound } from "next/navigation"
import { getPublicProfile } from "@/lib/profile/public-profile"
import { getPublicChallengeCase } from "@/lib/trophy/public-challenge-case"
import { isChallengeSlug } from "@/lib/trophy/challenge-link"
import TrophyCaseShareClient from "../TrophyCaseShareClient"
import { titleFromSlug } from "./shared"

export const revalidate = 300
export const dynamicParams = true

export default async function ChallengeCasePage(props: {
  params: Promise<{ username: string; challenge: string }>
}) {
  const { username, challenge } = await props.params
  const key = decodeURIComponent(username ?? "").trim()
  const slug = decodeURIComponent(challenge ?? "").trim().toLowerCase()
  if (!key || !isChallengeSlug(slug)) notFound()

  const [profile, entryRead] = await Promise.all([
    getPublicProfile(key, "ssr"),
    getPublicChallengeCase(key, slug),
  ])
  if (!profile.ok && profile.status === 404) notFound()
  if (entryRead.ok && entryRead.entry === null) notFound()

  const data = profile.ok ? profile.data : null
  const entry = entryRead.ok ? entryRead.entry : null

  return (
    <TrophyCaseShareClient
      username={key}
      displayName={(data?.bio?.display_name ?? "").trim() || key}
      accentColor={data?.bio?.accent_color ?? null}
      trophies={entry?.slabs ?? []}
      readFailed={!entryRead.ok}
      challenge={{ slug, title: entry?.challenge.title ?? titleFromSlug(slug) }}
    />
  )
}
