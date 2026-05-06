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
//   3. Live Top Shot GraphQL (`getUserProfileByUsername`) via topshot-proxy.
//      Hits get written back via `cache_topshot_username`.

import { topshotGraphql } from "@/lib/topshot";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResolvedUser = {
  walletAddress: string;
  username: string;
  dapperId: string | null;
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

// Resolves a Dapper/Top Shot username to a Flow wallet address. Tries the
// cleaned username first, then a lowercased fallback. Returns null if not
// found.
export async function resolveTopShotUsername(
  rawUsername: string
): Promise<ResolvedUser | null> {
  const cleaned = rawUsername.trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;

  let info = await tryOnce(cleaned);
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
      cacheLayer: "wallet_usernames" | "seeded_wallets" | "saved_wallets" | "user_profiles" | "topshot_gql_live";
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

  // Layer 5: live Top Shot GQL fallback. resolveTopShotUsername already
  // strips @ prefixes and tries lowercased fallbacks.
  let live: ResolvedUser | null = null;
  try {
    live = await resolveTopShotUsername(cleaned);
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
  await (supabase as any).rpc("cache_topshot_username", {
    p_username: live.username ?? cleaned,
    p_wallet_address: live.walletAddress,
    p_source: "topshot_gql",
  });

  return {
    found: true,
    walletAddress: live.walletAddress,
    username: live.username ?? cleaned,
    source: "topshot_gql",
    cacheLayer: "topshot_gql_live",
    dapperId: live.dapperId,
  };
}
