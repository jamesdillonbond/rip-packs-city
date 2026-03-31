import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app";

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

async function runTest(name: string, fn: () => Promise<string>): Promise<TestResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, passed: true, detail, durationMs: Date.now() - start };
  } catch (e: any) {
    return { name, passed: false, detail: e.message || "Unknown error", durationMs: Date.now() - start };
  }
}

async function fetchJson(url: string, timeoutMs: number = 8000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== ("Bearer " + process.env.INGEST_SECRET_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: TestResult[] = [];

  // TEST 1: Sniper feed returns deals
  results.push(await runTest("Sniper Feed", async function() {
    const data = await fetchJson(BASE_URL + "/api/sniper-feed");
    if (!data.deals) throw new Error("No deals array in response");
    if (!Array.isArray(data.deals)) throw new Error("deals is not an array");
    const count = data.deals.length;
    if (count === 0) throw new Error("Zero deals returned");
    const first = data.deals[0];
    if (!first.playerName) throw new Error("First deal missing playerName");
    if (!first.askPrice) throw new Error("First deal missing askPrice");
    if (!first.buyUrl) throw new Error("First deal missing buyUrl");
    return count + " deals, top: " + first.playerName + " at $" + first.askPrice;
  }));

  // TEST 2: FMV API returns data
  results.push(await runTest("FMV Demo API", async function() {
    const data = await fetchJson(BASE_URL + "/api/fmv/demo");
    if (!data.samples) throw new Error("No samples in response");
    if (!Array.isArray(data.samples) || data.samples.length === 0) throw new Error("Empty samples");
    return data.samples.length + " FMV samples returned";
  }));

  // TEST 3: Supabase sales table has recent data
  results.push(await runTest("Sales Freshness", async function() {
    var twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    var result = await supabase.from("sales").select("*", { count: "exact", head: true }).gte("ingested_at", twoHoursAgo);
    if (result.error) throw new Error("Query error: " + result.error.message);
    var count = result.count || 0;
    if (count === 0) throw new Error("Zero sales in last 2 hours");
    return count + " sales ingested in last 2 hours";
  }));

  // TEST 4: FMV snapshots are fresh
  results.push(await runTest("FMV Freshness", async function() {
    var result = await supabase.from("fmv_snapshots").select("computed_at").order("computed_at", { ascending: false }).limit(1);
    if (result.error) throw new Error("Query error: " + result.error.message);
    if (!result.data || result.data.length === 0) throw new Error("No FMV snapshots");
    var age = (Date.now() - new Date(result.data[0].computed_at).getTime()) / (1000 * 60 * 60);
    if (age > 2) throw new Error("FMV is " + age.toFixed(1) + "h stale");
    return "Latest FMV: " + age.toFixed(1) + "h ago";
  }));

  // TEST 5: Cached listings exist
  results.push(await runTest("Listing Cache", async function() {
    var result = await supabase.from("cached_listings").select("*", { count: "exact", head: true });
    if (result.error) throw new Error("Query error: " + result.error.message);
    var count = result.count || 0;
    if (count === 0) throw new Error("Listing cache is empty");
    return count + " cached listings";
  }));

  // TEST 6: Wallet search works for a known wallet
  results.push(await runTest("Wallet Search", async function() {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 12000);
    var res = await fetch(BASE_URL + "/api/wallet-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "jamesdillonbond", limit: 5, offset: 0 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    if (data.error) throw new Error("API error: " + data.error);
    if (!data.rows || data.rows.length === 0) throw new Error("Zero rows returned");
    return data.rows.length + " moments, total: " + (data.summary?.totalMoments || "?");
  }));

  // TEST 7: Pack listings load
  results.push(await runTest("Pack Listings", async function() {
    var data = await fetchJson(BASE_URL + "/api/pack-listings");
    if (!data.packs && !data.listings) throw new Error("No packs or listings in response");
    var count = (data.packs || data.listings || []).length;
    return count + " pack types loaded";
  }));

  // TEST 8: Badge endpoint responds
  results.push(await runTest("Badges API", async function() {
    var data = await fetchJson(BASE_URL + "/api/badges?players=LeBron+James");
    return "Badges endpoint responded OK";
  }));

  // TEST 9: Pages return 200
  var pages = ["/nba-top-shot/sniper", "/nba-top-shot/collection", "/nba-top-shot/packs", "/nba-top-shot/badges", "/nba-top-shot/sets", "/profile"];
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    results.push(await runTest("Page: " + page, async function() {
      var controller2 = new AbortController();
      var timeout2 = setTimeout(function() { controller2.abort(); }, 8000);
      var res2 = await fetch(BASE_URL + page, { signal: controller2.signal });
      clearTimeout(timeout2);
      if (!res2.ok) throw new Error("HTTP " + res2.status);
      return "HTTP 200 in " + (Date.now() - Date.now()) + "ms";
    }));
  }

  // BUILD REPORT
  var passed = results.filter(function(r) { return r.passed; }).length;
  var failed = results.filter(function(r) { return !r.passed; }).length;
  var totalMs = results.reduce(function(sum, r) { return sum + r.durationMs; }, 0);

  var report = {
    timestamp: new Date().toISOString(),
    passed: passed,
    failed: failed,
    total: results.length,
    totalDurationMs: totalMs,
    allPassed: failed === 0,
    results: results,
  };

  console.log("SMOKE-TEST " + (failed === 0 ? "ALL PASSED" : failed + " FAILED") + " (" + passed + "/" + results.length + ")");

  return NextResponse.json(report, { status: failed > 0 ? 207 : 200 });
}
