import { topshotGraphql } from "@/lib/topshot";

const resolveCache = new Map<string, { addr: string; expiresAt: number }>();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

function isWalletAddress(v: string) {
  return /^0x[a-fA-F0-9]{16}$/.test(v.trim());
}

function ensureFlowPrefix(v: string) {
  return v.startsWith("0x") ? v : "0x" + v;
}

type TopShotUserProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: { flowAddress?: string | null; username?: string | null } | null;
  } | null;
};

export async function resolveToFlowAddress(input: string): Promise<string> {
  const trimmed = input.trim();
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed);
  const cacheKey = trimmed.toLowerCase();
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.addr;

  const cleanedUsername = trimmed.replace(/^@+/, "").trim();
  const query = `
    query ResolveUserByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress username }
      }
    }
  `;
  const tryResolve = async (username: string): Promise<string | null> => {
    try {
      const data = await topshotGraphql<TopShotUserProfileResponse>(query, { username });
      const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null;
      return raw ? ensureFlowPrefix(raw) : null;
    } catch { return null; }
  };

  let addr = await tryResolve(cleanedUsername);
  if (!addr && cleanedUsername.toLowerCase() !== cleanedUsername) {
    addr = await tryResolve(cleanedUsername.toLowerCase());
  }
  if (!addr) throw new Error('Could not resolve "' + trimmed + '" to a Flow address. Check the username and try again.');
  resolveCache.set(cacheKey, { addr, expiresAt: Date.now() + RESOLVE_TTL_MS });
  return addr;
}
