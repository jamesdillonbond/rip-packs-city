// lib/rewards.ts
//
// Server-only helper around the off-chain points economy. Points are ONLY ever
// moved by calling the SECURITY DEFINER DB functions (award_points /
// redeem_shop_item / admin_adjust_points) through the service-role client.
// There is no "add N points" path: earning is always a server-side side effect
// of a server-verified action, and the caller's user id must come from the
// authenticated session — never from request input.
//
// NEVER import this file into a "use client" component: it references the
// service-role Supabase client (SUPABASE_SERVICE_ROLE_KEY).

import { supabaseAdmin as supabase } from "@/lib/supabase";

// ⛔ KILL SWITCH — the points programme is NOT live (Trevor, 2026-10-04: "We
// shouldn't have this as a live feature yet"). Every earn hook kept firing
// award_points for four months while the UI was hidden, so 23 collectors
// banked ~13k credits for a programme that did not exist. The DB side was
// switched off the same day (every points_rules / shop_items row tagged
// "[paused 2026-10-04]" / metadata.paused_2026_10_04 and set inactive), and
// this gate keeps the code side off even if a rule is re-activated in the DB.
// To launch: set REWARDS_LIVE=true in Vercel AND re-activate the DB rows.
// Read per call (not at module load) so it can be flipped without a rebuild
// of any importer and so tests can toggle it.
export function rewardsLive(): boolean {
  return process.env.REWARDS_LIVE === "true";
}

// Award points for a named, server-verified action. The DB function enforces
// cooldown / daily_cap / per_user_limit, so repeat calls are harmless no-ops.
// Returns the jsonb result ({ awarded, points, status, spendable, tier, ... } or
// { awarded:false, skipped }) or null on error / missing user.
export async function awardPoints(userId: string, actionKey: string, ref?: string) {
  if (!userId) return null;
  if (!rewardsLive()) return { awarded: false, skipped: "rewards_not_live" };
  const { data, error } = await (supabase as any).rpc("award_points", {
    p_user_id: userId,
    p_action_key: actionKey,
    p_ref: ref ?? null,
  });
  if (error) {
    console.log("[rewards] award_points err", actionKey, error.message);
    return null;
  }
  return data;
}

// Redeem a shop item. The DB function re-validates balance / stock / per-user
// limit / min_status / verified-wallet gate, so a client-supplied itemId is safe
// — but the userId MUST be the session-resolved id, never a body field.
export async function redeemItem(userId: string, itemId: number) {
  if (!userId) return { redeemed: false, error: "unauthorized" };
  if (!rewardsLive()) return { redeemed: false, error: "rewards_not_live" };
  const { data, error } = await (supabase as any).rpc("redeem_shop_item", {
    p_user_id: userId,
    p_item_id: itemId,
  });
  if (error) {
    console.log("[rewards] redeem err", error.message);
    return { redeemed: false, error: "server_error" };
  }
  return data;
}

// Read the two-number summary for a user:
// { spendable, status, tier, lifetime_earned, lifetime_spent }
export async function getRewardsSummary(userId: string) {
  if (!userId) return null;
  const { data } = await (supabase as any).rpc("get_rewards_summary", { p_user_id: userId });
  return data;
}

// Owner-only credit/status adjustment (comp, correction, refund, seed). Reached
// only from the RPC_ADMIN_TOKEN-gated admin route.
export async function adminAdjust(
  userId: string,
  delta: number,
  statusDelta: number,
  reason: string,
  admin = "owner"
) {
  const { data, error } = await (supabase as any).rpc("admin_adjust_points", {
    p_user_id: userId,
    p_delta: delta,
    p_status_delta: statusDelta,
    p_reason: reason,
    p_admin: admin,
  });
  if (error) return { ok: false, error: error.message };
  return data;
}
