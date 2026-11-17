// lib/verify-wallet-gql.ts
//
// Shared live listing-state helper for the wallet-verification listing
// challenge. Both the mint route (picks a target, confirms it's not already
// listed) and the check route (confirms the target is now listed BY THAT WALLET
// at the challenge amount) read a single Moment's live listing state here.
//
// 2026-09-06 — REWIRED FROM THE DEAD HOST TO ATLAS. `public-api.nbatopshot.com`
// (the GQL this file was named for, via topshot-proxy) has answered Cloudflare
// 530 to every caller since ~2026-08-28, which left verification-by-listing
// with no data source at all (known-issues #59). Dapper's own Atlas backend
// answers `MarketplaceService/SearchMarketplaceTransactions {nftId}` — the
// Moment's listing + sale history, seller and price included — from the
// database's pg_net egress, so the read now goes through
// `lib/chains/flow/atlas.ts` (two RPCs; see that file for why two). The file
// keeps its name so the two routes and their tests keep their imports.
//
// What changed in the SHAPE: Atlas returns the listing book, not the Moment
// record, so `found` no longer means "the Moment exists" (the mint route's
// on-chain getIDs gate is the ownership authority) — it means the READ
// SUCCEEDED. `isLocked` is not observable here (locked Moments cannot be
// listed; wmc's `is_locked` filter in the picker is the authority) and is
// always false. New: `matchedForWallet` — when `wallet` is given, whether THAT
// wallet holds an open listing (at `priceCents`, when given). The check route
// keys on it, which is STRICTER than the old "someone listed it at that price".
//
// Throws on a failed read so callers surface "couldn't check", never a verdict.

import { atlasVerifyListing, type AtlasDb } from "@/lib/chains/flow/atlas";

export type MomentListingState = {
  momentId: string;
  /** The live read succeeded (NOT "the Moment exists" — see header). */
  found: boolean;
  /** Any seller has an open listing on this Moment. */
  forSale: boolean;
  /** Price (USD) of the matched/open listing, when one is known. */
  price: number | null;
  /** Always false: lock state is not observable on the listing book. */
  isLocked: boolean;
  /** `wallet` holds an open listing (at `priceCents`, when given). Null when no wallet was asked about. */
  matchedForWallet: boolean | null;
  openListings: number;
};

export type ListingStateOptions = {
  /** Restrict the match to this seller (0x-prefixed or not). */
  wallet?: string | null;
  /** Restrict the match to this exact price, in cents. */
  priceCents?: number | null;
  /** DB handle for the Atlas two-phase RPCs; defaults to the service-role client. */
  db?: AtlasDb;
};

async function defaultDb(): Promise<AtlasDb> {
  const mod = await import("@/lib/supabase");
  return mod.supabaseAdmin as unknown as AtlasDb;
}

// Per-moment live listing state. Throws on transport/read error so callers can
// surface a clean "try again" hint — a failed read must not render as a verdict.
export async function fetchMomentListingState(momentId: string, opts: ListingStateOptions = {}): Promise<MomentListingState> {
  const db = opts.db ?? (await defaultDb());
  const wallet = opts.wallet ?? null;
  const priceCents = opts.priceCents ?? null;
  const r = await atlasVerifyListing(db, momentId, wallet, priceCents);
  if (!r.ok) {
    throw new Error(`Atlas listing read failed${r.status != null ? ` (HTTP ${r.status})` : ""}: ${r.error}`);
  }
  return {
    momentId,
    found: true,
    forSale: r.openListings > 0,
    price: r.priceCents != null ? r.priceCents / 100 : null,
    isLocked: false,
    matchedForWallet: wallet ? r.matched : null,
    openListings: r.openListings,
  };
}

// Exact-match in cents to avoid float drift.
export function priceMatchesCents(price: number | null, amount: number): boolean {
  if (price === null || !Number.isFinite(price)) return false;
  return Math.round(price * 100) === Math.round(amount * 100);
}

// Native Top Shot moment page (the owner lists from here). Confirmed format:
// https://nbatopshot.com/moment/<momentId> (see collection/page.tsx).
export function topShotMomentUrl(momentId: string): string {
  return `https://nbatopshot.com/moment/${encodeURIComponent(momentId)}`;
}
