// lib/topshot-username-resolve.ts
//
// Shared Top Shot username -> Flow wallet resolver.
//
// Dapper SSO enforces one username per wallet across NBA Top Shot, NFL All Day,
// LaLiga Golazos, and Disney Pinnacle, so a Top Shot resolution is authoritative
// for all four marketplaces.
//
// Resolution layers (in order):
//   1. wallet_usernames cache table (fastest, indexed by lower(username))
//   2. seeded_wallets / saved_wallets / user_profiles fallback layers in the
//      `resolve_topshot_username` RPC, which opportunistically populates the
//      wallet_usernames cache when those tables hit.
//   3. LIVE: Dapper's Atlas `ProfileService/SearchUserProfiles`, reached from
//      the DATABASE in two phases (`lib/chains/flow/atlas.ts`) — the only live
//      resolver since `public-api.nbatopshot.com` died ~2026-08-28.
//   4. Live Top Shot GraphQL (`getUserProfileByUsername`) — kept as the
//      fallback when Atlas fails a read; it is the DEAD host, so today it
//      answers 530 in ~0.3 s and only its error text reaches the caller.
//      Hits from either live layer get written back via `cache_topshot_username`.

import { topshotGraphql } from "@/lib/chains/flow/topshot";
import { atlasResolveUsername, type AtlasDb } from "@/lib/chains/flow/atlas";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResolvedUser = {
  walletAddress: string;
  username: string;
  dapperId: string | null;
  /** Which live layer answered. */
  source?: "atlas" | "topshot_gql";
};

type TopShotUserProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null;
      username?: string | null;
      dapperID?: string | null;
    } | null;
  } | null;
};

const QUERY = `
  query ResolveUserByUsername($username: String!) {
    getUserProfileByUsername(input: { username: $username }) {
      publicInfo {
        flowAddress
        username
        dapperID
      }
    }
  }
`;

export function isWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(value.trim());
}

// The DB handle the Atlas layer posts through. Lazily required so a test that
// mocks `@/lib/supabase` — or passes its own `atlas` — never touches the real
// module; `null` disables the Atlas layer (GQL only), which is the pre-09-06 ladder.
async function defaultAtlasDb(): Promise<AtlasDb | null> {
  try {
    const mod = await import("@/lib/supabase");
    return (mod.supabaseAdmin as unknown as AtlasDb) ?? null;
  } catch {
    return null;
  }
}

