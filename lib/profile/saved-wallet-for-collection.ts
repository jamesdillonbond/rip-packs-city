// lib/profile/saved-wallet-for-collection.ts
// Client-side helper: resolves the signed-in user's saved wallet address for a
// given collection (by Next.js slug like "nba-top-shot"). Returns null when
// unauthenticated (known from /api/profile/me, without calling the gated route), when the user has no saved wallet for that collection, or
// when the collection slug doesn't have a Supabase UUID mapped.

import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import { ownLookup } from "@/lib/safe-lookup";

export async function fetchSavedWalletForCollection(
  collectionSlug: string
): Promise<string | null> {
  const uuid = ownLookup(COLLECTION_UUID_BY_SLUG, collectionSlug);
  if (!uuid) return null;
  try {
    // 2026-10-14: ask who is signed in FIRST. /api/profile/saved-wallets is
    // session-gated and 401s for an anonymous reader, so every anonymous visit
    // to the Sets / Collection tabs logged a red "Failed to load resource: 401"
    // in the console (mobile sweep, 10-14) for a question whose answer was
    // already "no". /api/profile/me never 401s ({ user: null } when signed
    // out). A FAILED identity read is unknown, not signed-out, so it falls
    // through to the saved-wallets call as before rather than hiding a
    // signed-in reader's wallet.
    const me = await fetch("/api/profile/me", { cache: "no-store", credentials: "include" }).catch(() => null);
    if (me?.ok) {
      const body = await me.json().catch(() => null);
      if (body && typeof body === "object" && "user" in body && body.user == null) return null;
    }
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
