import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import HomePageMarketing from "@/components/HomePageMarketing"

/**
 * The home page was the ONLY surface emitting no `<link rel="canonical">`
 * (verified on the served HTML 2026-08-23: `canonical` and `og:url` both absent,
 * while `/insights`, `/insights/pack-sniper`, an edition page, a Pinnacle pin
 * page and a pack-dist page all carry one). `rootMetadata` sets metadataBase,
 * title, openGraph and twitter but no `alternates`, and `app/page.tsx` exported
 * no metadata of its own, so home inherited the gap.
 *
 * ⚠ SCOPED HERE, NOT ON `rootMetadata`. Next resolves metadata by INHERITANCE, so
 * a root-level canonical would be inherited by every descendant that does not set
 * its own — pointing a pile of pages at the homepage, which is strictly worse
 * than the gap it fixes.
 *
 * ⚠ `alternates` ONLY. `openGraph` and `twitter` merge SHALLOWLY, so redefining
 * either here would REPLACE the root object and silently drop `siteName`, `type`,
 * `locale` and `creator`. Adding `og:url` means restating the whole root
 * `openGraph` block, which is not worth it for one tag.
 */
export const metadata: Metadata = { alternates: { canonical: "/" } }

export default async function HomePage() {
  const user = await getCurrentUser()
  if (user) redirect("/dashboard")
  return <HomePageMarketing />
}
