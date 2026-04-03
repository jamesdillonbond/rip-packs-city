import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SniperDeal } from "@/app/api/sniper-feed/route";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const MIN_DISCOUNT = 15;
const MAX_PRICE = 500;
const DEDUP_WINDOW_HOURS = 24;

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
      ? `🏅 ${deal.badgeLabels.slice(0, 3).join(" · ")}\n`
      : "";

  return [
    `${emoji} ${deal.playerName} — ${deal.discount.toFixed(0)}% below FMV${serialTag}`,
    ``,
    `💰 $${deal.askPrice.toFixed(2)} (FMV $${deal.adjustedFmv.toFixed(2)})`,
    badgeLine ? badgeLine.trim() : null,
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
    source: deal.source,
  });
  return `${BASE_URL}/api/og/deal?${params.toString()}`;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // Kill switch — skip when bot is not explicitly enabled
  if (process.env.TWITTER_BOT_ENABLED !== "true") {
    return NextResponse.json({ ok: false, reason: "bot_disabled" }, { status: 200 });
  }

  // Auth check
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 1. Fetch sniper feed sorted by discount descending
    const feedRes = await fetch(
      `${BASE_URL}/api/sniper-feed?sort=discount&limit=50&maxPrice=${MAX_PRICE}`,
      { cache: "no-store" }
    );
    if (!feedRes.ok) {
      return NextResponse.json(
        { error: `Sniper feed returned ${feedRes.status}` },
        { status: 502 }
      );
    }

    const feed = (await feedRes.json()) as { deals: SniperDeal[] };
    const eligible = feed.deals.filter(
      (d) => d.discount >= MIN_DISCOUNT && d.askPrice <= MAX_PRICE
    );

    if (eligible.length === 0) {
      return NextResponse.json({ ok: false, reason: "no eligible deal" });
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

    // 3. Pick the best deal not recently tweeted
    const best = eligible.find((d) => !postedFlowIds.has(d.flowId));
    if (!best) {
      return NextResponse.json({
        ok: false,
        reason: "no eligible deal",
      });
    }

    // 4. Build tweet and post
    const ogCardUrl = buildOgCardUrl(best);
    const tweetText = buildTweetText(best, ogCardUrl);

    const { postTweet } = await import("@/lib/twitter/post");
    const tweetResult = await postTweet("rpc", tweetText);
    const tweetId = tweetResult?.data?.id ?? null;

    // 5. Record in posted_deals
    await svc.from("posted_deals").insert({
      flow_id: best.flowId,
      source: best.source,
      player_name: best.playerName,
      edition_key: best.editionKey,
      listed_price: best.askPrice,
      fmv: best.adjustedFmv,
      pct_below: best.discount,
      tweet_id: tweetId,
      brand: "rpc",
    });

    console.log(
      `[deal-tweet] Posted: ${best.playerName} — ${best.discount.toFixed(0)}% off, tweet_id: ${tweetId}`
    );

    return NextResponse.json({
      ok: true,
      deal: {
        flowId: best.flowId,
        playerName: best.playerName,
        askPrice: best.askPrice,
        discount: best.discount,
      },
      tweetId,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[deal-tweet] Fatal error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Use POST with Authorization header to trigger the deal tweet bot",
  });
}
