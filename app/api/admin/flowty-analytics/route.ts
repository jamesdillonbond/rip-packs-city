import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/admin/flowty-analytics?collection=<short>&period=<grain>[&start=&end=]
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// All reads go through supabaseAdmin (service role) because the source
// materialized views and the five flowty_top_* RPCs are revoked from
// anon/authenticated and granted only to service_role.
//
// Collection short-form (matches mv_flowty_*_daily.collection): topshot,
// allday, golazos, ufc, pinnacle. The literal string "all" disables the
// collection filter.

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const VALID_COLLECTIONS = new Set(["topshot", "allday", "golazos", "ufc", "pinnacle", "all"]);
const VALID_PERIODS = new Set(["daily", "weekly", "monthly", "annual", "all"]);

const DATA_CAVEATS = [
  "UFC and Golazos buyer/seller fields are 100% Flowty NFTStorefrontV2 contract addresses (0x3cdbb3d569211ff3) and are excluded — those collections will show zero participants until the spork-scan resolver lands",
  "AllDay buyer/seller resolution is partial — known marketplace contracts are filtered but some middleware addresses may still appear in leaderboards",
];

type Bucket = "day" | "week" | "month" | "year";

type ResolvedRange = {
  start: Date;
  end: Date;
  bucket: Bucket;
};

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

function resolveRange(period: string, startStr: string | null, endStr: string | null): ResolvedRange {
  const now = new Date();
  let start: Date;
  let end: Date = now;
  let bucket: Bucket;

  switch (period) {
    case "daily":
      start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 30);
      bucket = "day";
      break;
    case "weekly":
      start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 12 * 7);
      bucket = "week";
      break;
    case "annual":
      start = new Date(now);
      start.setUTCFullYear(start.getUTCFullYear() - 5);
      bucket = "year";
      break;
    case "all":
      start = new Date("2020-01-01T00:00:00Z");
      bucket = "month";
      break;
    case "monthly":
    default:
      start = new Date(now);
      start.setUTCMonth(start.getUTCMonth() - 12);
      bucket = "month";
      break;
  }

  if (startStr && endStr) {
    const s = new Date(startStr);
    const e = new Date(endStr);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
      start = s;
      end = e;
    }
  }

  return { start, end, bucket };
}

function bucketKey(input: string | Date, bucket: Bucket): string {
  const d = typeof input === "string" ? new Date(input) : new Date(input);
  if (isNaN(d.getTime())) return "";
  if (bucket === "day") {
    return d.toISOString().slice(0, 10);
  }
  if (bucket === "week") {
    // ISO-week start (Monday) in UTC
    const day = d.getUTCDay() || 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - (day - 1));
    return monday.toISOString().slice(0, 10);
  }
  if (bucket === "month") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  // year
  return `${d.getUTCFullYear()}-01-01`;
}

