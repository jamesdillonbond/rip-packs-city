// lib/panini/edition-url.ts
//
// Pure (client-safe) Panini marketplace URL builder. Kept out of
// lib/panini/edition-market.ts, which imports `@/lib/supabase` — and that
// module constructs the SERVICE-ROLE client at load time. In a browser the key
// is undefined, supabase-js throws "supabaseKey is required." during module
// evaluation, and the whole page falls to the global error boundary.
//
// That is exactly what happened 2026-09-28: TrophySlab (client) imported
// lib/trophy/slab-href.ts, which imported paniniEditionUrl from edition-market,
// and every signed-in visit to / → /dashboard rendered "Something went wrong".
// Pinned by __tests__/client-modules-never-reach-lib-supabase.test.ts.

/** The public Panini marketplace page for an edition (same shape the Market tab links). */
export function paniniEditionUrl(externalId: string | null | undefined): string | null {
  if (!externalId || !/^packcard-[0-9_]+$/.test(externalId)) return null
  return `https://nft.paniniamerica.net/marketplace-details/${encodeURIComponent(externalId)}.html`
}
