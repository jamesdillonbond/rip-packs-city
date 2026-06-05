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

  const [summary, rules, shop, redemptions] = await Promise.all([
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
  ]);

  return NextResponse.json({
    summary: summary ?? null,
    rules: rules.data ?? [],
    shop: shop.data ?? [],
    redemptions: redemptions.data ?? [],
  });
}
