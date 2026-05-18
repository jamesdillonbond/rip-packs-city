// lib/marketplace-status.ts
//
// Server-side helper backing the per-collection marketplace-status surface.
// Reads from the `v_collection_marketplace_status` view (one row per
// collection) and caches with Next.js `unstable_cache` for 5 minutes so we
// don't slam the DB on every render — the view content changes maybe weekly.
//
// The frontend uses hyphen slugs ("nba-top-shot", "ufc"); the DB view uses
// underscore slugs ("nba_top_shot", "ufc_strike"). This helper accepts either
// and normalises internally via `SLUG_TO_DB_SLUG`.

import { unstable_cache } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase"
import { SLUG_TO_DB_SLUG } from "@/lib/collections"

export type MarketplaceStatusValue =
  | "healthy"
  | "degraded"
  | "dormant"
  | "shutdown"
  | "unknown"

export interface MarketplaceStatus {
  collectionId: string
  slug: string
  status: MarketplaceStatusValue
  buyCtasEnabled: boolean
  primaryVenue: string | null
  primaryContract: string | null
  secondaryVenue: string | null
  secondaryStatus: string | null
  packSecondaryVenue: string | null
  lastVerifiedAt: string | null
  notes: string | null
}

const UNKNOWN_FALLBACK: MarketplaceStatus = {
  collectionId: "",
  slug: "",
  status: "unknown",
  buyCtasEnabled: false,
  primaryVenue: null,
  primaryContract: null,
  secondaryVenue: null,
  secondaryStatus: null,
  packSecondaryVenue: null,
  lastVerifiedAt: null,
  notes: null,
}

/** Map a frontend hyphen-slug ("nba-top-shot", "ufc") to its DB slug. */
function normaliseSlug(input: string): string {
  if (!input) return ""
  if (SLUG_TO_DB_SLUG[input]) return SLUG_TO_DB_SLUG[input]
  // If caller already passed an underscore-slug, accept it as-is.
  return input.replace(/-/g, "_")
}

async function readMarketplaceStatus(dbSlug: string): Promise<MarketplaceStatus> {
  if (!dbSlug) return { ...UNKNOWN_FALLBACK }

  const { data, error } = await (supabaseAdmin as any)
    .from("v_collection_marketplace_status")
    .select(
      "collection_id, slug, status, buy_ctas_enabled, primary_venue, primary_contract, secondary_venue, secondary_status, pack_secondary_venue, last_verified_at, notes"
    )
    .eq("slug", dbSlug)
    .maybeSingle()

  if (error || !data) {
    return { ...UNKNOWN_FALLBACK, slug: dbSlug }
  }

  return {
    collectionId: data.collection_id ?? "",
    slug: data.slug ?? dbSlug,
    status: (data.status as MarketplaceStatusValue) ?? "unknown",
    buyCtasEnabled: !!data.buy_ctas_enabled,
    primaryVenue: data.primary_venue ?? null,
    primaryContract: data.primary_contract ?? null,
    secondaryVenue: data.secondary_venue ?? null,
    secondaryStatus: data.secondary_status ?? null,
    packSecondaryVenue: data.pack_secondary_venue ?? null,
    lastVerifiedAt: data.last_verified_at ?? null,
    notes: data.notes ?? null,
  }
}

// Cached per-slug. 5 minute revalidate window. Tagged so we can bust manually
// if we ever want to ship a `/api/admin/refresh-marketplace-status` endpoint.
const cachedReadMarketplaceStatus = unstable_cache(
  async (dbSlug: string) => readMarketplaceStatus(dbSlug),
  ["marketplace-status-v1"],
  { revalidate: 300, tags: ["marketplace-status"] }
)

/**
 * Read marketplace status for one collection.
 *
 * Accepts either the frontend hyphen-slug ("nba-top-shot", "ufc") or the DB
 * underscore-slug ("nba_top_shot", "ufc_strike"). Returns a permissive
 * `unknown` fallback when the view row is missing or the read fails so
 * callers never have to null-check.
 */
export async function getMarketplaceStatus(
  collectionSlug: string
): Promise<MarketplaceStatus> {
  const dbSlug = normaliseSlug(collectionSlug)
  if (!dbSlug) return { ...UNKNOWN_FALLBACK }
  return cachedReadMarketplaceStatus(dbSlug)
}
