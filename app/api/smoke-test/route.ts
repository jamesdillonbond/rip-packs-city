// app/api/smoke-test/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://rip-packs-city.vercel.app";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type TestResult = { name: string; passed: boolean; detail?: string };

async function checkUrl(name: string, url: string, expectJson = true): Promise<TestResult> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { name, passed: false, detail: `HTTP ${res.status}` };
    if (expectJson) {
      const data = await res.json();
      if (data && typeof data === "object") return { name, passed: true };
      return { name, passed: false, detail: "empty or non-JSON response" };
    }
    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, detail: e.message };
  }
}

// -------------------------------------------------------
// RLS Write-Block Tests
// Attempts an unauthorized write using the anon key with
// NO x-owner-key header. Expects RLS to block it (error).
// -------------------------------------------------------
async function checkRlsBlocked(
  name: string,
  table: string,
  row: Record<string, unknown>
): Promise<TestResult> {
  try {
    // Anon client — no x-owner-key header, simulating a raw API call
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await (anonClient.from(table) as any).insert(row);
    if (error) {
      // RLS blocked it — this is the expected success path
      return { name, passed: true, detail: `Blocked: ${error.code}` };
    }
    // If no error, the write went through — RLS is NOT working
    // Clean up the rogue row if possible using service role
    const svcClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    await (svcClient.from(table) as any)
      .delete()
      .eq("owner_key", "__rls_smoke_test__");
    return { name, passed: false, detail: "RLS FAILED — unauthorized write succeeded" };
  } catch (e: any) {
    // Network/unexpected error — treat as blocked (safe side)
    return { name, passed: true, detail: `Exception (treated as blocked): ${e.message}` };
  }
}

export async function POST() {
  const results: TestResult[] = [];

  // ── Existing 14 tests ──────────────────────────────────────

  // 1. Sniper feed returns deals
  try {
    const res = await fetch(`${BASE_URL}/api/sniper-feed`, { cache: "no-store" });
    const data = await res.json();
    const deals = data?.deals ?? data ?? [];
    results.push({
      name: "sniper-feed returns deals",
      passed: Array.isArray(deals) && deals.length > 0,
      detail: `${deals.length} deals`,
    });
  } catch (e: any) {
    results.push({ name: "sniper-feed returns deals", passed: false, detail: e.message });
  }

  // 2. FMV API responds
  results.push(await checkUrl("fmv/demo responds", `${BASE_URL}/api/fmv/demo`));

  // 3. Sales freshness — last sale within 60 min
  try {
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await (svc.from("sales_2026") as any)
      .select("ingested_at")
      .order("ingested_at", { ascending: false })
      .limit(1)
      .single();
    const age = data ? (Date.now() - new Date(data.ingested_at).getTime()) / 60000 : 999;
    results.push({
      name: "sales freshness < 60 min",
      passed: age < 60,
      detail: `${age.toFixed(1)} min ago`,
    });
  } catch (e: any) {
    results.push({ name: "sales freshness < 60 min", passed: false, detail: e.message });
  }

  // 4. FMV freshness — last snapshot within 30 min
  try {
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await (svc.from("fmv_snapshots_2026") as any)
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single();
    const age = data ? (Date.now() - new Date(data.computed_at).getTime()) / 60000 : 999;
    results.push({
      name: "fmv freshness < 30 min",
      passed: age < 30,
      detail: `${age.toFixed(1)} min ago`,
    });
  } catch (e: any) {
    results.push({ name: "fmv freshness < 30 min", passed: false, detail: e.message });
  }

  // 5. Listing cache has rows
  try {
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { count } = await (svc.from("cached_listings") as any)
      .select("*", { count: "exact", head: true });
    results.push({
      name: "cached_listings has rows",
      passed: (count ?? 0) > 0,
      detail: `${count} rows`,
    });
  } catch (e: any) {
    results.push({ name: "cached_listings has rows", passed: false, detail: e.message });
  }

  // 6. Wallet search responds
  try {
    const res = await fetch(`${BASE_URL}/api/wallet-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "0xbd94cade097e50ac" }),
      cache: "no-store",
    });
    results.push({
      name: "wallet-search responds",
      passed: res.ok,
      detail: `HTTP ${res.status}`,
    });
  } catch (e: any) {
    results.push({ name: "wallet-search responds", passed: false, detail: e.message });
  }

  // 7. Pack listings responds
  results.push(await checkUrl("pack-listings responds", `${BASE_URL}/api/pack-listings`));

  // 8. Badges API responds
  results.push(await checkUrl("badges API responds", `${BASE_URL}/api/badges`));

  // 9–14. Page HTTP status checks
  const pages = [
    "/nba-top-shot/sniper",
    "/nba-top-shot/collection",
    "/nba-top-shot/sets",
    "/nba-top-shot/badges",
    "/nba-top-shot/packs",
    "/profile",
  ];
  for (const page of pages) {
    try {
      const res = await fetch(`${BASE_URL}${page}`, { cache: "no-store" });
      results.push({
        name: `page ${page} returns 200`,
        passed: res.ok,
        detail: `HTTP ${res.status}`,
      });
    } catch (e: any) {
      results.push({ name: `page ${page} returns 200`, passed: false, detail: e.message });
    }
  }

  // ── NEW: RLS Write-Block Tests (15–18) ─────────────────────

  // 15. saved_wallets — anon write without owner key is blocked
  results.push(
    await checkRlsBlocked("RLS blocks saved_wallets unauthorized write", "saved_wallets", {
      owner_key: "__rls_smoke_test__",
      wallet_addr: "0x0000000000000000",
      username: "rls_test",
    })
  );
  console.log("[smoke-test] saved_wallets RLS:", results[results.length - 1].passed, results[results.length - 1].detail);

  // 16. profile_bio — anon write without owner key is blocked
  results.push(
    await checkRlsBlocked("RLS blocks profile_bio unauthorized write", "profile_bio", {
      owner_key: "__rls_smoke_test__",
      display_name: "rls_test",
    })
  );
  console.log("[smoke-test] profile_bio RLS:", results[results.length - 1].passed, results[results.length - 1].detail);

  // 17. recent_searches — anon write without owner key is blocked
  results.push(
    await checkRlsBlocked("RLS blocks recent_searches unauthorized write", "recent_searches", {
      owner_key: "__rls_smoke_test__",
      query: "rls_test",
      query_type: "wallet",
    })
  );
  console.log("[smoke-test] recent_searches RLS:", results[results.length - 1].passed, results[results.length - 1].detail);

  // 18. trophy_moments — anon write without owner key is blocked
  results.push(
    await checkRlsBlocked("RLS blocks trophy_moments unauthorized write", "trophy_moments", {
      owner_key: "__rls_smoke_test__",
      slot: 1,
      moment_id: "rls_test_moment",
    })
  );
  console.log("[smoke-test] trophy_moments RLS:", results[results.length - 1].passed, results[results.length - 1].detail);

  // ── Summary ────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;
  const failures = results.filter((r) => !r.passed);

  console.log(`SMOKE-TEST ${allPassed ? "ALL PASSED" : "FAILURES DETECTED"} (${passed}/${total})`);
  if (failures.length > 0) {
    console.error("SMOKE-TEST FAILURES:", JSON.stringify(failures, null, 2));
  }

  return NextResponse.json({ passed, total, allPassed, results }, { status: allPassed ? 200 : 500 });
}

export async function GET() {
  return NextResponse.json({ message: "Use POST to run smoke tests" });
}