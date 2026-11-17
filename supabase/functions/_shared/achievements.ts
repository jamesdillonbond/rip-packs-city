// Pure decision logic for supabase/functions/compute-achievements (2026-10-17).
//
// Lives here so vitest can reach it (__tests__/edge-compute-achievements.test.ts);
// the edge function imports it. Nothing in this file touches the network.
//
// The rule the edge function is built around: an achievement row is written or
// deleted ONLY from a read that succeeded. Before 2026-10-17 every count was
// `count ?? 0` with its error unread, so a failed read became a zero and a zero
// became `deleteAchievement` — a failed read was a DELETE of a collector's badge.

export type Tier = "bronze" | "silver" | "gold" | "platinum";
export type Threshold = { tier: Tier; min: number };

export const PACK_HUNTER: Threshold[] = [
  { tier: "bronze", min: 10 },
  { tier: "silver", min: 50 },
  { tier: "gold", min: 200 },
  { tier: "platinum", min: 500 },
];
export const TROPHY_CURATOR: Threshold[] = [
  { tier: "bronze", min: 1 },
  { tier: "silver", min: 3 },
  { tier: "gold", min: 6 },
];
export const SERIES_COLLECTOR: Threshold[] = [
  { tier: "bronze", min: 3 },
  { tier: "silver", min: 5 },
  { tier: "gold", min: 7 },
];
export const BIG_SPENDER: Threshold[] = [
  { tier: "bronze", min: 100 },
  { tier: "silver", min: 1000 },
  { tier: "gold", min: 10000 },
];

/** The highest tier whose minimum `value` meets, or null. Thresholds ascend. */
export function highestTier(thresholds: Threshold[], value: number): Tier | null {
  let best: Tier | null = null;
  for (const t of thresholds) if (value >= t.min) best = t.tier;
  return best;
}

/** serial_sniper: gold = 3+ serials <= 10, silver = 1+ <= 10, bronze = 1+ <= 100. */
export function serialSniperTier(serial10: number, serial100: number): Tier | null {
  if (serial10 >= 3) return "gold";
  if (serial10 >= 1) return "silver";
  if (serial100 >= 1) return "bronze";
  return null;
}

/** A single-tier achievement (diamond_hands, challenge_accepted): gold at 1+. */
export function anyTier(count: number): Tier | null {
  return count >= 1 ? "gold" : null;
}

/**
 * `profile_achievements.owner_key` is POLYMORPHIC (lib/auth/owner-key-guard.ts):
 * an auth user UUID, a 0x Flow address, or a username (the canonical one —
 * app/api/public/profile/[username]). The wallets behind it resolve differently.
 */
export type OwnerKeyKind = "user_id" | "flow_address" | "username";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW = /^0x[0-9a-f]{16}$/i;
export function classifyOwnerKey(key: string): OwnerKeyKind {
  const k = key.trim();
  if (UUID.test(k)) return "user_id";
  if (FLOW.test(k)) return "flow_address";
  return "username";
}

/**
 * A saved wallet as the holdings tables key it: a Flow/EVM hex address folded to
 * lower case (wallet_moments_cache / moment_acquisitions store it that way), a
 * Solana base58 key verbatim (case-sensitive — folding destroys it), and anything
 * else (a legacy Top Shot USERNAME stored in wallet_addr) is UNRESOLVABLE here:
 * its resolver, public-api.nbatopshot.com, is dead. Null means "cannot say", and
 * the caller must then not conclude anything from an empty holding.
 */
export function holdingsWalletKey(walletAddr: string): string | null {
  const w = walletAddr.trim();
  if (/^0x[0-9a-fA-F]{16}$/.test(w) || /^0x[0-9a-fA-F]{40}$/.test(w)) return w.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return w;
  return null;
}

/**
 * What to do with an achievement given the outcome of its read. A failed read
 * is SKIP — never DELETE: the row stays as it was until a read succeeds.
 */
export type Action = { kind: "upsert"; tier: Tier } | { kind: "delete" } | { kind: "skip"; reason: string };
export function decide(read: { ok: true; tier: Tier | null } | { ok: false; error: string }): Action {
  if (!read.ok) return { kind: "skip", reason: read.error };
  return read.tier ? { kind: "upsert", tier: read.tier } : { kind: "delete" };
}
