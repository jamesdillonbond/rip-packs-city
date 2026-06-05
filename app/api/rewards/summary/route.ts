// app/api/rewards/summary/route.ts
//
// GET — everything the /rewards page needs for the authenticated user, in one
// round trip: the two-number summary (status + spendable Credits), the active
// earn rules, the active shop catalog, and this user's redemption history.
//
// Doubles as the daily_visit earn hook: award_points("daily_visit") is capped
// to 1/day with a cooldown server-side, so calling it on every page load is a
// safe no-op after the first visit of the day. The user id is session-resolved
// (requireUser → auth.uid()), never from request input.

import { NextResponse } from "next/server";
import { awardPoints, getRewardsSummary } from "@/lib/rewards";
import { requireUser } from "@/lib/auth/supabase-server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getProStatus } from "@/lib/pro";

export const dynamic = "force-dynamic";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  // Capped/cooldowned server-side — safe to fire on every load.
  await awardPoints(user.id, "daily_visit");

  const [summary, rules, shop, redemptions, referrals, cosmetics, bio, verifiedWallet] = await Promise.all([
    getRewardsSummary(user.id),
    supabase
      .from("points_rules")
      .select("action_key,label,points,daily_cap,per_user_limit")
      .eq("active", true)
      .order("points", { ascending: false }),
    supabase
      .from("shop_items")
      .select(
        "id,sku,name,description,type,cost_credits,stock,min_status,requires_verified_wallet,image_url,metadata"
      )
      .eq("active", true)
      .order("cost_credits", { ascending: true }),
    supabase
      .from("redemptions")
      .select("id,shop_item_id,cost_credits,status,requested_at")
      .eq("user_id", user.id)
      .order("requested_at", { ascending: false })
      .limit(50),
    // Referral count: referral_verified earns credited to this user (for the
    // /rewards invite block). 300 credits each, per the points_rules seed.
    supabase
      .from("points_ledger")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("reason", "referral_verified")
      .eq("kind", "earn"),
    // Cosmetics this user owns (for the equip UI) + their currently-equipped
    // slots, so the page can render + let them switch.
    supabase
      .from("user_cosmetics")
      .select("sku,slot,value,acquired_at")
      .eq("user_id", user.id)
      .order("acquired_at", { ascending: false }),
    supabase
      .from("profile_bio")
      .select("equipped_border,equipped_banner")
      .eq("user_id", user.id)
      .maybeSingle(),
    // Most-recent verified wallet → drives the Pro status badge. Matches the
    // wallet fulfill_redemption grants Pro against (lower(wallet_addr)).
    supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("user_id", user.id)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Resolve Pro status from the verified wallet (getProStatus lowercases).
  let pro: { isPro: boolean; plan: string | null; expiresAt: string | null } = {
    isPro: false,
    plan: null,
    expiresAt: null,
  };
  const walletAddr = (verifiedWallet.data as { wallet_addr?: string } | null)?.wallet_addr ?? null;
  if (walletAddr) {
    try {
      pro = await getProStatus(walletAddr);
    } catch {
      /* leave pro at default on lookup error */
    }
  }

  return NextResponse.json({
    userId: user.id,
    summary: summary ?? null,
    rules: rules.data ?? [],
    shop: shop.data ?? [],
    redemptions: redemptions.data ?? [],
    referralCount: referrals.count ?? 0,
    cosmetics: cosmetics.data ?? [],
    equipped: {
      border: (bio.data as { equipped_border?: string | null } | null)?.equipped_border ?? null,
      banner: (bio.data as { equipped_banner?: string | null } | null)?.equipped_banner ?? null,
    },
    pro,
  });
}
