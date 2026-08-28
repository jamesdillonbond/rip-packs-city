import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import HomePageMarketing from "@/components/HomePageMarketing"
import { OG_INHERITED, ROOT_OG_CONTENT } from "@/lib/seo"

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
 * ⚠ `openGraph` and `twitter` merge SHALLOWLY, so redefining either here REPLACES
 * the root object and silently drops `siteName`, `type`, `locale` and `creator`.
 *
 * ── `og:url`, 2026-08-28 ────────────────────────────────────────────────────
 * The 08-23 pass closed the canonical half and deliberately left `og:url` open,
 * on the stated cost that "adding `og:url` means restating the whole root
 * `openGraph` block, which is not worth it for one tag". That cost was real when
 * written and is now obsolete, which is exactly the kind of recorded
 * decision-not-to-act nobody re-checks: `OG_INHERITED` was exported on 08-17 and
 * `ROOT_OG_CONTENT` now carries the title/description/images half, so home
 * restates NOTHING — it spreads both. A field added at the root reaches this
 * block for free, so the two can no longer drift.
 *
 * ⚠ STILL SCOPED HERE, NOT ON `rootMetadata` — for `openGraph.url` the original
 * argument binds harder than it does for `canonical`: a root-level `og:url`
 * would be inherited by every descendant that sets no `openGraph` block of its
 * own, unfurling a pile of deep pages as the homepage.
 *
 * ⚠ `...OG_INHERITED` is load-bearing to a GUARD, not only to the tags:
 * __tests__/metadata-inline-blocks-inherit-root-fields.test.ts walks app/** and
 * lib/** and requires every inline `openGraph` literal to spread that const or
 * restate its fields. Spreading `ROOT_OG_CONTENT` alone would read as correct
 * and red CI.
 */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { ...OG_INHERITED, ...ROOT_OG_CONTENT, url: "/" },
}

export default async function HomePage() {
  const user = await getCurrentUser()
  if (user) redirect("/dashboard")
  return <HomePageMarketing />
}