// Resolves a Dapper/Top Shot username to a Flow wallet address. Atlas first
// (Dapper's own profile search is case-insensitive, so one call covers the
// mixed-case and lowercase spellings); on an Atlas READ FAILURE only — never on
// a clean "no such user" — the legacy GQL ladder runs (cleaned, then lowercased).
// Returns null when not found; THROWS when every live layer failed to read, so
// a caller can tell "unknown username" from "could not look".
export async function resolveTopShotUsername(
  rawUsername: string,
  opts?: { atlas?: AtlasDb | null }
): Promise<ResolvedUser | null> {
  const cleaned = rawUsername.trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;

  const atlas = opts && "atlas" in opts ? opts.atlas ?? null : await defaultAtlasDb();
  let atlasError: string | null = null;
  if (atlas) {
    const a = await atlasResolveUsername(atlas, cleaned);
    if (a.ok) {
      if (!a.found || !a.flowAddress) return null;
      return { walletAddress: a.flowAddress, username: a.username ?? cleaned, dapperId: null, source: "atlas" };
    }
    atlasError = a.error;
  }

  let info: Awaited<ReturnType<typeof tryOnce>>;
  try {
    info = await tryOnce(cleaned);
  } catch (e) {
    if (atlasError) {
      throw new Error(`atlas: ${atlasError}; gql: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw e;
  }
  if (!info?.flowAddress && cleaned.toLowerCase() !== cleaned) {
    info = await tryOnce(cleaned.toLowerCase());
  }

  if (!info?.flowAddress) return null;

  const raw = info.flowAddress.toLowerCase();
  const walletAddress = raw.startsWith("0x") ? raw : `0x${raw}`;

  return {
    walletAddress,
    username: info.username ?? cleaned,
    dapperId: info.dapperID ?? null,
    source: "topshot_gql",
  };
}

async function tryOnce(username: string) {
  const data = await topshotGraphql<TopShotUserProfileResponse>(QUERY, {
    username,
  });
  return data.getUserProfileByUsername?.publicInfo ?? null;
}

export type ResolveOutcome =
  | {
      found: true;
      walletAddress: string;
      username: string;
      source: string;
      cacheLayer: "wallet_usernames" | "seeded_wallets" | "saved_wallets" | "user_profiles" | "topshot_gql_live" | "atlas_live";
      dapperId?: string | null;
    }
  | {
      found: false;
      reason:
        | "empty_username"
        | "not_in_any_cache"
        | "username_not_found_on_topshot"
        | "topshot_gql_error";
      detail?: string;
    };

// Cache-aware resolver. Used by /api/resolve-topshot-username and any
// internal route that needs username -> wallet without having to repeat the
// fallback ladder. `supabase` should be a service-role client because the
// RPCs are SECURITY DEFINER and the `cache_topshot_username` write uses the
// service role policy. Returns a discriminated union — callers should branch
// on `found`.
export async function resolveTopShotUsernameCacheAware(
  supabase: SupabaseClient,
  rawUsername: string
): Promise<ResolveOutcome> {
  const cleaned = rawUsername.trim().replace(/^@+/, "").trim();
  if (!cleaned) return { found: false, reason: "empty_username" };

  // Layer 1-4: cached lookup via the existing RPC.
  // deno-lint-ignore no-explicit-any
  const { data: cacheJson, error: cacheErr } = await (supabase as any).rpc(
    "resolve_topshot_username",
    { p_username: cleaned }
  );
  if (!cacheErr && cacheJson?.found === true && typeof cacheJson.wallet_address === "string") {
    return {
      found: true,
      walletAddress: cacheJson.wallet_address.startsWith("0x")
        ? cacheJson.wallet_address
        : `0x${cacheJson.wallet_address}`,
      username: cacheJson.username ?? cleaned,
      source: cacheJson.source ?? "wallet_usernames",
      cacheLayer: cacheJson.cache_layer ?? "wallet_usernames",
    };
  }

  // Layer 5: live — Atlas through THIS service-role client, then the GQL
  // fallback. resolveTopShotUsername already strips @ prefixes and tries
  // lowercased fallbacks.
  let live: ResolvedUser | null = null;
  try {
    live = await resolveTopShotUsername(cleaned, { atlas: supabase as unknown as AtlasDb });
  } catch (err) {
    return {
      found: false,
      reason: "topshot_gql_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!live) {
    return { found: false, reason: "username_not_found_on_topshot" };
  }

  // Write back to wallet_usernames so subsequent hits short-circuit at layer 1.
  // deno-lint-ignore no-explicit-any
  const liveSource = live.source ?? "topshot_gql";
  await (supabase as any).rpc("cache_topshot_username", {
    p_username: live.username ?? cleaned,
    p_wallet_address: live.walletAddress,
    p_source: liveSource,
  });

  return {
    found: true,
    walletAddress: live.walletAddress,
    username: live.username ?? cleaned,
    source: liveSource,
    cacheLayer: liveSource === "atlas" ? "atlas_live" : "topshot_gql_live",
    dapperId: live.dapperId,
  };
}

// ⚠ 2026-09-04 — THE DEAD-HOST CLASS, FOUND BY THE HEALTH CHECK'S CHROME SWEEP.
// `public-api.nbatopshot.com` has answered Cloudflare 530 to every caller since
// ~2026-08-28, and NINE routes carried their OWN copy of the live
// `getUserProfileByUsername` resolver with no cache in front of it
// (collection-moments, wallet-packs, wallet-sales-history, wallet-cost-basis,
// wallet-hold-time, analytics, allday-sets, allday-wallet-search,
// lib/chains/flow/flow-resolve). Every username search on the collection tab —
// the most-visited page — was a 500 in 0.27 s while the same wallet by ADDRESS
// worked, and the public profile's "ANALYZE <name>'S WALLET →" link sends the
// USERNAME. `/api/wallet-search` never broke because it goes through the
// layered resolver above (wallet_usernames → seeded_wallets → saved_wallets →
// user_profiles → live). This helper is the DB half of that ladder, so a
// copy-holder can put the cache in FRONT of its live call with one line and
// keep its own error copy and fallback exactly as they were.
//
// Returns the 0x-prefixed wallet, or null when no cached layer knows the
// username (including on any RPC error — a failed cache read must not become
// a "not found"; the caller's live path still runs).
export async function lookupCachedTopShotUsername(
  supabase: SupabaseClient,
  rawUsername: string
): Promise<string | null> {
  const cleaned = rawUsername.trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;
  try {
    // deno-lint-ignore no-explicit-any
    const res = await (supabase as any).rpc("resolve_topshot_username", { p_username: cleaned });
    const j = res?.data;
    if (res?.error || !j || j.found !== true || typeof j.wallet_address !== "string") return null;
    return j.wallet_address.startsWith("0x") ? j.wallet_address : `0x${j.wallet_address}`;
  } catch {
    return null;
  }
}
