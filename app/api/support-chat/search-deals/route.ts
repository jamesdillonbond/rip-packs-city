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

    // Use get_top_deals RPC instead of broken nested select
    const { data, error } = await supabase.rpc("get_top_deals", {
      p_player: player ?? null,
      p_team: team ?? null,
      p_tier: tier ? normalizeTier(tier) : null,
      p_max_price: maxPrice ?? null,
      p_min_discount: minDiscount ?? 0,
      p_has_badge: hasBadge ?? false,
      p_limit: limit,
    });

    if (error) {
      console.error("[search-deals] Supabase RPC error:", error);
      return NextResponse.json({ deals: [], error: error.message }, { status: 200 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ deals: [] });
    }

    const deals = data
      .map((row: any) => {
        const fmv = row.fmv_usd ? parseFloat(row.fmv_usd) : null;
        const ask = parseFloat(row.low_ask ?? "0");
        const discount = row.discount_pct ?? (fmv && ask ? Math.round(((fmv - ask) / fmv) * 100) : 0);
        const badges: string[] = Array.isArray(row.play_tags)
          ? row.play_tags.map((t: any) => t.title ?? t).filter(Boolean)
          : [];

        return {
          player_name: row.player_name,
          team: row.team ?? null,
          tier: tierLabel(row.tier),
          set_name: row.set_name,
          series: seriesLabel(row.series_number),
          low_ask: ask,
          fmv,
          confidence: row.confidence ?? null,
          discount_pct: Math.round(discount),
          circulation: row.circulation_count ?? null,
          badges,
          edition_key: row.external_id ?? "",
          rpc_url: `https://rip-packs-city.vercel.app/nba-top-shot/sniper`,
          buy_url: `https://www.nbatopshot.com`,
        };
      })
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
