// Server shell for /profile/<username>.
//
// Fetches the public profile aggregate server-side (the SAME anon endpoint the
// client uses, so there's zero shape divergence) and seeds initialBio +
// initialWallets into ProfileClient. This makes the Portfolio FMV hero + moment
// count render in the SSR HTML — previously the page was a pure client
// component, so anon visitors, crawlers, and link/pre-hydration previews saw
// "PORTFOLIO FMV —" / "0 moments" until the client fetch completed (the
// 2026-06-12 audit's broken-looking-founder-profile finding). Mirrors the
// proven /share/[wallet] server-fetch pattern. (2026-06-13)

import ProfileClient from "./ProfileClient"

export const dynamic = "force-dynamic"

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  )
}

async function fetchProfile(username: string): Promise<any | null> {
  try {
    // no-store: cached_fmv/moment counts move; the client re-confirms on mount.
    const res = await fetch(
      `${siteUrl()}/api/public/profile/${encodeURIComponent(username)}`,
      { cache: "no-store" }
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export default async function PublicProfilePage(props: {
  params: Promise<{ username: string }>
}) {
  const { username } = await props.params
  const data = await fetchProfile(username)
  return (
    <ProfileClient
      initialBio={data?.bio ?? null}
      initialWallets={Array.isArray(data?.wallets) ? data.wallets : []}
    />
  )
}
