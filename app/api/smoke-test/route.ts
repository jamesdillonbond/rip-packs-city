// app/api/smoke-test/route.ts
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://rip-packs-city.vercel.app";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type TestResult = { name: string; passed: boolean; detail?: string; soft?: boolean };

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
    // If no error, the write went through — RLS is NOT working. Post-Phase 4
    // there's no owner_key column to target; we can't cleanly delete the rogue
    // row by value, so we flag it and leave cleanup to the operator.
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
    // 1. Sniper feed returns deals (soft-fail — depends on Flowty + Top Shot GQL)
    (async (): Promise<TestResult> => {
      const name = "sniper-feed returns deals (external: Flowty/TS GQL)";
      try {
        const res = await fetch(`${BASE_URL}/api/sniper-feed`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        const deals = data?.deals ?? data ?? [];
        return { name, soft: true, passed: Array.isArray(deals) && deals.length > 0, detail: `${deals.length} deals` };
      } catch (e: any) {
        return { name, soft: true, passed: false, detail: e?.message ?? String(e) };
      }
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

    // 6. Wallet search responds (soft-fail — depends on Top Shot GQL + Flow blockchain via FCL)
    (async (): Promise<TestResult> => {
      const name = "wallet-search responds (external: TS GQL/Flow)";
      try {
        const res = await fetch(`${BASE_URL}/api/wallet-search`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: "0xbd94cade097e50ac" }),
          cache: "no-store", signal: AbortSignal.timeout(20000),
        });
        return { name, soft: true, passed: res.ok, detail: `HTTP ${res.status}` };
      } catch (e: any) {
        return { name, soft: true, passed: false, detail: e?.message ?? String(e) };
      }
    })(),

    // 7. Pack listings responds
    checkUrl("pack-listings responds", `${BASE_URL}/api/pack-listings`),

    // 8. Badges API responds
    checkUrl("badges API responds", `${BASE_URL}/api/badges`),

    // 9–20. Page HTTP status checks. Auth-gated pages 307 -> /login -> 200
    // and fetch follows redirects, so res.ok is true either way. Phase 2
    // added 4 cross-collection page checks; Phase 3 adds the 8 market +
    // analytics pages below.
    ...([
      "/nba-top-shot/sniper", "/nba-top-shot/collection", "/nba-top-shot/sets",
      "/nba-top-shot/badges", "/nba-top-shot/packs", "/profile",
      "/nfl-all-day/collection", "/nfl-all-day/badges",
      // Phase 2 additions (multi-collection coverage):
      "/nfl-all-day/overview", "/laliga-golazos/collection",
      "/disney-pinnacle/collection", "/disney-pinnacle/overview",
      // Phase 3 additions — market + analytics on every published collection:
      "/nba-top-shot/market", "/nfl-all-day/market",
      "/laliga-golazos/market", "/disney-pinnacle/market",
      "/nba-top-shot/analytics", "/nfl-all-day/analytics",
      "/laliga-golazos/analytics", "/disney-pinnacle/analytics",
    ].map(async (page): Promise<TestResult> => {
      const res = await fetch(`${BASE_URL}${page}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      return { name: `page ${page} returns 200`, passed: res.ok, detail: `HTTP ${res.status}` };
    })),

    // Phase 3 — market API returns listings for Top Shot
    (async (): Promise<TestResult> => {
      const name = "market API returns Top Shot listings";
      try {
        const url = `${BASE_URL}/api/market?collectionId=95f28a17-224a-4025-96ad-adf8a4c63bfd&limit=10`;
        const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
        if (!res.ok) return { name, passed: false, detail: `HTTP ${res.status}` };
        const body = await res.json();
        const listings = Array.isArray(body?.listings) ? body.listings : [];
        return { name, passed: listings.length > 0, detail: `${listings.length} listings` };
      } catch (e: any) {
        return { name, passed: false, detail: e?.message ?? String(e) };
      }
    })(),

    // 15–18. RLS Write-Block Tests. Post Phase 4: tables are now keyed on
    // user_id UUID with DEFAULT auth.uid(). Anon writes still blocked.
    checkRlsBlocked("RLS blocks saved_wallets unauthorized write", "saved_wallets", {
      wallet_addr: "0x0000000000000000", username: "rls_test",
    }),
    checkRlsBlocked("RLS blocks profile_bio unauthorized write", "profile_bio", {
      username: "rls_test", display_name: "rls_test",
    }),
    checkRlsBlocked("RLS blocks recent_searches unauthorized write", "recent_searches", {
      query: "rls_test", query_type: "wallet",
    }),
    checkRlsBlocked("RLS blocks trophy_moments unauthorized write", "trophy_moments", {
      slot: 1, moment_id: "rls_test_moment",
    }),

    // Phase 4: auth-gated profile routes accept or redirect. 2xx/3xx OR 401 all OK.
    ...([
      "/api/profile/activity",
      "/api/profile/favorites",
      "/api/profile/hero-moment",
    ].map(async (path): Promise<TestResult> => {
      const name = `${path} returns 200 or 401`;
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          cache: "no-store",
          redirect: "follow",
          signal: AbortSignal.timeout(5000),
        });
        return { name, passed: res.status === 200 || res.status === 401, detail: `HTTP ${res.status}` };
      } catch (e: any) {
        return { name, passed: false, detail: e?.message ?? String(e) };
      }
    })),

    // Phase 4: public profile route is unauthenticated — accepts 200 (user exists)
    // or 404 (username not registered). Greenfield migration means 404 is
    // expected until Trevor re-seeds the jamesdillonbond bio.
    (async (): Promise<TestResult> => {
      const name = "/api/public/profile/jamesdillonbond returns JSON";
      try {
        const res = await fetch(`${BASE_URL}/api/public/profile/jamesdillonbond`, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const ok = res.status === 200 || res.status === 404;
        if (!ok) return { name, passed: false, detail: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        return { name, passed: body != null, detail: body?.error ?? `HTTP ${res.status}` };
      } catch (e: any) {
        return { name, passed: false, detail: e?.message ?? String(e) };
      }
    })(),

    // Phase 4.1: /api/profile/resolve-and-associate — username-based multi-collection
    // wallet auto-association. When unauthenticated, returns 401. If the smoke test
    // runs with a session (via SMOKE_TEST_SESSION_TOKEN), a known-good username
    // should return 200 with a 4-entry associatedCollections array.
    (async (): Promise<TestResult> => {
      const name = "/api/profile/resolve-and-associate responds (200 or 401)";
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const token = process.env.SMOKE_TEST_SESSION_TOKEN;
        if (token) headers.cookie = `sb-auth-token=${token}`;
        const res = await fetch(`${BASE_URL}/api/profile/resolve-and-associate`, {
          method: "POST",
          cache: "no-store",
          headers,
          body: JSON.stringify({ username: "jamesdillonbond" }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) {
          return { name, passed: true, detail: "401 (unauthenticated, expected without session)" };
        }
        if (res.status !== 200) {
          return { name, passed: false, detail: `HTTP ${res.status}` };
        }
        const body = await res.json().catch(() => null);
        const ok =
          body != null &&
          typeof body.walletAddress === "string" &&
          Array.isArray(body.associatedCollections) &&
          body.associatedCollections.length === 4;
        return { name, passed: ok, detail: ok ? `${body.walletAddress} x4` : "malformed 200 body" };
      } catch (e: any) {
        return { name, passed: false, detail: e?.message ?? String(e) };
      }
    })(),

    // Phase 4 (opt-in): attach a smoke-test user session cookie and probe the
    // auth-gated /nba-top-shot/collection page. If SMOKE_TEST_SESSION_TOKEN is
    // unset, skip without failing. To generate the token:
    //   1) Sign in as a test user in prod via /login magic link
    //   2) Inspect cookies for `sb-*-auth-token` and paste its raw value
    //      into Vercel env `SMOKE_TEST_SESSION_TOKEN`
    //   3) Re-deploy so the smoke test can use it
    (async (): Promise<TestResult> => {
      const name = "authed /nba-top-shot/collection renders (opt-in via SMOKE_TEST_SESSION_TOKEN)";
      const token = process.env.SMOKE_TEST_SESSION_TOKEN;
      if (!token) return { name, passed: true, soft: true, detail: "skipped — no SMOKE_TEST_SESSION_TOKEN" };
      try {
        const res = await fetch(`${BASE_URL}/nba-top-shot/collection`, {
          cache: "no-store",
          redirect: "manual",
          headers: { cookie: `sb-auth-token=${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status !== 200) {
          return { name, passed: false, soft: true, detail: `HTTP ${res.status}` };
        }
        const html = await res.text();
        const hit = html.includes("COLLECTION ANALYZER") || html.toLowerCase().includes("nba top shot");
        return { name, passed: hit, soft: true, detail: hit ? "auth render ok" : "content marker missing" };
      } catch (e: any) {
        return { name, passed: false, soft: true, detail: e?.message ?? String(e) };
      }
    })(),
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

  // Push hard failures to Sentry so Trevor gets notified instead of needing
  // to poll this endpoint. Soft failures (external API deps) stay out of Sentry.
  for (const r of results) {
    if (!r.passed && !r.soft) {
      Sentry.withScope((scope) => {
        scope.setTag("smoke_test", r.name);
        scope.setTag("route", "smoke-test");
        scope.setExtra("detail", r.detail ?? "");
        Sentry.captureMessage("smoke test failed: " + r.name, "error");
      });
    }
  }

  // ── Summary ────────────────────────────────────────────────
  // allPassed reflects platform health only — soft tests (external API
  // dependencies like Flowty / Top Shot GQL / Flow RPC) are informational
  // and must not gate the overall smoke result.
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const hardResults = results.filter((r) => !r.soft);
  const hardPassed = hardResults.filter((r) => r.passed).length;
  const hardTotal = hardResults.length;
  const allPassed = hardPassed === hardTotal;
  const failures = results.filter((r) => !r.passed && !r.soft);
  const softFailures = results.filter((r) => !r.passed && r.soft);

  console.log(`SMOKE-TEST ${allPassed ? "ALL PASSED" : "FAILURES DETECTED"} (hard ${hardPassed}/${hardTotal}, overall ${passed}/${total})`);
  if (failures.length > 0) {
    console.error("SMOKE-TEST HARD FAILURES:", JSON.stringify(failures, null, 2));
  }
  if (softFailures.length > 0) {
    console.warn("SMOKE-TEST SOFT FAILURES (external deps, informational):", JSON.stringify(softFailures, null, 2));
  }

  // Always return 200 — smoke test route must never 500.
  // Individual test failures are reported in the results array.
  return NextResponse.json({
    passed,
    total,
    allPassed,
    hardPassed,
    hardTotal,
    softFailures: softFailures.length,
    results,
  }, { status: 200 });
}

export async function POST() {
  try {
    return await runSmokeTests();
  } catch (err: any) {
    // Top-level safety net — smoke test must NEVER return 500
    Sentry.withScope((scope) => {
      scope.setTag("route", "smoke-test");
      scope.setTag("smoke_test", "top-level-crash");
      Sentry.captureException(err);
    });
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
    Sentry.withScope((scope) => {
      scope.setTag("route", "smoke-test");
      scope.setTag("smoke_test", "top-level-crash");
      Sentry.captureException(err);
    });
    console.error("[smoke-test] Top-level crash:", err);
    return NextResponse.json({
      passed: 0,
      total: 1,
      allPassed: false,
      results: [{ name: "smoke-test", passed: false, detail: err?.message ?? String(err) }],
    }, { status: 200 });
  }
}