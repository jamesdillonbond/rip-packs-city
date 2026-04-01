/**
 * app/api/bots/portfolio-digest/route.ts
 *
 * Portfolio Digest Bot — weekly Sunday evening recap of the Top Shot market.
 * Highlights FMV movers, top sets by series, biggest sale of the week,
 * and any special serial sales.
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN}
 * Called by: .github/workflows/portfolio-digest.yml (cron: 0 22 * * 0 — Sundays 6PM ET)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

// Series number to label mapping
const SERIES_LABELS: Record<number, string> = {
  0: "Beta",
  1: "Series 1",
  2: "Series 2",
  3: "Series 3",
  4: "Series 4",
  5: "Series 5",
  6: "Series 6",
  7: "Series 7",
  8: "2025-26",
};

/**
 * Get the most recent Sunday as YYYY-MM-DD.
 */
function getMostRecentSunday(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 0 : day;
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - diff);
  return sunday.toISOString().split("T")[0];
}

/**
 * Format a date string like "Apr 6".
 */
function formatSundayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Format volume with K suffix if over 1000.
 */
function formatVolume(val: number): string {
  if (val >= 1000) {
    return (val / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return val.toFixed(0);
}

/**
 * Detect special serial labels for a sale.
 */
function detectSpecialSerial(
  serialNumber: number,
  circulationCount: number
): string | null {
  if (serialNumber === 1) return "#1";
  if (serialNumber === circulationCount) return `Last #${circulationCount}`;
  if (circulationCount <= 99 && serialNumber <= 10) return `Low #${serialNumber}`;
  if (circulationCount <= 999 && serialNumber <= 25) return `Low #${serialNumber}`;
  if (serialNumber === 23) return "Jordan #";
  if (serialNumber === 2026) return "Year Serial";
  return null;
}

interface FmvMover {
  player_name: string;
  set_name: string;
  tier: string;
  old_fmv: number;
  new_fmv: number;
  pct_change: number;
}

export async function POST(req: Request) {
  // Auth gate
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) as any;

  try {
    const sundayDate = getMostRecentSunday();
    const sundayLabel = formatSundayLabel(sundayDate);

    // STEP 1 — Check dedup
    const { data: existingDigest } = await svc
      .from("posted_digests")
      .select("id")
      .eq("week_ending", sundayDate)
      .limit(1);

    if (existingDigest && existingDigest.length > 0) {
      return NextResponse.json({
        message: "Already posted this week",
        posted: false,
      });
    }

    // STEP 2 — Weekly sales stats
    const { data: salesStats, error: salesStatsError } = await svc.rpc(
      "get_weekly_sales_stats" as never,
      {}
    ).single() as any;

    // Fallback: query sales_2026 directly
    const { data: rawStats } = await svc
      .from("sales_2026")
      .select("price_usd")
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const salesRows = rawStats ?? [];
    const totalSales = salesRows.length;
    const totalVolume = salesRows.reduce((sum: number, r: any) => sum + Number(r.price_usd ?? 0), 0);
    const topSalePrice = salesRows.reduce((max: number, r: any) => Math.max(max, Number(r.price_usd ?? 0)), 0);
    const avgSale = totalSales > 0 ? totalVolume / totalSales : 0;

    // Get the top sale record with edition details
    const { data: topSaleRows } = await svc
      .from("sales_2026")
      .select(`
        price_usd,
        badge_edition_id,
        serial_number
      `)
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("price_usd", { ascending: false })
      .limit(1);

    let topSalePlayer = "Unknown";
    let topSaleSetName = "";
    let topSaleTier = "";
    let topSaleSeriesNumber = 0;
    let topSaleSerialNumber = 0;
    let topSaleCirculation = 0;
    let specialSerialLabel: string | null = null;

    if (topSaleRows && topSaleRows.length > 0) {
      const topSale = topSaleRows[0];
      const badgeEditionId = topSale.badge_edition_id;
      topSaleSerialNumber = Number(topSale.serial_number ?? 0);

      if (badgeEditionId) {
        // Look up badge_edition and then edition details
        const { data: beData } = await svc
          .from("badge_editions")
          .select("id, parallel_id")
          .eq("id", badgeEditionId)
          .eq("parallel_id", 0)
          .limit(1)
          .single();

        if (beData) {
          const parts = beData.id.split("+");
          if (parts.length >= 2) {
            // Match editions using split_part logic
            const { data: editionData } = await svc
              .from("editions")
              .select("player_name, set_name, tier, series_number, circulation_count, external_id")
              .like("external_id", `${parts[0]}:${parts[1]}%`)
              .limit(1)
              .single();

            if (editionData) {
              topSalePlayer = editionData.player_name ?? "Unknown";
              topSaleSetName = editionData.set_name ?? "";
              topSaleTier = editionData.tier ?? "";
              topSaleSeriesNumber = Number(editionData.series_number ?? 0);
              topSaleCirculation = Number(editionData.circulation_count ?? 0);
            }
          }
        }
      }

      // STEP 3 — Special serial detection on top sale
      if (topSaleSerialNumber > 0 && topSaleCirculation > 0) {
        specialSerialLabel = detectSpecialSerial(topSaleSerialNumber, topSaleCirculation);
      }
    }

    // STEP 4 — Top set by volume this week
    let topSetName = "";
    let topSetSeriesNumber = 0;
    let topSetVolume = 0;
    let topSetSalesCount = 0;

    const { data: topSetRows } = await svc.rpc("get_top_set_by_volume" as never, {}).select() as any;

    // Fallback: query sales joined with editions for top set
    const { data: setRows } = await svc
      .from("sales_2026")
      .select(`
        price_usd,
        badge_edition_id
      `)
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    // Aggregate set volumes from badge_editions -> editions
    if (setRows && setRows.length > 0) {
      // Collect all badge_edition_ids
      const beIds = [...new Set(setRows.map((r: any) => r.badge_edition_id).filter(Boolean))];

      if (beIds.length > 0) {
        // Get edition details for all badge_editions
        const { data: beList } = await svc
          .from("badge_editions")
          .select("id")
          .in("id", beIds)
          .eq("parallel_id", 0);

        if (beList && beList.length > 0) {
          // Build lookup of external_id prefix -> set/series
          const prefixes = beList.map((be: any) => {
            const parts = be.id.split("+");
            return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
          }).filter(Boolean);

          // Query editions for these prefixes
          const setAgg: Record<string, { setName: string; seriesNumber: number; volume: number; count: number }> = {};

          // Process in batches to avoid query limits
          for (let i = 0; i < prefixes.length; i += 50) {
            const batch = prefixes.slice(i, i + 50);
            for (const prefix of batch) {
              const { data: edData } = await svc
                .from("editions")
                .select("set_name, series_number")
                .like("external_id", `${prefix}%`)
                .limit(1)
                .single();

              if (edData) {
                const key = `${edData.series_number}::${edData.set_name}`;
                if (!setAgg[key]) {
                  setAgg[key] = {
                    setName: edData.set_name,
                    seriesNumber: Number(edData.series_number),
                    volume: 0,
                    count: 0,
                  };
                }
              }
            }
          }

          // Now aggregate sales per set
          const bePrefixMap: Record<string, string> = {};
          for (const be of beList) {
            const parts = be.id.split("+");
            if (parts.length >= 2) bePrefixMap[be.id] = `${parts[0]}:${parts[1]}`;
          }

          for (const sale of setRows) {
            const prefix = bePrefixMap[sale.badge_edition_id];
            if (!prefix) continue;

            // Find matching set in aggregation
            for (const key of Object.keys(setAgg)) {
              const entry = setAgg[key];
              // This is a simplified match — we check if the edition's prefix matches
              const { data: edCheck } = await svc
                .from("editions")
                .select("set_name, series_number")
                .like("external_id", `${prefix}%`)
                .limit(1)
                .single();

              if (edCheck && `${edCheck.series_number}::${edCheck.set_name}` === key) {
                entry.volume += Number(sale.price_usd ?? 0);
                entry.count += 1;
                break;
              }
            }
          }

          // Find the top set
          let maxVolume = 0;
          for (const entry of Object.values(setAgg)) {
            if (entry.volume > maxVolume) {
              maxVolume = entry.volume;
              topSetName = entry.setName;
              topSetSeriesNumber = entry.seriesNumber;
              topSetVolume = entry.volume;
              topSetSalesCount = entry.count;
            }
          }
        }
      }
    }

    const topSetSeriesLabel = SERIES_LABELS[topSetSeriesNumber] ?? `Series ${topSetSeriesNumber}`;

    // STEP 5 — FMV movers
    const { data: allMovers, error: moverError } = await svc.rpc(
      "get_fmv_movers",
      {
        lookback_interval: "7 days",
        limit_count: 10,
        min_fmv: 2.0,
      }
    );

    if (moverError) {
      console.error("[portfolio-digest] Mover RPC error:", moverError.message);
    }

    const movers: FmvMover[] = (allMovers ?? []).filter(
      (m: FmvMover) => Math.abs(m.pct_change) >= 5
    );

    const fmvGainers = movers
      .filter((m) => m.pct_change > 0)
      .sort((a, b) => b.pct_change - a.pct_change)
      .slice(0, 2);

    const fmvLosers = movers
      .filter((m) => m.pct_change < 0)
      .sort((a, b) => a.pct_change - b.pct_change)
      .slice(0, 1);

    // STEP 6 — Build tweet
    const tweetText = buildDigestTweet({
      sundayLabel,
      totalSales,
      totalVolume,
      topSalePlayer,
      topSalePrice,
      specialSerialLabel,
      topSetName,
      topSetSeriesLabel,
      fmvGainers,
      fmvLosers,
    });

    console.log("[portfolio-digest] Tweet preview:\n", tweetText);
    console.log("[portfolio-digest] Character count:", tweetText.length);

    // STEP 7 — Post and log
    const tweetResult = await postTweet("rpc", tweetText);
    const tweetId = tweetResult?.data?.id ?? null;

    // Insert into posted_digests
    await svc.from("posted_digests").insert({
      digest_type: "weekly_portfolio",
      week_ending: sundayDate,
      tweet_id: tweetId,
      total_sales: totalSales,
      total_volume: totalVolume,
      top_sale_price: topSalePrice,
      top_sale_player: topSalePlayer,
      top_set_name: topSetName,
      top_series_number: topSetSeriesNumber,
      fmv_gainers: fmvGainers.map((g) => ({
        player_name: g.player_name,
        pct_change: g.pct_change,
      })),
      fmv_losers: fmvLosers.map((l) => ({
        player_name: l.player_name,
        pct_change: l.pct_change,
      })),
      special_serials: specialSerialLabel
        ? {
            player_name: topSalePlayer,
            serial_number: topSaleSerialNumber,
            circulation_count: topSaleCirculation,
            label: specialSerialLabel,
          }
        : null,
    });

    // Insert into posted_tweets
    await svc.from("posted_tweets").insert({
      brand: "rpc",
      bot_name: "portfolio-digest",
      tweet_text: tweetText,
      tweet_id: tweetId,
      media_url: null,
      metadata: {
        total_sales: totalSales,
        total_volume: totalVolume,
        top_sale_price: topSalePrice,
      },
    });

    return NextResponse.json({
      posted: true,
      tweet_id: tweetId,
      tweet_length: tweetText.length,
      total_sales: totalSales,
      total_volume: totalVolume,
      top_sale_player: topSalePlayer,
      top_set_name: topSetName,
      special_serial_label: specialSerialLabel,
    });
  } catch (e: any) {
    console.error("[portfolio-digest] Fatal error:", e.message);
    return NextResponse.json({ error: e.message, posted: false }, { status: 500 });
  }
}

/**
 * Build the tweet text, staying under 280 chars.
 */
function buildDigestTweet(opts: {
  sundayLabel: string;
  totalSales: number;
  totalVolume: number;
  topSalePlayer: string;
  topSalePrice: number;
  specialSerialLabel: string | null;
  topSetName: string;
  topSetSeriesLabel: string;
  fmvGainers: FmvMover[];
  fmvLosers: FmvMover[];
}): string {
  const {
    sundayLabel,
    totalSales,
    totalVolume,
    topSalePrice,
    specialSerialLabel,
    topSetSeriesLabel,
    fmvGainers,
    fmvLosers,
  } = opts;

  let topSalePlayer = opts.topSalePlayer;
  let topSetName = opts.topSetName;

  // Build FMV movers section
  const moverLines: string[] = [];
  for (const g of fmvGainers) {
    moverLines.push(`🟢 ${g.player_name} +${g.pct_change.toFixed(0)}%`);
  }
  for (const l of fmvLosers) {
    moverLines.push(`🔴 ${l.player_name} ${l.pct_change.toFixed(0)}%`);
  }

  const buildLines = (includeMovers: boolean) => {
    const lines: string[] = [];
    lines.push(`📊 COLLECTOR PULSE — Week of ${sundayLabel}`);
    lines.push("");
    lines.push(`💰 ${totalSales} sales · $${formatVolume(totalVolume)} volume`);
    lines.push("");

    // Top sale line
    let topSaleLine = `🏆 Top sale: ${topSalePlayer} $${topSalePrice.toFixed(0)}`;
    if (specialSerialLabel) {
      topSaleLine += ` (${specialSerialLabel})`;
    }
    lines.push(topSaleLine);

    lines.push(`📦 Hot set: ${topSetName} · ${topSetSeriesLabel}`);
    lines.push("");

    if (includeMovers && moverLines.length > 0) {
      for (const ml of moverLines) {
        lines.push(ml);
      }
      lines.push("");
    }

    lines.push("→ rip-packs-city.vercel.app/nba-top-shot/collection");
    lines.push("");
    lines.push("#NBATopShot #RipPacksCity");

    return lines.join("\n").trim();
  };

  // Try with movers first
  let tweet = buildLines(true);
  if (tweet.length <= 280) return tweet;

  // Drop FMV movers section
  tweet = buildLines(false);
  if (tweet.length <= 280) return tweet;

  // Truncate set name to 20 chars
  topSetName = topSetName.length > 20 ? topSetName.slice(0, 20) : topSetName;
  tweet = buildLines(false);
  if (tweet.length <= 280) return tweet;

  // Truncate player name to 15 chars
  topSalePlayer = topSalePlayer.length > 15 ? topSalePlayer.slice(0, 15) : topSalePlayer;
  tweet = buildLines(false);

  return tweet;
}

export async function GET() {
  return NextResponse.json({
    message: "Portfolio Digest bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
