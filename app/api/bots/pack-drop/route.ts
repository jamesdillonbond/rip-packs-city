/**
 * app/api/bots/pack-drop/route.ts
 *
 * Pack Drop Bot — detects new Top Shot pack distributions and tweets them.
 * Queries the Dapper Studio GQL API for active pack distributions,
 * checks against pack_drops table to find new ones, and posts to Twitter.
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN}
 * Called by: .github/workflows/pack-drop-bot.yml (every 15 min)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Same endpoint the pack-listings route uses (Dapper Studio API)
const TOPSHOT_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql";

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
};

// Query active pack distributions — same schema as pack-listings route
const PACK_DISTRIBUTIONS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!]) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters}) {
      totalCount
      edges {
        node {
          dist_id { key value }
          distribution {
            id { value }
            uuid { value }
            title { value }
            tier { value }
            price { value }
            pack_type { value }
            start_time { value }
            image_urls { value }
            number_of_pack_slots { value }
          }
        }
      }
    }
  }
`;

const ACTIVE_FILTERS = [
  {
    status: { eq: "Sealed" },
    listing: {
      exists: true,
      ft_vault_type: { eq: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault" },
    },
    owner_address: { ne: "0b2a3299cc857e29" },
    excludeReserved: { eq: true },
    type_name: { eq: "A.0b2a3299cc857e29.PackNFT.NFT" },
    distribution: {
      tier: { ignore_case: true, in: [] },
      series_ids: { contains: [], contains_type: "ANY" },
      title: { ignore_case: true, partial_match: true, in: [] },
    },
  },
];

interface DistributionInfo {
  dist_id: string;
  pack_name: string;
  pack_type: string | null;
  tier: string;
  price_usd: number;
  total_slots: number;
  drop_begins_at: string | null;
  image_url: string | null;
}

// ── Step 1: Fetch active distributions from Top Shot ──────────────────────

async function fetchActiveDistributions(): Promise<DistributionInfo[]> {
  const res = await fetch(TOPSHOT_GRAPHQL, {
    method: "POST",
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({
      operationName: "searchPackNftAggregation_searchPacks",
      query: PACK_DISTRIBUTIONS_QUERY,
      variables: { first: 200, filters: ACTIVE_FILTERS },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GQL ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message ?? "GraphQL error");
  }

  const edges = json?.data?.searchPackNftAggregation?.edges ?? [];

  // Dedupe by dist_id (multiple pack NFTs share the same distribution)
  const seen = new Set<string>();
  const distributions: DistributionInfo[] = [];

  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const distId = node.dist_id?.value;
    if (!distId || seen.has(distId)) continue;
    seen.add(distId);

    const d = node.distribution;
    if (!d) continue;

    const rawPrice = d.price?.value ?? 0;
    const priceUsd = rawPrice > 0 && rawPrice <= 10000 ? rawPrice : 0;

    distributions.push({
      dist_id: distId,
      pack_name: d.title?.value ?? "Unknown Pack",
      pack_type: d.pack_type?.value ?? null,
      tier: d.tier?.value ?? "common",
      price_usd: priceUsd,
      total_slots: parseInt(d.number_of_pack_slots?.value ?? "1", 10) || 1,
      drop_begins_at: d.start_time?.value ?? null,
      image_url: d.image_urls?.value?.[0] ?? null,
    });
  }

  return distributions;
}

// ── Step 3: Build tweet ──────────────────────────────────────────────────

function buildDropTweet(drop: DistributionInfo): string {
  // Determine urgency: within 2 hours = imminent
  const now = Date.now();
  const dropTime = drop.drop_begins_at ? new Date(drop.drop_begins_at).getTime() : 0;
  const isImminent = dropTime > 0 && dropTime - now < 2 * 60 * 60 * 1000;

  const lines: string[] = [];

  lines.push(isImminent ? "🔴 PACK DROP" : "🟡 PACK ALERT");
  lines.push(drop.pack_name);

  if (drop.price_usd > 0) {
    lines.push(`$${drop.price_usd} per pack`);
  }

  lines.push("");
  lines.push("🎯 EV analysis ready");
  lines.push("→ rip-packs-city.vercel.app/nba-top-shot/packs");
  lines.push("");
  lines.push("#NBATopShot #RipPacksCity");

  let tweet = lines.join("\n").trim();
  if (tweet.length > 280) {
    tweet = tweet.slice(0, 277) + "...";
  }
  return tweet;
}

// ── Main handler ─────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const errors: string[] = [];

  try {
    // Step 1: Fetch active distributions
    let distributions: DistributionInfo[] = [];
    try {
      distributions = await fetchActiveDistributions();
      console.log(`[pack-drop] Fetched ${distributions.length} active distributions`);
    } catch (err: any) {
      console.error("[pack-drop] GQL fetch failed:", err.message);
      return NextResponse.json({
        new_drops_found: 0,
        tweeted: 0,
        pack_names: [],
        errors: [err.message],
      });
    }

    if (distributions.length === 0) {
      return NextResponse.json({
        new_drops_found: 0,
        tweeted: 0,
        pack_names: [],
        errors: [],
      });
    }

    // Step 2: Check which distributions are already in pack_drops
    const distIds = distributions.map((d) => d.dist_id);
    const { data: existingRows, error: lookupError } = await supabase
      .from("pack_drops")
      .select("dist_id")
      .in("dist_id", distIds);

    if (lookupError) {
      console.error("[pack-drop] pack_drops lookup error:", lookupError.message);
      // If table doesn't exist yet, treat all as new
    }

    const existingSet = new Set(
      (existingRows ?? []).map((r: any) => r.dist_id)
    );

    const newDrops = distributions.filter((d) => !existingSet.has(d.dist_id));
    console.log(`[pack-drop] ${newDrops.length} new drops (${existingSet.size} already tracked)`);

    if (newDrops.length === 0) {
      return NextResponse.json({
        new_drops_found: 0,
        tweeted: 0,
        pack_names: [],
        errors: [],
      });
    }

    // Limit to 2 new drops per run
    const toProcess = newDrops.slice(0, 2);
    const tweeted: string[] = [];

    for (const drop of toProcess) {
      try {
        // Insert into pack_drops
        const { error: insertError } = await supabase
          .from("pack_drops")
          .insert({
            dist_id: drop.dist_id,
            pack_name: drop.pack_name,
            pack_type: drop.pack_type,
            tier: drop.tier,
            price_usd: drop.price_usd,
            total_slots: drop.total_slots,
            drop_begins_at: drop.drop_begins_at,
            image_url: drop.image_url,
          });

        if (insertError) {
          // May be a duplicate race — skip tweeting
          if (insertError.code === "23505") {
            console.log(`[pack-drop] ${drop.pack_name} already inserted (race)`);
            continue;
          }
          console.error(`[pack-drop] Insert error for ${drop.pack_name}:`, insertError.message);
          errors.push(`insert:${drop.pack_name}: ${insertError.message}`);
          continue;
        }

        // Step 3+4: Build and post tweet
        const tweetText = buildDropTweet(drop);
        console.log(`[pack-drop] Tweeting: ${drop.pack_name} (${tweetText.length} chars)`);

        const result = await postTweet("rpc", tweetText);
        const tweetId = result?.data?.id ?? null;

        // Update pack_drops with tweet info
        await supabase
          .from("pack_drops")
          .update({
            tweet_id: tweetId,
            tweeted_at: new Date().toISOString(),
          })
          .eq("dist_id", drop.dist_id);

        // Log to posted_tweets
        await supabase.from("posted_tweets").insert({
          brand: "rpc",
          bot_name: "pack-drop",
          tweet_text: tweetText,
          tweet_id: tweetId,
          media_url: null,
          metadata: {
            dist_id: drop.dist_id,
            pack_name: drop.pack_name,
            tier: drop.tier,
            price_usd: drop.price_usd,
          },
        });

        tweeted.push(drop.pack_name);
      } catch (err: any) {
        console.error(`[pack-drop] Failed for ${drop.pack_name}:`, err.message);
        errors.push(`${drop.pack_name}: ${err.message}`);
      }
    }

    console.log(`[pack-drop] Done: new=${newDrops.length} tweeted=${tweeted.length} errors=${errors.length}`);

    return NextResponse.json({
      new_drops_found: newDrops.length,
      tweeted: tweeted.length,
      pack_names: tweeted,
      errors,
    });
  } catch (e: any) {
    console.error("[pack-drop] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Pack Drop bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
