/**
 * app/api/bots/rpc-report/route.ts
 *
 * The RPC Report — weekly market intelligence tweet posted every Monday at 9AM ET.
 *
 * Sections (in order, each omitted gracefully if no data):
 *   1. FMV Movers — top 3 gainers + top 2 losers over the past 7 days
 *   2. Live Sniper Deal Count — moments listed 20%+ below FMV right now
 *   3. Pack EV Highlight — best value pack from pack_ev_cache (omitted if table empty)
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN} (same token used by pipeline + sentinel)
 * Called by: .github/workflows/rpc-report.yml (cron: 0 14 * * 1 — Mondays 9AM ET)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const MIN_FMV_USD = 2.0;
const MIN_PCT_CHANGE = 5.0;
const SNIPER_THRESHOLD_PCT = 20;

function tierLabel(tier: string): string {
  const map: Record<string, string> = {
    MOMENT_TIER_ULTIMATE: "Ultimate",
    MOMENT_TIER_LEGENDARY: "Legendary",
    MOMENT_TIER_RARE: "Rare",
    MOMENT_TIER_FANDOM: "Fandom",
    MOMENT_TIER_COMMON: "Common",
    ULTIMATE: "Ultimate",
    LEGENDARY: "Legendary",
    RARE: "Rare",
    FANDOM: "Fandom",
    COMMON: "Common",
  };
  return map[tier] ?? tier;
}

interface Mover {
  player_name: string;
  set_name: string;
  tier: string;
  old_fmv: number;
  new_fmv: number;
  pct_change: number;
}

interface PackEV {
  pack_name: string;
  ev: number;
  value_ratio: number;
}

function buildTweet(
  gainers: Mover[],
  losers: Mover[],
  hotDealCount: number,
  bestPack: PackEV | null
): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const lines: string[] = [];

  lines.push(`📊 RPC REPORT — ${today}`);
  lines.push("");

  const hasMovers = gainers.length > 0 || losers.length > 0;

  if (hasMovers) {
    if (gainers.length > 0) {
      lines.push("🟢 Top Gainers (7d)");
      for (const g of gainers) {
        const sign = g.pct_change > 0 ? "+" : "";
        lines.push(
          `↑ ${g.player_name} ${sign}${g.pct_change.toFixed(0)}% ($${Number(g.old_fmv).toFixed(0)} → $${Number(g.new_fmv).toFixed(0)})`
        );
      }
      lines.push("");
    }
    if (losers.length > 0) {
      lines.push("🔴 Biggest Drops (7d)");
      for (const l of losers) {
        lines.push(
          `↓ ${l.player_name} ${l.pct_change.toFixed(0)}% ($${Number(l.old_fmv).toFixed(0)} → $${Number(l.new_fmv).toFixed(0)})`
        );
      }
      lines.push("");
    }
  } else {
    lines.push("📈 FMV trends building — check back next week for movers.");
    lines.push("");
  }

  if (hotDealCount > 0) {
    lines.push(
      `🎯 ${hotDealCount} moment${hotDealCount !== 1 ? "s" : ""} listed ${SNIPER_THRESHOLD_PCT}%+ below FMV right now`
    );
  } else {
    lines.push("🎯 Market tight — no deep discounts right now");
  }

  if (bestPack) {
    const ratio = Number(bestPack.value_ratio);
    const ev = Number(bestPack.ev);
    lines.push(
      `📦 Best pack EV: ${bestPack.pack_name} (${ratio.toFixed(2)}x value, ~$${ev.toFixed(0)} EV)`
    );
  }

  lines.push("");
  lines.push("→ rip-packs-city.vercel.app/nba-top-shot/sniper");
  lines.push("");
  lines.push("#NBATopShot #RipPacksCity");

  return lines.join("\n").trim();
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) as any;

  try {
    // 1. FMV Movers
    const { data: allMovers, error: moverError } = await svc.rpc(
      "get_fmv_movers",
      {
        lookback_interval: "7 days",
        limit_count: 20,
        min_fmv: MIN_FMV_USD,
      }
    );

    if (moverError) {
      console.error("[rpc-report] Mover RPC error:", moverError.message);
    }

    const movers: Mover[] = (allMovers ?? []).filter(
      (m: Mover) => Math.abs(m.pct_change) >= MIN_PCT_CHANGE
    );

    const gainers = movers
      .filter((m) => m.pct_change > 0)
      .sort((a, b) => b.pct_change - a.pct_change)
      .slice(0, 3);

    const losers = movers
      .filter((m) => m.pct_change < 0)
      .sort((a, b) => a.pct_change - b.pct_change)
      .slice(0, 2);

    // 2. Live Sniper Deal Count
    let hotDealCount = 0;
    try {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "https://rip-packs-city.vercel.app";

      const feedRes = await fetch(`${baseUrl}/api/sniper-feed`, {
        headers: { "User-Agent": "rpc-report-bot/1.0" },
        signal: AbortSignal.timeout(8000),
      });

      if (feedRes.ok) {
        const feedData = await feedRes.json();
        const deals = Array.isArray(feedData) ? feedData : feedData.deals ?? [];
        hotDealCount = deals.filter(
          (d: any) =>
            (d.discount ?? d.discountPct ?? d.discount_pct ?? d.pctBelow ?? 0) >=
            SNIPER_THRESHOLD_PCT
        ).length;
      }
    } catch (e: any) {
      console.warn("[rpc-report] Sniper feed fetch failed:", e.message);
    }

    // 3. Best Pack EV
    let bestPack: PackEV | null = null;
    try {
      const { data: packData } = await svc
        .from("pack_ev_cache")
        .select("pack_name, ev, value_ratio")
        .gt("ev", 0)
        .order("value_ratio", { ascending: false })
        .limit(1)
        .single();

      if (packData) bestPack = packData;
    } catch {
      // pack_ev_cache empty — skip silently
    }

    // 4. Build + post tweet
    const tweetText = buildTweet(gainers, losers, hotDealCount, bestPack);

    console.log("[rpc-report] Tweet preview:\n", tweetText);
    console.log("[rpc-report] Character count:", tweetText.length);

    const tweetResult = await postTweet("rpc", tweetText);
    const tweetId = tweetResult?.data?.id ?? null;

    // 5. Log to posted_tweets
    await svc.from("posted_tweets").insert({
      brand: "rpc",
      bot_name: "rpc-report",
      tweet_text: tweetText,
      tweet_id: tweetId,
      media_url: null,
      metadata: {
        gainers_count: gainers.length,
        losers_count: losers.length,
        hot_deal_count: hotDealCount,
        pack_ev: bestPack ? { name: bestPack.pack_name, ev: bestPack.ev } : null,
      },
    });

    return NextResponse.json({
      success: true,
      tweet_id: tweetId,
      tweet_length: tweetText.length,
      gainers: gainers.map((g) => g.player_name),
      losers: losers.map((l) => l.player_name),
      hot_deal_count: hotDealCount,
      pack_ev: bestPack?.pack_name ?? null,
    });
  } catch (e: any) {
    console.error("[rpc-report] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "RPC Report bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
