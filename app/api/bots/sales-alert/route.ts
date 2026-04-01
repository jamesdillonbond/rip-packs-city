/**
 * app/api/bots/sales-alert/route.ts
 *
 * Flowty Sales Bot — tweets notable sales (>= $50) every 20 min via pipeline.
 * Queries sales_2026 for recent sales not yet posted, enriches with FMV +
 * badge data, posts to Twitter, and logs to posted_sales + posted_tweets.
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN}
 * Called by: .github/workflows/rpc-pipeline.yml (every 20 min)
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
  ULTIMATE: "🔱",
  LEGENDARY: "🟡",
  RARE: "🔵",
  FANDOM: "🟣",
  COMMON: "⚪",
  MOMENT_TIER_ULTIMATE: "🔱",
  MOMENT_TIER_LEGENDARY: "🟡",
  MOMENT_TIER_RARE: "🔵",
  MOMENT_TIER_FANDOM: "🟣",
  MOMENT_TIER_COMMON: "⚪",
};

interface SaleRow {
  transaction_hash: string;
  price_usd: number;
  serial_number: number;
  marketplace: string;
  sold_at: string;
  edition_id: string;
  player_name: string;
  set_name: string;
  tier: string;
  circulation_count: number;
  fmv_usd: number | null;
  confidence: string | null;
}

function buildSaleTweet(sale: SaleRow): string {
  const emoji = TIER_EMOJI[sale.tier?.toUpperCase()] ?? "⚪";
  const setName = sale.set_name?.length > 30
    ? sale.set_name.slice(0, 27) + "..."
    : (sale.set_name ?? "");
  const price = Number(sale.price_usd).toFixed(2);

  const lines: string[] = [];
  lines.push(`${emoji} ${sale.player_name}`);
  lines.push(setName);

  // Price + FMV line
  let priceLine = `Sold: $${price}`;
  const fmv = sale.fmv_usd;
  const pctVsFmv = fmv && fmv > 1
    ? Math.round(((sale.price_usd - fmv) / fmv) * 100)
    : null;

  if (fmv && fmv > 1) {
    priceLine += ` · FMV: $${Number(fmv).toFixed(2)}`;
  }
  lines.push(priceLine);

  // Market signal
  if (pctVsFmv !== null && pctVsFmv > 15) {
    lines.push(`📈 ${pctVsFmv}% above market`);
  } else if (pctVsFmv !== null && pctVsFmv < -15) {
    lines.push(`🔥 ${Math.abs(pctVsFmv)}% below market`);
  }

  lines.push(`🔢 Serial #${sale.serial_number} / ${sale.circulation_count}`);
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
    // Query recent notable sales not yet tweeted
    const { data: sales, error: queryError } = await supabase.rpc("get_notable_sales_for_tweet", {
      // Fallback: use raw SQL via .from() if RPC doesn't exist
    }).catch(() => ({ data: null, error: { message: "rpc not found" } }));

    // If RPC doesn't exist, use direct query approach
    let saleRows: SaleRow[] = [];

    if (sales && !queryError) {
      saleRows = sales;
    } else {
      // Direct query: sales_2026 joined with editions + badge_editions + fmv_snapshots
      const { data: rawSales, error: rawError } = await supabase
        .from("sales_2026")
        .select(`
          transaction_hash,
          price_usd,
          serial_number,
          marketplace,
          sold_at,
          edition_id
        `)
        .gte("ingested_at", new Date(Date.now() - 25 * 60 * 1000).toISOString())
        .gte("price_usd", 50)
        .not("transaction_hash", "is", null)
        .order("price_usd", { ascending: false })
        .limit(10);

      if (rawError) {
        console.error("[sales-alert] Query error:", rawError.message);
        return NextResponse.json({ error: rawError.message }, { status: 500 });
      }

      if (!rawSales?.length) {
        console.log("[sales-alert] No notable sales in last 25 min");
        return NextResponse.json({ posted: 0, players: [], errors: [] });
      }

      // Filter out already-posted sales
      const txHashes = rawSales.map((s: any) => s.transaction_hash);
      const { data: alreadyPosted } = await supabase
        .from("posted_sales")
        .select("transaction_hash")
        .in("transaction_hash", txHashes);

      const postedSet = new Set(
        (alreadyPosted ?? []).map((r: any) => r.transaction_hash)
      );
      const unpostedSales = rawSales.filter(
        (s: any) => !postedSet.has(s.transaction_hash)
      );

      if (!unpostedSales.length) {
        console.log("[sales-alert] All recent sales already posted");
        return NextResponse.json({ posted: 0, players: [], errors: [] });
      }

      // Enrich with edition data (player_name, set_name, tier, circulation_count)
      const editionIds = [...new Set(unpostedSales.map((s: any) => s.edition_id).filter(Boolean))];
      const { data: editions } = await supabase
        .from("editions")
        .select("id, external_id")
        .in("id", editionIds);

      const editionMap = new Map<string, string>();
      for (const e of (editions ?? []) as { id: string; external_id: string }[]) {
        editionMap.set(e.id, e.external_id);
      }

      // Get badge_editions data for enrichment
      const externalIds = [...editionMap.values()];
      const playIds = externalIds.map((eid) => eid.split(":")[1]).filter(Boolean);
      const setIds = externalIds.map((eid) => eid.split(":")[0]).filter(Boolean);

      let badgeMap = new Map<string, { player_name: string; set_name: string; tier: string; circulation_count: number }>();

      if (playIds.length > 0) {
        const { data: badgeRows } = await supabase
          .from("badge_editions")
          .select("id, player_name, set_name, tier, circulation_count, parallel_id")
          .eq("parallel_id", 0);

        for (const row of (badgeRows ?? []) as any[]) {
          // badge_editions.id format: "setId+playId"
          const parts = (row.id as string).split("+");
          if (parts.length >= 2) {
            const extKey = `${parts[0]}:${parts[1]}`;
            badgeMap.set(extKey, {
              player_name: row.player_name,
              set_name: row.set_name,
              tier: row.tier,
              circulation_count: row.circulation_count,
            });
          }
        }
      }

      // Get latest FMV per edition
      const fmvLookup = new Map<string, { fmv_usd: number; confidence: string }>();
      if (editionIds.length > 0) {
        const { data: fmvRows } = await supabase
          .from("fmv_snapshots")
          .select("edition_id, fmv_usd, confidence, computed_at")
          .in("edition_id", editionIds)
          .order("computed_at", { ascending: false });

        const seenFmv = new Set<string>();
        for (const row of (fmvRows ?? []) as any[]) {
          if (seenFmv.has(row.edition_id)) continue;
          seenFmv.add(row.edition_id);
          if (row.fmv_usd && row.fmv_usd > 0) {
            fmvLookup.set(row.edition_id, { fmv_usd: row.fmv_usd, confidence: row.confidence });
          }
        }
      }

      // Build enriched sale rows
      for (const sale of unpostedSales) {
        const extId = editionMap.get(sale.edition_id) ?? "";
        const badge = badgeMap.get(extId);
        const fmv = fmvLookup.get(sale.edition_id);

        saleRows.push({
          transaction_hash: sale.transaction_hash,
          price_usd: sale.price_usd,
          serial_number: sale.serial_number,
          marketplace: sale.marketplace,
          sold_at: sale.sold_at,
          edition_id: sale.edition_id,
          player_name: badge?.player_name ?? "Unknown",
          set_name: badge?.set_name ?? "",
          tier: badge?.tier ?? "COMMON",
          circulation_count: badge?.circulation_count ?? 0,
          fmv_usd: fmv?.fmv_usd ?? null,
          confidence: fmv?.confidence ?? null,
        });
      }
    }

    // Limit to 3 per run to avoid spam
    const toPost = saleRows.slice(0, 3);

    console.log(`[sales-alert] ${saleRows.length} notable sales found, posting ${toPost.length}`);

    const posted: string[] = [];
    const errors: string[] = [];

    for (const sale of toPost) {
      try {
        const tweetText = buildSaleTweet(sale);
        console.log(`[sales-alert] Tweeting: ${sale.player_name} $${sale.price_usd}`);

        const result = await postTweet("rpc", tweetText);
        const tweetId = result?.data?.id ?? null;

        const pctVsFmv = sale.fmv_usd && sale.fmv_usd > 1
          ? Math.round(((sale.price_usd - sale.fmv_usd) / sale.fmv_usd) * 100)
          : null;

        // Log to posted_sales
        await supabase.from("posted_sales").insert({
          transaction_hash: sale.transaction_hash,
          tweet_id: tweetId,
          player_name: sale.player_name,
          set_name: sale.set_name,
          tier: sale.tier,
          price_usd: sale.price_usd,
          fmv_usd: sale.fmv_usd,
          pct_vs_fmv: pctVsFmv,
          serial_number: sale.serial_number,
          circulation_count: sale.circulation_count,
          marketplace: sale.marketplace,
          sold_at: sale.sold_at,
        });

        // Log to posted_tweets
        await supabase.from("posted_tweets").insert({
          brand: "rpc",
          bot_name: "sales-alert",
          tweet_text: tweetText,
          tweet_id: tweetId,
          media_url: null,
          metadata: {
            price: sale.price_usd,
            player_name: sale.player_name,
          },
        });

        posted.push(sale.player_name);
      } catch (err: any) {
        console.error(`[sales-alert] Failed to tweet ${sale.player_name}: ${err.message}`);
        errors.push(`${sale.player_name}: ${err.message}`);
      }
    }

    console.log(`[sales-alert] Done: posted=${posted.length} errors=${errors.length}`);

    return NextResponse.json({
      posted: posted.length,
      players: posted,
      errors,
    });
  } catch (e: any) {
    console.error("[sales-alert] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Sales Alert bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
