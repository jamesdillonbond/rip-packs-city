import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";
import type { SniperDeal } from "@/app/api/sniper-feed/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─── Config ──────────────────────────────────────────────────────────────────

const MIN_DISCOUNT = 20;
const MAX_DEALS_TO_FETCH = 50;
const DEDUP_WINDOW_HOURS = 24;
const MAX_TWEETS_PER_RUN = 1; // avoid spam — one tweet per cron run

const BASE_URL =
  process.env.NEXT_PUBLIC_VERCEL_URL
    ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
    : "https://rip-packs-city.vercel.app";

// ─── Tweet Formatting ────────────────────────────────────────────────────────

function buildTweetText(deal: SniperDeal, ogCardUrl: string): string {
  const tierEmoji: Record<string, string> = {
    ULTIMATE: "🔱",
    LEGENDARY: "🟡",
    RARE: "🔵",
    FANDOM: "🟣",
    COMMON: "⚪",
  };

  const emoji = tierEmoji[deal.tier] ?? "⚪";
  const serialTag = deal.serialSignal ? ` (${deal.serialSignal})` : "";
  const badgeLine =
    deal.badgeLabels && deal.badgeLabels.length > 0
      ? `🏅 ${deal.badgeLabels.slice(0, 3).join(" · ")}`
      : null;

  return [
    `${emoji} ${deal.playerName} — ${deal.discount.toFixed(0)}% below FMV${serialTag}`,
    ``,
    `💰 $${deal.askPrice.toFixed(2)} (FMV $${deal.adjustedFmv.toFixed(2)})`,
    badgeLine,
    ``,
    `👉 ${deal.buyUrl}`,
    ``,
    ogCardUrl,
    ``,
    `#NBATopsShot #RipPacksCity`,
  ]
    .filter((line) => line !== null)
    .join("\n")
    .trim();
}

function buildOgCardUrl(deal: SniperDeal): string {
  const params = new URLSearchParams({
    player: deal.playerName,
    tier: deal.tier,
    serial: String(deal.serial),
    listed: String(deal.askPrice),
    fmv: String(deal.adjustedFmv),
    pct: String(Math.round(deal.discount)),
    badge: deal.badgeLabels?.[0] ?? "",
    source: deal.source ?? "",
  });
  return `${BASE_URL}/api/og/deal?${params.toString()}`;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

async function handler(request: NextRequest) {
  // ── Activation flag ──────────────────────────────────────────────
  // TWITTER_BOT_ENABLED must be set to "true" in Vercel env vars to
  // activate this cron. Leave it unset (or set to anything else) to
  // keep the bot dormant. This is the kill switch.
  if (process.env.TWITTER_BOT_ENABLED !== "true") {
    return NextResponse.json(
      { skipped: true, reason: "TWITTER_BOT_ENABLED not set" },
      { status: 200 }
    );
  }

  // ── Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET> ──
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // 1. Fetch top deals from sniper feed (sorted by discount, min 20%)
    const feedRes = await fetch(
      `${BASE_URL}/api/sniper-feed?sortBy=discount&minDiscount=${MIN_DISCOUNT}&limit=${MAX_DEALS_TO_FETCH}`,
      { cache: "no-store" }
    );

    if (!feedRes.ok) {
      return NextResponse.json(
        { error: `Sniper feed returned ${feedRes.status}` },
        { status: 502 }
      );
    }

    const feed = (await feedRes.json()) as { deals: SniperDeal[] };
    const topDeals = feed.deals.slice(0, 3);

    if (topDeals.length === 0) {
      return NextResponse.json({ ok: true, reason: "no deals above threshold" });
    }

    // 2. Dedup against posted_deals (last 24 hours)
    const windowStart = new Date(
      Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();

    const { data: recentPosts } = await svc
      .from("posted_deals")
      .select("flow_id")
      .gte("posted_at", windowStart);

    const postedFlowIds = new Set(
      (recentPosts ?? []).map((r: { flow_id: string }) => r.flow_id)
    );

    // 3. Find the best unposted deal
    const newDeal = topDeals.find((d) => !postedFlowIds.has(d.flowId));
    if (!newDeal) {
      return NextResponse.json({ ok: true, reason: "all top deals already posted" });
    }

    // 4. Post tweet (max 1 per run)
    const ogCardUrl = buildOgCardUrl(newDeal);
    const tweetText = buildTweetText(newDeal, ogCardUrl);
    const tweetResult = await postTweet("rpc", tweetText);
    const tweetId = tweetResult?.data?.id ?? null;

    // 5. Record in posted_deals
    await svc.from("posted_deals").insert({
      flow_id: newDeal.flowId,
      source: newDeal.source ?? "sniper-feed",
      player_name: newDeal.playerName,
      edition_key: newDeal.editionKey,
      listed_price: newDeal.askPrice,
      fmv: newDeal.adjustedFmv,
      pct_below: newDeal.discount,
      tweet_id: tweetId,
      brand: "rpc",
      posted_at: new Date().toISOString(),
    });

    console.log(
      `[tweet-deals] Posted: ${newDeal.playerName} — ${newDeal.discount.toFixed(0)}% off, tweet_id: ${tweetId}`
    );

    return NextResponse.json({
      ok: true,
      deal: {
        flowId: newDeal.flowId,
        playerName: newDeal.playerName,
        askPrice: newDeal.askPrice,
        discount: newDeal.discount,
      },
      tweetId,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[tweet-deals] Fatal error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
