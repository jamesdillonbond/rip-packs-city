import type { Metadata, ResolvingMetadata } from "next"
import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""

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

  if (SUPABASE_URL && SERVICE_KEY && key) {
    try {
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const [bioRes, walletsRes] = await Promise.all([
        supabase
          .from("profile_bio")
          .select("display_name")
          .eq("owner_key", key)
          .maybeSingle(),
        supabase
          .from("saved_wallets")
          .select("cached_fmv, cached_moment_count")
          .eq("owner_key", key),
      ])
      if (bioRes.data?.display_name) displayName = bioRes.data.display_name
      for (const w of walletsRes.data ?? []) {
        totalFmv += Number((w as any).cached_fmv ?? 0) || 0
        momentCount += Number((w as any).cached_moment_count ?? 0) || 0
      }
    } catch {
      // fall through with defaults
    }
  }

  const ogUrl = "https://rip-packs-city.vercel.app/api/og/profile/" + encodeURIComponent(key)
  const description =
    "Portfolio: " + fmtDollars(totalFmv) + " FMV across " + momentCount + " moments"
  const title = displayName + "'s Collection | Rip Packs City"

  return {
    title,
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
