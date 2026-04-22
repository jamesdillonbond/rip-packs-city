// lib/profile/saved-wallet-for-collection.ts
// Client-side helper: resolves the signed-in user's saved wallet address for a
// given collection (by Next.js slug like "nba-top-shot"). Returns null when
// unauthenticated, when the user has no saved wallet for that collection, or
// when the collection slug doesn't have a Supabase UUID mapped.

import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

export async function fetchSavedWalletForCollection(
  collectionSlug: string
): Promise<string | null> {
  const uuid = COLLECTION_UUID_BY_SLUG[collectionSlug];
  if (!uuid) return null;
  try {
    const res = await fetch(
      "/api/profile/saved-wallets?collectionId=" + encodeURIComponent(uuid),
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const wallets: Array<{ wallet_addr?: string }> | undefined = json?.wallets;
    const addr = wallets?.[0]?.wallet_addr;
    return typeof addr === "string" && addr.trim() ? addr.trim() : null;
  } catch {
    return null;
  }
}
