// app/api/support-chat/search-deals/route.ts
// Internal endpoint: searches badge_editions + fmv_snapshots for deals matching bot queries.
// Called by the support-chat route as a fallback when the live sniper feed is unavailable.
// NOT rate-limited (internal use only) — keep it server-side only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface SearchDealsParams {
  player?: string;
  team?: string;
  tier?: string; // "common" | "rare" | "legendary" | "ultimate" | "fandom"
  maxPrice?: number;
  minDiscount?: number; // pct below FMV, e.g. 15 = 15%
  hasBadge?: boolean;
  limit?: number;
}

function normalizeTier(raw: string): string {
  const map: Record<string, string> = {
    common: "MOMENT_TIER_COMMON",
    rare: "MOMENT_TIER_RARE",
    legendary: "MOMENT_TIER_LEGENDARY",
    ultimate: "MOMENT_TIER_ULTIMATE",
    fandom: "MOMENT_TIER_FANDOM",
  };
  return map[raw.toLowerCase()] ?? raw;
}

function seriesLabel(n: number): string {
  const map: Record<number, string> = {
    0: "Beta",
    1: "S1",
    2: "S2",
    3: "S3",
    4: "S4",
    5: "S5",
    6: "S6",
    7: "S7",
    8: "S8",
  };
  return map[n] ?? `S${n}`;
}

function tierLabel(raw: string): string {
  return (
    raw.replace("MOMENT_TIER_", "").charAt(0).toUpperCase() +
    raw.replace("MOMENT_TIER_", "").slice(1).toLowerCase()
  );
}

export async function POST(req: NextRequest) {
  try {
    const body: SearchDealsParams = await req.json();
    const {
      player,
      team,
      tier,
      maxPrice,
      minDiscount = 0,
      hasBadge,
      limit = 8,
    } = body;

    let query = supabase
      .from("badge_editions")
      .select(
        `
        id, player_name, team, tier, set_name, series_number,
        low_ask, avg_sale_price, circulation_count,
        play_tags, asset_path_prefix,
        editions!inner(
          id, external_id,
          fmv_snapshots!inner(fmv_usd, confidence, computed_at)
        )
      `
      )
      .eq("parallel_id", 0)
      .eq("flow_retired", false)
      .not("low_ask", "is", null)
      .gt("low_ask", 0);

    if (player) query = query.ilike("player_name", `%${player}%`);
    if (team) query = query.ilike("team", `%${team}%`);
    if (tier) query = query.eq("tier", normalizeTier(tier));
    if (maxPrice) query = query.lte("low_ask", maxPrice);

    const { data, error } = await query.limit(limit * 3);

    if (error) {
      console.error("[search-deals] Supabase error:", error);
      return NextResponse.json({ deals: [], error: error.message }, { status: 200 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ deals: [] });
    }

    const deals = data
      .map((be: any) => {
        const fmv = be.editions?.[0]?.fmv_snapshots?.[0]?.fmv_usd ?? null;
        const confidence = be.editions?.[0]?.fmv_snapshots?.[0]?.confidence ?? null;
        const externalId = be.editions?.[0]?.external_id ?? "";
        const discount =
          fmv && be.low_ask ? Math.round(((fmv - be.low_ask) / fmv) * 100) : 0;
        const badges: string[] = Array.isArray(be.play_tags)
          ? be.play_tags.map((t: any) => t.title).filter(Boolean)
          : [];

        return {
          player_name: be.player_name,
          team: be.team,
          tier: tierLabel(be.tier),
          set_name: be.set_name,
          series: seriesLabel(be.series_number),
          low_ask: parseFloat(be.low_ask),
          fmv: fmv ? parseFloat(fmv) : null,
          confidence,
          discount_pct: discount,
          circulation: be.circulation_count,
          badges,
          edition_key: externalId,
          rpc_url: `https://rip-packs-city.vercel.app/nba-top-shot/sniper`,
          buy_url: `https://www.nbatopshot.com/marketplace/moment/${externalId}`,
        };
      })
      .filter(
        (d: any) =>
          d.discount_pct >= minDiscount &&
          (!hasBadge || d.badges.length > 0)
      )
      .sort((a: any, b: any) => b.discount_pct - a.discount_pct)
      .slice(0, limit);

    const totalDeals = deals.length;
    const avgDiscount =
      totalDeals > 0
        ? Math.round(deals.reduce((s: number, d: any) => s + d.discount_pct, 0) / totalDeals)
        : 0;

    return NextResponse.json({ deals, meta: { total: totalDeals, avgDiscount } });
  } catch (err: any) {
    console.error("[search-deals] Unexpected error:", err);
    return NextResponse.json({ deals: [], error: err.message }, { status: 200 });
  }
}
