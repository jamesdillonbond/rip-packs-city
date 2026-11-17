// cached_listings_v2.source for an NFL All Day ListingAvailable event, keyed on the
// storefront contract that emitted it. ONE mapping for every All Day writer — the
// live indexer, the retry drainer and the admin force-retry.
//
// ⛔ 2026-10-19: the two retry paths hardcoded source "direct" (the Flowty fork) for
// every listing they resolved. Verified on chain (40/40 sampled transactions): those
// rows were Dapper V1 (NFTStorefront) and Dapper V2 (NFTStorefrontV2) listings. The
// fork's createListing asserts false, so no fork listing has existed since
// 2026-05-14. The mislabel had three effects:
//   - ListingCompleted is applied per source (direct_v1 / direct_v2), so a sale or
//     cancel never closed the mislabelled row and it stayed "open" for good;
//   - the storefront reconciler only touches V2 sources, so it inserted a second,
//     storefront_v2 copy of every live one (5,715 duplicates);
//   - the 2026-09-25 "Flowty fork is unpurchasable" closure took 21,060 of these
//     buyable Dapper listings down with the real fork rows.
// A payload with no storefrontVersion returns null: the caller must not guess.

export type StorefrontVersion = "v1" | "v2_dapper" | "v2_flowty"
export type AllDayListingSource = "direct_v1" | "direct_v2" | "direct"

export function allDayListingSource(v: StorefrontVersion | string | null | undefined): AllDayListingSource | null {
  if (v === "v1") return "direct_v1"
  if (v === "v2_dapper") return "direct_v2"
  if (v === "v2_flowty") return "direct"
  return null
}
