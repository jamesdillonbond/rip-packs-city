// lib/topshot-username-resolve.ts
//
// Shared Top Shot username -> Flow wallet resolver.
//
// Dapper SSO enforces one username per wallet across NBA Top Shot, NFL All Day,
// LaLiga Golazos, and Disney Pinnacle, so a Top Shot resolution is authoritative
// for all four marketplaces.

import { topshotGraphql } from "@/lib/topshot";

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

  return {
    walletAddress: info.flowAddress.toLowerCase(),
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