function pickNum(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (v !== null && v !== undefined && v !== "") {
      const n = Number(v);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function pickStr(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

async function loadSalesRows(
  collection: string,
  startIso: string,
  endIso: string
): Promise<Record<string, unknown>[]> {
  let q = supabaseAdmin
    .from("mv_flowty_sales_daily")
    .select("*")
    .gte("day", startIso)
    .lte("day", endIso)
    .limit(100000);
  if (collection !== "all") q = q.eq("collection", collection);
  const { data, error } = await q;
  if (error) {
    console.log(`[flowty-analytics] sales query error: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function loadLoanRows(
  collection: string,
  startIso: string,
  endIso: string
): Promise<Record<string, unknown>[]> {
  let q = supabaseAdmin
    .from("mv_flowty_loans_daily")
    .select("*")
    .gte("day", startIso)
    .lte("day", endIso)
    .limit(100000);
  if (collection !== "all") q = q.eq("collection", collection);
  const { data, error } = await q;
  if (error) {
    console.log(`[flowty-analytics] loans query error: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function loadActivationRows(
  collection: string,
  startIso: string,
  endIso: string
): Promise<Record<string, unknown>[]> {
  let q = supabaseAdmin
    .from("mv_flowty_first_activations")
    .select("*")
    .gte("first_at", startIso)
    .lte("first_at", endIso)
    .limit(200000);
  if (collection !== "all") q = q.eq("collection", collection);
  const { data, error } = await q;
  if (error) {
    console.log(`[flowty-analytics] activations query error: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function loadAllTimeSales(collection: string): Promise<Record<string, unknown>[]> {
  let q = supabaseAdmin.from("mv_flowty_sales_daily").select("*").limit(200000);
  if (collection !== "all") q = q.eq("collection", collection);
  const { data, error } = await q;
  if (error) {
    console.log(`[flowty-analytics] all-time sales error: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

async function loadAllTimeLoans(collection: string): Promise<Record<string, unknown>[]> {
  let q = supabaseAdmin.from("mv_flowty_loans_daily").select("*").limit(200000);
  if (collection !== "all") q = q.eq("collection", collection);
  const { data, error } = await q;
  if (error) {
    console.log(`[flowty-analytics] all-time loans error: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

type SalesAgg = {
  txCount: number;
  grossVolumeUsd: number;
  buyersDailySum: number;
  sellersDailySum: number;
};

function aggregateSales(
  rows: Record<string, unknown>[],
  bucket: Bucket
): Array<Record<string, unknown>> {
  const map = new Map<string, SalesAgg>();
  for (const row of rows) {
    const day = pickStr(row, "day", "bucket_date", "date");
    const collection = pickStr(row, "collection") ?? "unknown";
    if (!day) continue;
    const key = `${bucketKey(day, bucket)}::${collection}`;
    const txCount = pickNum(row, "tx_count", "txCount", "tx_count_total", "sales_count");
    const grossVolumeUsd = pickNum(
      row,
      "gross_volume_usd",
      "grossVolumeUsd",
      "volume_usd",
      "total_volume_usd"
    );
    const distinctBuyers = pickNum(
      row,
      "distinct_buyers",
      "distinctBuyers",
      "buyers",
      "unique_buyers"
    );
    const distinctSellers = pickNum(
      row,
      "distinct_sellers",
      "distinctSellers",
      "sellers",
      "unique_sellers"
    );
    const cur = map.get(key) ?? {
      txCount: 0,
      grossVolumeUsd: 0,
      buyersDailySum: 0,
      sellersDailySum: 0,
    };
    cur.txCount += txCount;
    cur.grossVolumeUsd += grossVolumeUsd;
    cur.buyersDailySum += distinctBuyers;
    cur.sellersDailySum += distinctSellers;
    map.set(key, cur);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [key, agg] of map.entries()) {
    const [bucketStr, coll] = key.split("::");
    const point: Record<string, unknown> = {
      bucket: bucketStr,
      collection: coll,
      txCount: agg.txCount,
      grossVolumeUsd: round2(agg.grossVolumeUsd),
    };
    if (bucket === "day") {
      point.distinctBuyers = agg.buyersDailySum;
      point.distinctSellers = agg.sellersDailySum;
    } else {
      point.activeBuyers = agg.buyersDailySum;
      point.activeSellers = agg.sellersDailySum;
    }
    out.push(point);
  }
  out.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  return out;
}

type LoansAgg = {
  loansFunded: number;
  principalFundedUsd: number;
  lendersDailySum: number;
  borrowersDailySum: number;
};

function aggregateLoans(
  rows: Record<string, unknown>[],
  bucket: Bucket
): Array<Record<string, unknown>> {
  const map = new Map<string, LoansAgg>();
  for (const row of rows) {
    const day = pickStr(row, "day", "bucket_date", "date");
    const collection = pickStr(row, "collection") ?? "unknown";
    if (!day) continue;
    const key = `${bucketKey(day, bucket)}::${collection}`;
    const loansFunded = pickNum(
      row,
      "loans_funded",
      "loansFunded",
      "funded_count",
      "loan_count"
    );
    const principalFundedUsd = pickNum(
      row,
      "principal_funded_usd",
      "principalFundedUsd",
      "principal_usd",
      "total_principal_usd"
    );
    const activeLenders = pickNum(
      row,
      "active_lenders",
      "activeLenders",
      "distinct_lenders",
      "lenders"
    );
    const activeBorrowers = pickNum(
      row,
      "active_borrowers",
      "activeBorrowers",
      "distinct_borrowers",
      "borrowers"
    );
    const cur = map.get(key) ?? {
      loansFunded: 0,
      principalFundedUsd: 0,
      lendersDailySum: 0,
      borrowersDailySum: 0,
    };
    cur.loansFunded += loansFunded;
    cur.principalFundedUsd += principalFundedUsd;
    cur.lendersDailySum += activeLenders;
    cur.borrowersDailySum += activeBorrowers;
    map.set(key, cur);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [key, agg] of map.entries()) {
    const [bucketStr, coll] = key.split("::");
    out.push({
      bucket: bucketStr,
      collection: coll,
      loansFunded: agg.loansFunded,
      principalFundedUsd: round2(agg.principalFundedUsd),
      activeLenders: agg.lendersDailySum,
      activeBorrowers: agg.borrowersDailySum,
    });
  }
  out.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  return out;
}

function aggregateActivations(
  rows: Record<string, unknown>[],
  bucket: Bucket
): Array<Record<string, unknown>> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const ts = pickStr(row, "first_at", "firstAt", "activated_at");
    const collection = pickStr(row, "collection") ?? "unknown";
    const role = pickStr(row, "role") ?? "unknown";
    if (!ts) continue;
    const key = `${bucketKey(ts, bucket)}::${collection}::${role}`;
    const cnt = pickNum(row, "count", "n", "addresses") || 1;
    map.set(key, (map.get(key) ?? 0) + cnt);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [key, count] of map.entries()) {
    const [bucketStr, coll, role] = key.split("::");
    out.push({ bucket: bucketStr, collection: coll, role, count });
  }
  out.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizeSales(rows: Record<string, unknown>[]): { volume: number; tx: number } {
  let volume = 0;
  let tx = 0;
  for (const r of rows) {
    volume += pickNum(r, "gross_volume_usd", "volume_usd", "total_volume_usd");
    tx += pickNum(r, "tx_count", "tx_count_total", "sales_count");
  }
  return { volume: round2(volume), tx };
}

function summarizeLoans(rows: Record<string, unknown>[]): { volume: number; count: number } {
  let volume = 0;
  let count = 0;
  for (const r of rows) {
    volume += pickNum(r, "principal_funded_usd", "principal_usd", "total_principal_usd");
    count += pickNum(r, "loans_funded", "funded_count", "loan_count");
  }
  return { volume: round2(volume), count };
}

function summarizeActivations(
  rows: Record<string, unknown>[]
): { buyers: number; sellers: number; lenders: number; borrowers: number } {
  let buyers = 0,
    sellers = 0,
    lenders = 0,
    borrowers = 0;
  for (const r of rows) {
    const role = pickStr(r, "role") ?? "";
    const cnt = pickNum(r, "count", "n", "addresses") || 1;
    if (role === "buyer") buyers += cnt;
    else if (role === "seller") sellers += cnt;
    else if (role === "lender") lenders += cnt;
    else if (role === "borrower") borrowers += cnt;
  }
  return { buyers, sellers, lenders, borrowers };
}

function maxDay(rows: Record<string, unknown>[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const d = pickStr(r, "day", "bucket_date", "date");
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

async function callLeaderboard(
  rpcName: string,
  collection: string,
  startIso: string,
  endIso: string
): Promise<Array<Record<string, unknown>>> {
  const params: Record<string, unknown> = {
    p_start: startIso,
    p_end: endIso,
    p_collection: collection === "all" ? null : collection,
    p_limit: 25,
  };
  const { data, error } = await supabaseAdmin.rpc(rpcName, params);
  if (error) {
    console.log(`[flowty-analytics] ${rpcName} error: ${error.message}`);
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map((row, idx) => {
    const camelRow = camelizeRow(row as Record<string, unknown>);
    return { rank: idx + 1, ...camelRow };
  });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl;
  const collectionParam = (url.searchParams.get("collection") ?? "all").toLowerCase();
  const periodParam = (url.searchParams.get("period") ?? "monthly").toLowerCase();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");

  const collection = VALID_COLLECTIONS.has(collectionParam) ? collectionParam : "all";
  const period = VALID_PERIODS.has(periodParam) ? periodParam : "monthly";
  const range = resolveRange(period, startParam, endParam);

  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();
  const startDate = startIso.slice(0, 10);
  const endDate = endIso.slice(0, 10);

  try {
    const [
      salesRows,
      loanRows,
      activationRows,
      allTimeSales,
      allTimeLoans,
      topBuyers,
      topSellers,
      topNetMarketplace,
      topLenders,
      topBorrowers,
    ] = await Promise.all([
      loadSalesRows(collection, startDate, endDate),
      loadLoanRows(collection, startDate, endDate),
      loadActivationRows(collection, startIso, endIso),
      loadAllTimeSales(collection),
      loadAllTimeLoans(collection),
      callLeaderboard("flowty_top_buyers", collection, startIso, endIso),
      callLeaderboard("flowty_top_sellers", collection, startIso, endIso),
      callLeaderboard("flowty_top_net_marketplace", collection, startIso, endIso),
      callLeaderboard("flowty_top_lenders", collection, startIso, endIso),
      callLeaderboard("flowty_top_borrowers", collection, startIso, endIso),
    ]);

    const salesTimeseries = aggregateSales(salesRows, range.bucket);
    const loansTimeseries = aggregateLoans(loanRows, range.bucket);
    const activations = aggregateActivations(activationRows, range.bucket);

    const periodSales = summarizeSales(salesRows);
    const periodLoans = summarizeLoans(loanRows);
    const lifetimeSales = summarizeSales(allTimeSales);
    const lifetimeLoans = summarizeLoans(allTimeLoans);
    const periodFirstTime = summarizeActivations(activationRows);

    const summary = {
      salesAllTimeVolumeUsd: lifetimeSales.volume,
      salesAllTimeTxCount: lifetimeSales.tx,
      loansAllTimeVolumeUsd: lifetimeLoans.volume,
      loansAllTimeCount: lifetimeLoans.count,
      salesPeriodVolumeUsd: periodSales.volume,
      salesPeriodTxCount: periodSales.tx,
      loansPeriodVolumeUsd: periodLoans.volume,
      loansPeriodCount: periodLoans.count,
      periodFirstTimeBuyers: periodFirstTime.buyers,
      periodFirstTimeSellers: periodFirstTime.sellers,
      periodFirstTimeLenders: periodFirstTime.lenders,
      periodFirstTimeBorrowers: periodFirstTime.borrowers,
    };

    const refreshedAtSales = maxDay(allTimeSales);
    const refreshedAtLoans = maxDay(allTimeLoans);
    const refreshedAt =
      refreshedAtSales && refreshedAtLoans
        ? refreshedAtSales > refreshedAtLoans
          ? refreshedAtSales
          : refreshedAtLoans
        : refreshedAtSales ?? refreshedAtLoans;

    return NextResponse.json({
      meta: {
        collection,
        period,
        start: startIso,
        end: endIso,
        bucket: range.bucket,
      },
      refreshedAt,
      dataCaveats: DATA_CAVEATS,
      summary,
      salesTimeseries,
      loansTimeseries,
      activations,
      leaderboards: {
        topBuyers,
        topSellers,
        topNetMarketplace,
        topLenders,
        topBorrowers,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[flowty-analytics] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
