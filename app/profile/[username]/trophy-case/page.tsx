// Server shell for /profile/<username>/trophy-case — the shareable case.
//
// A deliberately narrow page: the six Moments, who they belong to, and a way
// back to the full profile. Everything the profile page carries that is ABOUT
// the collection rather than about these Moments — portfolio FMV, saved
// wallets, cost basis, breakdowns — is absent on purpose. This is the page you
// paste into a Discord when you want someone to look at your case.
//
// It reads through the same shared data layer as the profile shell (no HTTP
// self-fetch — see lib/profile/public-profile), and `getPublicProfile` is
// request-memoized so the layout's generateMetadata call and this one share a
// single read.

import Link from "next/link"
import { notFound } from "next/navigation"
import { getPublicProfile } from "@/lib/profile/public-profile"
import TrophyCaseShareClient from "./TrophyCaseShareClient"

export const revalidate = 300
export const dynamicParams = true

export default async function TrophyCasePage(props: {
  params: Promise<{ username: string }>
}) {
  const { username } = await props.params
  const key = decodeURIComponent(username ?? "").trim()
  const result = await getPublicProfile(key, "ssr")

  // ⚠ Only an ANSWERED read may 404. A failed one renders the shell with an
  // honest notice instead — this URL is meant to be pasted into chats, so a
  // transient DB blip must not tell someone the case they just shared does not
  // exist (and must not hand a crawler a hard 404 for a real page).
  if (!result.ok && result.status === 404) notFound()

  const data = result.ok ? result.data : null
  const trophies = (data?.trophies ?? []) as Array<Record<string, unknown>>

  return (
    <TrophyCaseShareClient
      username={key}
      displayName={(data?.bio?.display_name ?? "").trim() || key}
      accentColor={data?.bio?.accent_color ?? null}
      trophies={trophies}
      readFailed={!result.ok}
    />
  )
}
