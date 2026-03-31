import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const MIN_DISCOUNT_PCT = 15;
const MAX_TWEETS_PER_RUN = 2;
const DEDUP_WINDOW_HOURS = 48;

function buildTweetText(listing: {
  player_name: string;
  set_name: string;
  tier: string;
  serial_number: number;
  circulation_count: number;
  ask_price: number;
  fmv: number;
  discount: number;
  confidence: string;
  buy_url: string;
  badge_slugs?: string[];
}): string {
  const {
    player_name,
    set_name,
    tier,
    serial_number,
    circulation_count,
    ask_price,
    fmv,
    discount,
    confidence,
    buy_url,
    badge_slugs,
  } = listing;

  const tierEmoji: Record<string, string> = {
    ULTIMATE: "🔱",
    LEGENDARY: "🟡",
    RARE: "🔵",
    FANDOM: "🟣",
    COMMON: "⚪",
  };

  const confidenceLabel =
    confidence === "HIGH" ? "🔥 High confidence" :
    confidence === "MEDIUM" ? "📊 Medium confidence" :
    "📉 Low confidence";

  const badgeLine =
    badge_slugs && badge_slugs.length > 0
      ? `🏅 ${badge_slugs.slice(0, 3).join(" · ")}\n`
      : "";

  return [
    `${tierEmoji[tier] ?? "⚪"} ${player_name} — ${discount.toFixed(0)}% below FMV`,
    ``,
    `📦 ${set_name}`,
    `🔢 Serial #${serial_number} / ${circulation_count}`,
    `${badgeLine}`,
    `💰 Ask: $${ask_price.toFixed(2)} | FMV: $${fmv.toFixed(2)}`,
    `${confidenceLabel}`,
    ``,
    `👉 ${buy_url}`,
    ``,
    `#NBATopsShot #RipPacksCity`,
  ]
    .join("\n")
    .trim();
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) as any;

  try {
    // 1. Fetch top discounted listings
    const { data: listings, error: listingsErr } = await svc
      .from("cached_listings")
      .select(
        "id, flow_id, player_name, set_name, tier, serial_number, circulation_count, " +
        "ask_price, fmv, adjusted_fmv, discount, confidence, source, buy_url, " +
        "thumbnail_url, badge_slugs, listing_resource_id, storefront_address"
      )
      .not("fmv", "is", null)
      .not("discount", "is", null)
      .gte("discount", MIN_DISCOUNT_PCT)
      .order("discount", { ascending: false })
      .limit(20);

    if (listingsErr) throw new Error(`cached_listings fetch: ${listingsErr.message}`);
    if (!listings || listings.length === 0) {
      return NextResponse.json({ posted: 0, reason: "no qualifying listings" });
    }

    // 2. Fetch recently posted flow_ids to dedup
    const windowStart = new Date(
      Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const { data: recentPosts } = await svc
      .from("posted_deals")
      .select("flow_id")
      .gte("posted_at", windowStart);

    const postedFlowIds = new Set((recentPosts ?? []).map((r: any) => r.flow_id));

    // 3. Filter to unposted listings
    const candidates = listings.filter((l: any) => !postedFlowIds.has(l.flow_id));
    if (candidates.length === 0) {
      return NextResponse.json({ posted: 0, reason: "all qualifying listings already posted" });
    }

    // 4. Post up to MAX_TWEETS_PER_RUN
    const posted: string[] = [];
    const errors: string[] = [];

    for (const listing of candidates.slice(0, MAX_TWEETS_PER_RUN)) {
      try {
        const tweetText = buildTweetText(listing);

        const { postTweet } = await import("@/lib/twitter/post");
        // postTweet signature: (mediaUrl: string | null, text: string)
        const tweetResult = await postTweet(listing.thumbnail_url ?? null, tweetText);
        const tweetId = tweetResult?.data?.id ?? null;

        await svc.from("posted_deals").insert({
          flow_id: listing.flow_id,
          source: listing.source,
          player_name: listing.player_name,
          edition_key: listing.id,
          listed_price: listing.ask_price,
          fmv: listing.fmv,
          pct_below: listing.discount,
          tweet_id: tweetId,
          brand: "rpc",
        });

        await svc.from("posted_tweets").insert({
          brand: "rpc",
          bot_name: "deal-scheduler",
          tweet_text: tweetText,
          tweet_id: tweetId,
          media_url: listing.thumbnail_url ?? null,
          metadata: {
            flow_id: listing.flow_id,
            player_name: listing.player_name,
            discount: listing.discount,
            ask_price: listing.ask_price,
            fmv: listing.fmv,
            confidence: listing.confidence,
          },
        });

        posted.push(`${listing.player_name} (${listing.discount.toFixed(0)}% below FMV)`);
        console.log(`[social-bot] Posted: ${listing.player_name} — ${listing.discount.toFixed(0)}% off, tweet_id: ${tweetId}`);
      } catch (e: any) {
        const msg = `Failed to post ${listing.player_name}: ${e.message}`;
        errors.push(msg);
        console.error(`[social-bot] ${msg}`);
      }
    }

    return NextResponse.json({
      posted: posted.length,
      deals: posted,
      errors,
      candidates_available: candidates.length,
    });
  } catch (e: any) {
    console.error("[social-bot] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "Use POST with Authorization header to run the social bot" });
}