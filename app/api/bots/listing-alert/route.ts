/**
 * app/api/bots/listing-alert/route.ts
 *
 * New Listing Alert Bot — tweets when high-value Legendary/Ultimate moments
 * (FMV $200+) get listed 15%+ below FMV. Runs every 5 minutes.
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN}
 * Called by: .github/workflows/listing-alert-bot.yml (every 5 min)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TIER_EMOJI: Record<string, string> = {
  MOMENT_TIER_ULTIMATE: "🔱",
  MOMENT_TIER_LEGENDARY: "🟡",
  ULTIMATE: "🔱",
  LEGENDARY: "🟡",
};

interface ListingRow {
  player_name: string;
  set_name: string;
  tier: string;
  ask_price: number;
  fmv: number;
  discount: number;
  serial_number: number;
  circulation_count: number;
  source: string;
  listing_resource_id: string;
}

function buildListingTweet(listing: ListingRow): string {
  const emoji = TIER_EMOJI[listing.tier?.toUpperCase()] ?? "🟡";
  const setName = listing.set_name?.length > 30
    ? listing.set_name.slice(0, 27) + "..."
    : (listing.set_name ?? "");
  const ask = Number(listing.ask_price).toFixed(2);
  const fmv = Number(listing.fmv).toFixed(2);
  const discountPct = Math.round(listing.discount);

  const lines: string[] = [];
  lines.push(`${emoji} ${listing.player_name} 🚨`);
  lines.push(setName);
  lines.push(`Listed: $${ask} | FMV: $${fmv}`);
  lines.push(`🔥 ${discountPct}% below market`);
  lines.push(`🔢 Serial #${listing.serial_number} / ${listing.circulation_count}`);
  lines.push("");
  lines.push("⚡ High-value listing — moves fast");
  lines.push("");
  lines.push("→ rip-packs-city.vercel.app/nba-top-shot/sniper");
  lines.push("");
  lines.push("#NBATopShot #RipPacksCity");

  let tweet = lines.join("\n").trim();
  if (tweet.length > 280) {
    tweet = tweet.slice(0, 277) + "...";
  }
  return tweet;
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // ── Step 1: Find qualifying listings ────────────────────────────────────
    // Get listing_resource_ids already posted
    const { data: alreadyPosted } = await supabase
      .from("posted_listing_alerts")
      .select("listing_resource_id");

    const postedSet = new Set(
      (alreadyPosted ?? []).map((r: any) => r.listing_resource_id)
    );

    // Query cached_listings for high-value Legendary/Ultimate listings
    const { data: rawListings, error: queryError } = await supabase
      .from("cached_listings")
      .select("player_name, set_name, tier, ask_price, fmv, discount, serial_number, circulation_count, source, listing_resource_id")
      .in("tier", ["MOMENT_TIER_LEGENDARY", "MOMENT_TIER_ULTIMATE", "LEGENDARY", "ULTIMATE"])
      .gte("discount", 15)
      .gte("fmv", 200)
      .not("listing_resource_id", "is", null)
      .order("discount", { ascending: false })
      .limit(20);

    if (queryError) {
      console.error("[listing-alert] Query error:", queryError.message);
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    // Filter out already-posted listings
    const listings: ListingRow[] = (rawListings ?? [])
      .filter((r: any) => r.listing_resource_id && !postedSet.has(r.listing_resource_id))
      .slice(0, 2);

    if (listings.length === 0) {
      console.log("[listing-alert] No qualifying listings to post");
      return NextResponse.json({ posted: 0, players: [], errors: [] });
    }

    console.log(`[listing-alert] Found ${listings.length} qualifying listings`);

    // ── Step 2 + 3: Build tweets, post, and log ────────────────────────────
    const posted: string[] = [];
    const errors: string[] = [];

    for (const listing of listings) {
      try {
        const tweetText = buildListingTweet(listing);
        console.log(`[listing-alert] Tweeting: ${listing.player_name} $${listing.ask_price} (${Math.round(listing.discount)}% off)`);

        const result = await postTweet("rpc", tweetText);
        const tweetId = result?.data?.id ?? null;

        // Log to posted_listing_alerts
        await supabase.from("posted_listing_alerts").insert({
          listing_resource_id: listing.listing_resource_id,
          tweet_id: tweetId,
          player_name: listing.player_name,
          set_name: listing.set_name,
          tier: listing.tier,
          ask_price: listing.ask_price,
          fmv_usd: listing.fmv,
          discount_pct: listing.discount,
          serial_number: listing.serial_number,
          circulation_count: listing.circulation_count,
          source: listing.source,
        });

        // Log to posted_tweets
        await supabase.from("posted_tweets").insert({
          brand: "rpc",
          bot_name: "listing-alert",
          tweet_text: tweetText,
          tweet_id: tweetId,
          media_url: null,
          metadata: {
            tier: listing.tier,
            discount_pct: listing.discount,
            player_name: listing.player_name,
          },
        });

        posted.push(listing.player_name);
      } catch (err: any) {
        console.error(`[listing-alert] Failed to tweet ${listing.player_name}: ${err.message}`);
        errors.push(`${listing.player_name}: ${err.message}`);
      }
    }

    console.log(`[listing-alert] Done: posted=${posted.length} errors=${errors.length}`);

    return NextResponse.json({
      posted: posted.length,
      players: posted,
      errors,
    });
  } catch (e: any) {
    console.error("[listing-alert] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Listing Alert bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
