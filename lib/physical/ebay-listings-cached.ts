/**
 * Cached entry point for the "Paper cards on eBay" section (prototype, NOT
 * mounted). Split from ebay-listings-server.ts so the pure loader stays
 * testable without Next's cache runtime.
 */
import { unstable_cache } from "next/cache"
import { bumpAnonRates } from "@/lib/abuse/anon-rate"
import { browseDailyCap, fetchPaperListings, listingsEnabled, LISTINGS_REVALIDATE_SECONDS, type PaperListingsResult } from "./ebay-listings-server"

const loadOnMiss = unstable_cache(
  async (name: string, slug: string): Promise<PaperListingsResult> => {
    const r = await fetchPaperListings(name, {
      slug,
      // Runs only on a cache miss, so the counter counts real eBay calls.
      allowCall: async () =>
        (await bumpAnonRates([{ bucket: "ebay_browse_global", key: "*", limit: browseDailyCap(), windowSecs: 86_400 }])).allowed,
    })
    // Never cache a failure or a refusal: throw, and the caller renders nothing.
    if (r.status !== "ok") throw new Error(`paper listings unavailable (${r.status})`)
    return r
  },
  ["physical-paper-listings-v1"],
  { revalidate: LISTINGS_REVALIDATE_SECONDS, tags: ["physical-paper-listings"] },
)

export async function getPaperListings(name: string, slug: string): Promise<PaperListingsResult> {
  // Checked OUTSIDE the cache, so flipping the switch takes effect at once.
  if (!listingsEnabled()) return { status: "off" }
  try {
    return await loadOnMiss(name, slug)
  } catch {
    return { status: "error" }
  }
}
