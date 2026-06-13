import type { Metadata, ResolvingMetadata } from "next"

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  )
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K"
  return "$" + Math.round(n).toLocaleString()
}

export async function generateMetadata(
  { params }: { params: Promise<{ username: string }> },
  _parent: ResolvingMetadata
): Promise<Metadata> {
  const { username } = await params
  const key = decodeURIComponent(username ?? "")

  let displayName = key || "Collector"
  let totalFmv = 0
  let momentCount = 0

  if (key) {
    try {
      // Read the canonical public endpoint (username -> user_id resolution +
      // cached_fmv_usd) — the SAME source the page uses. The previous direct
      // query keyed on owner_key / cached_fmv, neither of which matches the
      // saved_wallets schema, so EVERY profile unfurl read "$0 FMV across 0
      // moments". (fix 2026-06-13)
      const res = await fetch(
        `${siteUrl()}/api/public/profile/${encodeURIComponent(key)}`,
        { cache: "no-store" }
      )
      if (res.ok) {
        const data = await res.json()
        if (data?.bio?.display_name) displayName = data.bio.display_name
        const ws: any[] = Array.isArray(data?.wallets) ? data.wallets : []
        for (const w of ws) {
          totalFmv += Number(w?.cached_fmv ?? 0) || 0
          momentCount += Number(w?.cached_moment_count ?? 0) || 0
        }
      }
    } catch {
      // fall through with defaults
    }
  }

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
  const ogUrl = SITE_URL + "/api/og/profile/" + encodeURIComponent(key)
  const description =
    "Portfolio: " + fmtDollars(totalFmv) + " FMV across " + momentCount + " moments"
  const title = displayName + "'s Collection | Rip Packs City"

  return {
    // `absolute` skips the site-wide "%s | Rip Packs City" title.template
    // (lib/seo.ts) so the suffix isn't appended twice. og/twitter titles below
    // don't run through the template, so they keep the full string. Mirrors the
    // 2026-06-07 pin-page fix.
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogUrl],
    },
  }
}

export default function PublicProfileLayout({ children }: { children: React.ReactNode }) {
  return children
}
