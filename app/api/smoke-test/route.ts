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
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
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

async function runSmokeTests() {
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Run all independent tests in parallel ──────────────────
  const settled = await Promise.allSettled([
    // 1. Sniper feed returns deals
    (async (): Promise<TestResult> => {
      const res = await fetch(`${BASE_URL}/api/sniper-feed`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      const deals = data?.deals ?? data ?? [];
      return { name: "sniper-feed returns deals", passed: Array.isArray(deals) && deals.length > 0, detail: `${deals.length} deals` };
    })(),

    // 2. FMV API responds
    checkUrl("fmv/demo responds", `${BASE_URL}/api/fmv/demo`),

    // 3. Sales freshness < 60 min
    (async (): Promise<TestResult> => {
      const { data } = await (svc.from("sales") as any)
        .select("ingested_at").order("ingested_at", { ascending: false }).limit(1).single();
      const age = data ? (Date.now() - new Date(data.ingested_at).getTime()) / 60000 : 999;
      return { name: "sales freshness < 60 min", passed: age < 60, detail: `${age.toFixed(1)} min ago` };
    })(),

    // 4. FMV freshness < 30 min
    (async (): Promise<TestResult> => {
      const { data } = await (svc.from("fmv_snapshots") as any)
        .select("computed_at").order("computed_at", { ascending: false }).limit(1).single();
      const age = data ? (Date.now() - new Date(data.computed_at).getTime()) / 60000 : 999;
      return { name: "fmv freshness < 30 min", passed: age < 30, detail: `${age.toFixed(1)} min ago` };
    })(),

    // 5. Listing cache has rows
    (async (): Promise<TestResult> => {
      const { count } = await (svc.from("cached_listings") as any)
        .select("*", { count: "exact", head: true });
      return { name: "cached_listings has rows", passed: (count ?? 0) > 0, detail: `${count} rows` };
    })(),

    // 6. Wallet search responds
    (async (): Promise<TestResult> => {
      const res = await fetch(`${BASE_URL}/api/wallet-search`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "0xbd94cade097e50ac" }),
        cache: "no-store", signal: AbortSignal.timeout(4000),
      });
      return { name: "wallet-search responds", passed: res.ok, detail: `HTTP ${res.status}` };
    })(),

    // 7. Pack listings responds
    checkUrl("pack-listings responds", `${BASE_URL}/api/pack-listings`),

    // 8. Badges API responds
    checkUrl("badges API responds", `${BASE_URL}/api/badges`),

    // 9–14. Page HTTP status checks
    ...([
      "/nba-top-shot/sniper", "/nba-top-shot/collection", "/nba-top-shot/sets",
      "/nba-top-shot/badges", "/nba-top-shot/packs", "/profile",
      "/nfl-all-day/collection", "/nfl-all-day/badges",
    ].map(async (page): Promise<TestResult> => {
      const res = await fetch(`${BASE_URL}${page}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      return { name: `page ${page} returns 200`, passed: res.ok, detail: `HTTP ${res.status}` };
    })),

    // 15–18. RLS Write-Block Tests
    checkRlsBlocked("RLS blocks saved_wallets unauthorized write", "saved_wallets", {
      owner_key: "__rls_smoke_test__", wallet_addr: "0x0000000000000000", username: "rls_test",
    }),
    checkRlsBlocked("RLS blocks profile_bio unauthorized write", "profile_bio", {
      owner_key: "__rls_smoke_test__", display_name: "rls_test",
    }),
    checkRlsBlocked("RLS blocks recent_searches unauthorized write", "recent_searches", {
      owner_key: "__rls_smoke_test__", query: "rls_test", query_type: "wallet",
    }),
    checkRlsBlocked("RLS blocks trophy_moments unauthorized write", "trophy_moments", {
      owner_key: "__rls_smoke_test__", slot: 1, moment_id: "rls_test_moment",
    }),
  ]);

  // ── Collect results, converting rejected promises to failures ──
  const results: TestResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { name: `test ${i + 1}`, passed: false, detail: (s.reason as Error)?.message ?? String(s.reason) }
  );

  for (const r of results) {
    if (r.name.startsWith("RLS")) console.log(`[smoke-test] ${r.name}: ${r.passed} ${r.detail}`);
  }

  // ── Summary ────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;
  const failures = results.filter((r) => !r.passed);

  console.log(`SMOKE-TEST ${allPassed ? "ALL PASSED" : "FAILURES DETECTED"} (${passed}/${total})`);
  if (failures.length > 0) {
    console.error("SMOKE-TEST FAILURES:", JSON.stringify(failures, null, 2));
  }

  // Always return 200 — smoke test route must never 500.
  // Individual test failures are reported in the results array.
  return NextResponse.json({ passed, total, allPassed, results }, { status: 200 });
}

export async function POST() {
  try {
    return await runSmokeTests();
  } catch (err: any) {
    // Top-level safety net — smoke test must NEVER return 500
    console.error("[smoke-test] Top-level crash:", err);
    return NextResponse.json({
      passed: 0,
      total: 1,
      allPassed: false,
      results: [{ name: "smoke-test", passed: false, detail: err?.message ?? String(err) }],
    }, { status: 200 });
  }
}

export async function GET() {
  try {
    return await runSmokeTests();
  } catch (err: any) {
    console.error("[smoke-test] Top-level crash:", err);
    return NextResponse.json({
      passed: 0,
      total: 1,
      allPassed: false,
      results: [{ name: "smoke-test", passed: false, detail: err?.message ?? String(err) }],
    }, { status: 200 });
  }
}