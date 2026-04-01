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

// Series number to label map
const SERIES_MAP: Record<number, string> = {
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
function getSundayDate(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 0 : day;
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - diff);
  return sunday.toISOString().slice(0, 10);
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
function formatVolume(v: number): string {
  if (v >= 1000) {
    return (v / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return v.toFixed(0);
}

/**
 * Detect special serial labels on the top sale.
 */
function detectSpecialSerial(
  serialNumber: number,
  circulationCount: number
): string | null {
  if (serialNumber === 1) return "#1";
  if (serialNumber === circulationCount) return `Last #${circulationCount}`;
  if (serialNumber === 23) return "Jordan #";
  if (serialNumber === 2026) return "Year Serial";
  if (circulationCount <= 99 && serialNumber <= 10) return `Low #${serialNumber}`;
  if (circulationCount <= 999 && serialNumber <= 25) return `Low #${serialNumber}`;
  return null;
}

/**
 * Build the tweet text, keeping under 280 chars.
 */
function buildTweet(
  sundayLabel: string,
  totalSales: number,
  totalVolume: number,
  topSalePlayer: string,
  topSalePrice: number,
  specialSerialLabel: string | null,
  topSetName: string,
  topSeriesLabel: string,
  gainers: { player_name: string; pct_change: number }[],
  loser: { player_name: string; pct_change: number } | null
): string {
  const lines: string[] = [];

  lines.push(`📊 COLLECTOR PULSE — Week of ${sundayLabel}`);
  lines.push("");
  lines.push(`💰 ${totalSales} sales · $${formatVolume(totalVolume)} volume`);
  lines.push("");

  // Top sale line
  let topSaleLine = `🏆 Top sale: ${topSalePlayer} $${topSalePrice.toFixed(0)}`;
  if (specialSerialLabel) topSaleLine += ` (${specialSerialLabel})`;
  lines.push(topSaleLine);

  // Hot set line
  lines.push(`📦 Hot set: ${topSetName} · ${topSeriesLabel}`);
  lines.push("");

  // FMV movers
  const moverLines: string[] = [];
  for (const g of gainers) {
    moverLines.push(`🟢 ${g.player_name} +${g.pct_change.toFixed(0)}%`);
  }
  if (loser) {
    moverLines.push(`🔴 ${loser.player_name} ${loser.pct_change.toFixed(0)}%`);
  }

  const footer = [
    "",
    "→ rip-packs-city.vercel.app/nba-top-shot/collection",
    "",
    "#NBATopShot #RipPacksCity",
  ];

  // Try with movers first
  if (moverLines.length > 0) {
    const full = [...lines, ...moverLines, ...footer].join("\n").trim();
    if (full.length <= 280) return full;
  }

  // Drop movers if too long
  let text = [...lines, ...footer].join("\n").trim();
  if (text.length <= 280) return text;

  // Truncate set name to 20 chars
  const truncSetName = topSetName.slice(0, 20);
  lines[5] = `📦 Hot set: ${truncSetName} · ${topSeriesLabel}`;
  text = [...lines, ...footer].join("\n").trim();
  if (text.length <= 280) return text;

  // Truncate player name to 15 chars
  const truncPlayer = topSalePlayer.slice(0, 15);
  let truncTopSale = `🏆 Top sale: ${truncPlayer} $${topSalePrice.toFixed(0)}`;
  if (specialSerialLabel) truncTopSale += ` (${specialSerialLabel})`;
  lines[4] = truncTopSale;
  text = [...lines, ...footer].join("\n").trim();

  return text;
}

// Join condition for editions + badge_editions used in sales queries
const EDITION_JOIN_SQL = `
  badge_editions!inner(
    id,
    parallel_id
  ),
  editions!inner(
    external_id,
    player_name,
    set_name,
    tier,
    series_number,
    circulation_count
  )
`;

export async function POST(req: Request) {
  // Auth gate
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) as any;

  try {
    // STEP 1 — Dedup check
    const sundayDate = getSundayDate();
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
    const { data: salesStats, error: salesError } = await svc
      .rpc("get_weekly_sales_stats", {})
      .single?.() ?? await svc
      .from("sales_2026")
      .select("price_usd")
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    // Use raw queries for aggregation
    const { data: aggData } = await svc
      .from("sales_2026")
      .select("price_usd")
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const salesRows = aggData ?? [];
    const totalSales = salesRows.length;
    const totalVolume = salesRows.reduce((sum: number, r: any) => sum + Number(r.price_usd), 0);
    const topSalePrice = salesRows.reduce((max: number, r: any) => Math.max(max, Number(r.price_usd)), 0);
    const avgSale = totalSales > 0 ? totalVolume / totalSales : 0;

    // Get top sale record with edition details
    const { data: topSaleRows } = await svc
      .from("sales_2026")
      .select(`
        price_usd,
        serial_number,
        badge_edition_id,
        badge_editions!inner(
          id,
          parallel_id
        ),
        editions!inner(
          external_id,
          player_name,
          set_name,
          tier,
          series_number,
          circulation_count
        )
      `)
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .eq("badge_editions.parallel_id", 0)
      .order("price_usd", { ascending: false })
      .limit(1);

    const topSale = topSaleRows?.[0] ?? null;
    const topSalePlayer = topSale?.editions?.player_name ?? "Unknown";
    const topSaleSetName = topSale?.editions?.set_name ?? "";
    const topSaleTier = topSale?.editions?.tier ?? "";
    const topSaleSeriesNumber = topSale?.editions?.series_number ?? 0;
    const topSaleSerialNumber = topSale?.serial_number ?? 0;
    const topSaleCirculation = topSale?.editions?.circulation_count ?? 0;

    // STEP 3 — Special serial detection
    const specialSerialLabel = detectSpecialSerial(topSaleSerialNumber, topSaleCirculation);

    // STEP 4 — Top set by volume this week
    const { data: allSalesWithEditions } = await svc
      .from("sales_2026")
      .select(`
        price_usd,
        badge_editions!inner(
          id,
          parallel_id
        ),
        editions!inner(
          external_id,
          set_name,
          series_number
        )
      `)
      .gt("sold_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .eq("badge_editions.parallel_id", 0);

    // Group by series_number + set_name to find top set
    const setMap: Record<string, { set_name: string; series_number: number; volume: number; count: number }> = {};
    for (const row of allSalesWithEditions ?? []) {
      const key = `${row.editions.series_number}|${row.editions.set_name}`;
      if (!setMap[key]) {
        setMap[key] = {
          set_name: row.editions.set_name,
          series_number: row.editions.series_number,
          volume: 0,
          count: 0,
        };
      }
      setMap[key].volume += Number(row.price_usd);
      setMap[key].count += 1;
    }

    const topSet = Object.values(setMap).sort((a, b) => b.volume - a.volume)[0] ?? null;
    const topSetName = topSet?.set_name ?? "N/A";
    const topSeriesNumber = topSet?.series_number ?? 0;
    const topSeriesLabel = SERIES_MAP[topSeriesNumber] ?? `Series ${topSeriesNumber}`;
    const topSetVolume = topSet?.volume ?? 0;
    const topSetSalesCount = topSet?.count ?? 0;

    // STEP 5 — FMV Movers
    const { data: allMovers, error: moverError } = await svc.rpc("get_fmv_movers", {
      lookback_interval: "7 days",
      limit_count: 10,
      min_fmv: 2.0,
    });

    if (moverError) {
      console.error("[portfolio-digest] Mover RPC error:", moverError.message);
    }

    const movers = (allMovers ?? []).filter(
      (m: any) => Math.abs(m.pct_change) >= 5
    );

    const gainers = movers
      .filter((m: any) => m.pct_change > 0)
      .sort((a: any, b: any) => b.pct_change - a.pct_change)
      .slice(0, 2)
      .map((m: any) => ({ player_name: m.player_name, pct_change: m.pct_change }));

    const loserArr = movers
      .filter((m: any) => m.pct_change < 0)
      .sort((a: any, b: any) => a.pct_change - b.pct_change)
      .slice(0, 1)
      .map((m: any) => ({ player_name: m.player_name, pct_change: m.pct_change }));

    const loser = loserArr[0] ?? null;

    // STEP 6 — Build tweet
    const sundayLabel = formatSundayLabel(sundayDate);
    const tweetText = buildTweet(
      sundayLabel,
      totalSales,
      totalVolume,
      topSalePlayer,
      topSalePrice,
      specialSerialLabel,
      topSetName,
      topSeriesLabel,
      gainers,
      loser
    );

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
      top_series_number: topSeriesNumber,
      fmv_gainers: gainers,
      fmv_losers: loserArr,
      special_serials: specialSerialLabel
        ? {
            serial_number: topSaleSerialNumber,
            circulation_count: topSaleCirculation,
            label: specialSerialLabel,
            player_name: topSalePlayer,
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

export async function GET() {
  return NextResponse.json({
    message:
      "Portfolio Digest bot. POST with Authorization: Bearer <token> to trigger.",
  });
}
