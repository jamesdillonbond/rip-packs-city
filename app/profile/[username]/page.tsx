// Server shell for /profile/<username>.
//
// Fetches the public profile aggregate server-side and seeds initialBio +
// initialWallets into ProfileClient. This makes the Portfolio FMV hero + moment
// count render in the SSR HTML — previously the page was a pure client
// component, so anon visitors, crawlers, and link/pre-hydration previews saw
// "PORTFOLIO FMV —" / "0 moments" until the client fetch completed (the
// 2026-06-12 audit's broken-looking-founder-profile finding). (2026-06-13)
//
// 2026-08-07: this used to reach its data by making a SERVER-SIDE HTTP round
// trip back to /api/public/profile/<username> with `cache: "no-store"`, on a
// `force-dynamic` page — so every request cost TWO lambda invocations plus
// uncached DB work, on the heaviest uncached public route (14,652 hits/12h
// during the 2026-08-06 crawl; most of the traffic on the API route was this
// page calling itself). It also meant the page could 500 purely because its own
// API had been rate limited. It now calls the shared data layer directly.
//
// The self-fetch's REASON was real — one payload shape for page and client,
// zero divergence — and is preserved by lib/profile/public-profile.ts, which
// BOTH this page and the API route call. Do not re-introduce the HTTP hop, and
// do not duplicate the query here.
//
// ISR instead of force-dynamic: the values that move (cached_fmv / moment
// counts) are re-confirmed by the client on mount, so the SSR pass only needs
// to be good enough for crawlers and link unfurls. A 300s window serves those
// identically while collapsing repeat-crawl cost. `dynamicParams` stays on so
// an unknown username still renders on demand.

import ProfileClient from "./ProfileClient"
import { getPublicProfile } from "@/lib/profile/public-profile"

export const revalidate = 300
export const dynamicParams = true

export default async function PublicProfilePage(props: {
  params: Promise<{ username: string }>
}) {
  const { username } = await props.params
  const result = await getPublicProfile(username, "ssr")
  const data = result.ok ? result.data : null

  return (
    <ProfileClient
      initialBio={data?.bio ?? null}
      initialWallets={Array.isArray(data?.wallets) ? data.wallets : []}
    />
  )
}
