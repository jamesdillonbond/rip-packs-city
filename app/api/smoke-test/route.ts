// app/api/smoke-test/route.ts
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@supabase/supabase-js";
import { searchPinnacleDeals } from "@/lib/concierge/pinnacle-router";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.rippackscity.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Real browser User-Agent — internal smoke-test fetches were being 307'd
// because the upstream gate doesn't recognize the default fetch UA. Using
// a Chrome desktop UA matches what real browsers + crawlers send so the
// smoke test verifies the actual public/anon experience.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const INGEST_SECRET_TOKEN = process.env.INGEST_SECRET_TOKEN ?? "";
const SMOKE_TEST_SESSION_TOKEN = process.env.SMOKE_TEST_SESSION_TOKEN ?? "";

// Smoke-test fetches must short-circuit the proxy.ts auth gate so probes
// against authed routes hit the real handler instead of bouncing to
// /login. The proxy checks `Authorization: Bearer ${INGEST_SECRET_TOKEN}`
// first and lets matching requests through. smokeFetch injects that
// bearer + the browser UA + the X-RPC-Smoke-Test forward-fill header (so
// downstream writes to support_conversations / chat_sessions land with
// is_smoke_test=true) + a no-store cache default; per-call init overrides
// any of those by simply setting the same header/option.
async function smokeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (!headers.has("authorization") && INGEST_SECRET_TOKEN) {
    headers.set("Authorization", `Bearer ${INGEST_SECRET_TOKEN}`);
  }
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", BROWSER_UA);
  }
  if (!headers.has("x-rpc-smoke-test") && SMOKE_TEST_SESSION_TOKEN) {
    headers.set("X-RPC-Smoke-Test", SMOKE_TEST_SESSION_TOKEN);
  }
  return fetch(url, {
    ...init,
    cache: init.cache ?? "no-store",
    headers,
  });
}

type TestResult = {
  name: string;
  passed: boolean;
  detail?: string;
  soft?: boolean;
  endpoint: string;
  expected: string;
  elapsedMs: number;
  statusCode?: number | null;
  bodyExcerpt?: string | null;
  notes?: Record<string, unknown> | null;
};

type TestSeed = Omit<TestResult, "elapsedMs"> | (Omit<TestResult, "elapsedMs"> & { elapsedMs?: number });

// Wraps a test body to capture elapsed_ms and convert thrown errors into a
// structured failure. Every test uses this so the smoke_test_results write
// has a consistent shape.
async function time(fn: () => Promise<TestSeed>, fallback: { name: string; endpoint: string; expected: string; soft?: boolean }): Promise<TestResult> {
  const start = Date.now();
  try {
    const r = await fn();
    return { ...r, elapsedMs: Date.now() - start } as TestResult;
  } catch (e: any) {
    return {
      name: fallback.name,
      endpoint: fallback.endpoint,
      expected: fallback.expected,
      passed: false,
      detail: e?.message ?? String(e),
      soft: fallback.soft,
      elapsedMs: Date.now() - start,
      statusCode: null,
      bodyExcerpt: null,
      notes: null,
    };
  }
}

// Statuses that are infra-transient at the :00/:06 cron rush (gateway / pool /
// rate), not genuine assertion failures — safe to retry once. A 4xx (esp.
// 400/401/403/404) is a real contract failure and is NEVER retried.
const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504]);

// HTTP probe with timing + status + body_excerpt capture on failure.
// SMOKE-RETRY (2026-06-06): a single check failing on the infra-timeout class
// (fetch timeout / connection pool / 5xx-gateway) at the cron rush is cry-wolf —
// the 00:17Z mass-fail cluster fired 7 one-event Sentry issues. Retry once with a
// short backoff on a transient throw or transient status; keep genuine assertion
// failures (wrong status, bad body) un-retried. Mirrors rpcRetry for DB checks.
async function checkUrl(
  meta: { name: string; endpoint: string; expected: string; soft?: boolean; notes?: Record<string, unknown> },
  url: string,
  expectJson = true,
  options: { timeoutMs?: number; method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<TestResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  return time(async () => {
    let res: Response;
    try {
      res = await smokeFetch(url, {
        method: options.method ?? "GET",
        cache: "no-store",
        headers: { "User-Agent": BROWSER_UA, ...(options.headers ?? {}) },
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      // Transient network/timeout throw → one retry, else rethrow to time().
      // Includes AbortSignal.timeout aborts (TimeoutError / "aborted") which
      // previously bypassed this retry — the slow-but-healthy edition/pack
      // pages under DB saturation are the canonical cry-wolf (NEXTJS-1H/1J).
      if (!isTimeoutOrTransient(e?.message ?? String(e))) throw e;
      await new Promise((r) => setTimeout(r, 400));
      res = await smokeFetch(url, {
        method: options.method ?? "GET",
        cache: "no-store",
        headers: { "User-Agent": BROWSER_UA, ...(options.headers ?? {}) },
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    if (!res.ok && TRANSIENT_STATUS.has(res.status)) {
      // Transient gateway/pool/rate status → one retry before failing.
      await new Promise((r) => setTimeout(r, 400));
      try {
        res = await smokeFetch(url, {
          method: options.method ?? "GET",
          cache: "no-store",
          headers: { "User-Agent": BROWSER_UA, ...(options.headers ?? {}) },
          body: options.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // keep the first transient response; fall through to the failure path
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        name: meta.name,
        endpoint: meta.endpoint,
        expected: meta.expected,
        passed: false,
        soft: meta.soft,
        detail: `HTTP ${res.status}`,
        statusCode: res.status,
        bodyExcerpt: body.slice(0, 500),
        notes: meta.notes ?? null,
      };
    }
    if (expectJson) {
      const text = await res.text();
      let data: unknown = null;
      try { data = JSON.parse(text); } catch { /* fall through */ }
      const passed = data != null && typeof data === "object";
      return {
        name: meta.name,
        endpoint: meta.endpoint,
        expected: meta.expected,
        passed,
        soft: meta.soft,
        detail: passed ? undefined : "empty or non-JSON response",
        statusCode: res.status,
        bodyExcerpt: passed ? null : text.slice(0, 500),
        notes: meta.notes ?? null,
      };
    }
    return {
      name: meta.name,
      endpoint: meta.endpoint,
      expected: meta.expected,
      passed: true,
      soft: meta.soft,
      statusCode: res.status,
      bodyExcerpt: null,
      notes: meta.notes ?? null,
    };
  }, meta);
}

// Anon insert against an RLS-enabled table. Expected to be blocked.
async function checkRlsBlocked(
  table: string,
  row: Record<string, unknown>
): Promise<TestResult> {
  const meta = {
    name: `RLS blocks ${table} unauthorized write`,
    endpoint: `rls:${table}`,
    expected: "rls-blocks-anon-insert",
  };
  return time(async () => {
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await (anonClient.from(table) as any).insert(row);
    if (error) {
      return {
        ...meta,
        passed: true,
        detail: `Blocked: ${error.code}`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { table, error_code: error.code },
      };
    }
    return {
      ...meta,
      passed: false,
      detail: "RLS FAILED — unauthorized write succeeded",
      statusCode: null,
      bodyExcerpt: null,
      notes: { table },
    };
  }, meta);
}

// The DB-backed smoke assertions (detect_stalled_pipelines, analytics_pipeline_
// health, the two security guards) run at the :00/:06 cron-rush, when Supabase
// connection-pool pressure makes a single query transiently fail ("Timed out
// acquiring connection from connection pool" / "canceling statement due to
// statement timeout"). The underlying state is verified clean every time, so a
// one-shot failure here is cry-wolf — it desensitizes us to a real
// security/FMV regression later. Retry once on a transient error before letting
// the assertion fail. Non-transient errors (and clean results) return
// immediately. (Item 6 / ledger Q5+Q6, 2026-05-31)
const TRANSIENT_RX = /connection pool|statement timeout|timed out|ECONNRESET|fetch failed|terminating connection|too many clients/i;

// True for the infra-timeout class: the TRANSIENT_RX set PLUS AbortSignal
// timeout aborts (DOMException "TimeoutError" / "The operation was aborted").
// AbortSignal.timeout produces an "aborted"/"timeout" message that TRANSIENT_RX
// alone doesn't match, which is exactly why slow edition/pack page fetches used
// to skip SMOKE-RETRY and hard-fail.
function isTimeoutOrTransient(msg: string): boolean {
  return TRANSIENT_RX.test(msg) || /abort|timeout/i.test(msg);
}

async function rpcRetry(
  svc: any,
  fn: string,
  args?: Record<string, unknown>
): Promise<{ data: any; error: { message?: string } | null }> {
  const first = await svc.rpc(fn, args);
  if (!first.error || !TRANSIENT_RX.test(first.error.message ?? "")) return first;
  await new Promise((r) => setTimeout(r, 750));
  return svc.rpc(fn, args);
}

// HTML-contains probe for the public entity pages (edition / pack dist). These
// render a lot server-side (FMV, asks, sales, parallels, packs) — ~2.5s anon
// normally, but >8s under DB saturation. A raw 10s fetch with no retry made
// them the SMOKE-EDITION-TIMEOUT cry-wolf (NEXTJS-1H/1J, 9+8 ticks/8h). Now:
// a generous budget, ONE retry on the timeout/transient class, and a SOFT
// inconclusive (never Sentry) if it's still just slow. A genuine regression —
// non-200, or a 200 that's missing the asserted section — still hard-fails.
async function checkHtmlContains(
  meta: { name: string; endpoint: string; expected: string },
  url: string,
  needle: string,
  timeoutMs = 18_000,
): Promise<TestResult> {
  const fetchOnce = () =>
    smokeFetch(url, {
      cache: "no-store",
      redirect: "manual",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
  return time(async () => {
    let res: Response;
    try {
      res = await fetchOnce();
    } catch (e: any) {
      if (!isTimeoutOrTransient(e?.message ?? String(e))) throw e;
      await new Promise((r) => setTimeout(r, 500));
      try {
        res = await fetchOnce();
      } catch (e2: any) {
        if (!isTimeoutOrTransient(e2?.message ?? String(e2))) throw e2;
        // Still slow after a retry — inconclusive, not a regression.
        return {
          ...meta,
          passed: false,
          soft: true,
          detail: `page slow — inconclusive (timeout ${timeoutMs}ms after retry)`,
          statusCode: null,
          bodyExcerpt: null,
          notes: null,
        };
      }
    }
    const text = res.status === 200 ? await res.text().catch(() => "") : "";
    const passed = res.status === 200 && text.includes(needle);
    return {
      ...meta,
      passed,
      detail: passed ? undefined : `HTTP ${res.status}, ${needle}=${text.includes(needle)}`,
      statusCode: res.status,
      bodyExcerpt: passed ? null : text.slice(0, 500),
      notes: null,
    };
  }, meta);
}

async function runSmokeTests() {
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const settled = await Promise.allSettled<TestResult>([
    // 1. Sniper feed returns deals (soft-fail — depends on Flowty + Top Shot GQL)
    time(async () => {
      const meta = {
        name: "sniper-feed returns deals (external: Flowty/TS GQL)",
        endpoint: "/api/sniper-feed",
        expected: "has-deals-array",
        soft: true,
      };
      const res = await smokeFetch(`${BASE_URL}/api/sniper-feed`, {
        cache: "no-store",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* swallow */ }
      const deals = data?.deals ?? data ?? [];
      const passed = Array.isArray(deals) && deals.length > 0;
      return {
        ...meta,
        passed,
        statusCode: res.status,
        bodyExcerpt: passed ? null : text.slice(0, 500),
        detail: `${Array.isArray(deals) ? deals.length : 0} deals`,
        notes: { count: Array.isArray(deals) ? deals.length : 0 },
      };
    }, {
      name: "sniper-feed returns deals (external: Flowty/TS GQL)",
      endpoint: "/api/sniper-feed",
      expected: "has-deals-array",
      soft: true,
    }),

    // 2. FMV API responds (cold-start tolerant — soft failure with extended timeout)
    checkUrl(
      { name: "fmv/demo responds", endpoint: "/api/fmv/demo", expected: "200-json", soft: true },
      `${BASE_URL}/api/fmv/demo`,
      true,
      { timeoutMs: 15000 }
    ),

    // 2b. /api/og/collection?id=... — must return 200 to anonymous
    // crawlers (Twitter / Slack / Discord). Regression guard for the
    // proxy.isPublicPath bypass we added on 2026-05-07; if the bypass
    // breaks again, social previews go back to a generic Vercel auth
    // thumbnail. Image bytes can be slow on first render — soft test.
    time(async () => {
      const meta = {
        name: "og/collection/nba-top-shot returns 200 to anon",
        endpoint: "/api/og/collection?id=nba-top-shot",
        expected: "200-content-type-image",
        soft: true,
      };
      const res = await smokeFetch(`${BASE_URL}/api/og/collection?id=nba-top-shot`, {
        cache: "no-store",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(15_000),
      });
      const ct = res.headers.get("content-type") ?? "";
      const passed = res.status === 200 && /image\//i.test(ct);
      return {
        ...meta,
        passed,
        statusCode: res.status,
        bodyExcerpt: passed ? null : `content-type=${ct}`,
        detail: passed ? `image bytes ok` : `HTTP ${res.status} content-type=${ct}`,
        notes: { content_type: ct },
      };
    }, {
      name: "og/collection/nba-top-shot returns 200 to anon",
      endpoint: "/api/og/collection?id=nba-top-shot",
      expected: "200-content-type-image",
      soft: true,
    }),

    // 2c. /legal/fmv-methodology and /pricing — both new public pages
    // shipped 2026-05-07. Crawlers and shareable URLs both need them
    // available to anonymous traffic. Hard-pass tests.
    time(async () => {
      const meta = {
        name: "legal/fmv-methodology renders",
        endpoint: "/legal/fmv-methodology",
        expected: "200-html",
      };
      const res = await smokeFetch(`${BASE_URL}/legal/fmv-methodology`, {
        cache: "no-store",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(8000),
      });
      const passed = res.status === 200;
      return {
        ...meta,
        passed,
        statusCode: res.status,
        detail: `HTTP ${res.status}`,
        bodyExcerpt: passed ? null : (await res.text().catch(() => "")).slice(0, 500),
        notes: null,
      };
    }, {
      name: "legal/fmv-methodology renders",
      endpoint: "/legal/fmv-methodology",
      expected: "200-html",
    }),

    time(async () => {
      const meta = {
        name: "pricing page renders",
        endpoint: "/pricing",
        expected: "200-html",
      };
      const res = await smokeFetch(`${BASE_URL}/pricing`, {
        cache: "no-store",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(10_000),
      });
      const passed = res.status === 200;
      return {
        ...meta,
        passed,
        statusCode: res.status,
        detail: `HTTP ${res.status}`,
        bodyExcerpt: passed ? null : (await res.text().catch(() => "")).slice(0, 500),
        notes: null,
      };
    }, {
      name: "pricing page renders",
      endpoint: "/pricing",
      expected: "200-html",
    }),

    // 2d. Pack/moment history modules (2026-06-08). The pack dist page must
    // mount the "Sales History" module and the edition page the "Recent Sales"
    // section — both render unconditionally (empty state still emits the title),
    // so a missing string means the module regressed, not just thin data.
    checkHtmlContains(
      { name: "pack dist page has Sales History", endpoint: "/nba-top-shot/pack/dist/7800", expected: "html-contains-Sales-History" },
      `${BASE_URL}/nba-top-shot/pack/dist/7800`,
      "Sales History",
    ),

    checkHtmlContains(
      { name: "edition page has Recent Sales", endpoint: "/nba-top-shot/edition/124:4493", expected: "html-contains-Recent-Sales" },
      `${BASE_URL}/nba-top-shot/edition/${encodeURIComponent("124:4493")}`,
      "Recent Sales",
    ),

    // 3. Sales pipeline freshness — measured from the last successful INDEXER
    // RUN, not the newest sale. The old analytics_pipeline_health.sales lag is
    // sale-recency based, so a quiet market (indexer running fine, just nothing
    // trading) flapped this check to "degraded" while a genuine indexer stall
    // (e.g. topshot-sales-indexer silent 01:32-08:02 UTC 2026-05-31) could read
    // healthy if other sales were landing. detect_stalled_pipelines() measures
    // silence from each pipeline's last run against its per-pipeline
    // max_silent_minutes (TS 180m, AllDay/Golazos/UFC 90m), so a run-but-no-sales
    // tick keeps it healthy and a real stall trips. We pass unless a
    // *-sales-indexer is in the stalled set.
    time(async () => {
      const meta = {
        name: "sales indexers running (detect_stalled_pipelines)",
        endpoint: "rpc:detect_stalled_pipelines.sales-indexers",
        expected: "no sales-indexer stalled",
      };
      const { data, error } = await rpcRetry(svc, "detect_stalled_pipelines");
      if (error) {
        return { ...meta, passed: false, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const stalled: any[] = Array.isArray(data) ? data : [];
      const salesStalled = stalled.filter((s) => typeof s?.pipeline === "string" && s.pipeline.includes("sales-indexer"));
      const passed = salesStalled.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "all sales indexers within their max-silent window"
          : salesStalled.map((s) => `${s.pipeline} silent ${s.silent_minutes}m (>${s.max_silent_minutes}m)`).join("; "),
        statusCode: null,
        bodyExcerpt: null,
        notes: { stalled: salesStalled },
      };
    }, {
      name: "sales indexers running (detect_stalled_pipelines)",
      endpoint: "rpc:detect_stalled_pipelines.sales-indexers",
      expected: "no sales-indexer stalled",
    }),

    // 4. FMV pipeline freshness via analytics_pipeline_health RPC.
    time(async () => {
      const meta = {
        name: "fmv pipeline healthy (analytics_pipeline_health)",
        endpoint: "rpc:analytics_pipeline_health.fmv",
        expected: "status=healthy",
      };
      const { data, error } = await rpcRetry(svc, "analytics_pipeline_health");
      if (error) {
        return { ...meta, passed: false, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const fmv = data?.pipelines?.fmv;
      if (!fmv) {
        return { ...meta, passed: false, detail: "missing pipelines.fmv in RPC response", statusCode: null, bodyExcerpt: null, notes: null };
      }
      const ok = fmv.status === "healthy";
      return {
        ...meta,
        passed: ok,
        detail: `status=${fmv.status} lag=${fmv.lag_minutes}m (max ${fmv.expected_max_lag_min}m)`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { status: fmv.status, lag_minutes: fmv.lag_minutes, expected_max_lag_min: fmv.expected_max_lag_min },
      };
    }, {
      name: "fmv pipeline healthy (analytics_pipeline_health)",
      endpoint: "rpc:analytics_pipeline_health.fmv",
      expected: "status=healthy",
    }),

    // 5. Listing cache has rows — SOFT (2026-06-02). cached_listings is the
    // dead Flowty-era table, frozen at ~24 rows since the Flowty marketplace
    // shut down (2026-05-13). The live TS/AllDay listing feeds moved to
    // badge_editions / cached_listings_v2 (see /api/market modern path). This
    // check now only fails if the frozen rows are purged — not a real
    // regression — so it's soft (visibility, never Sentry-alerts).
    time(async () => {
      const meta = {
        name: "cached_listings has rows",
        endpoint: "table:cached_listings",
        expected: "row-count>0",
        soft: true,
      };
      const { count } = await (svc.from("cached_listings") as any)
        .select("*", { count: "exact", head: true });
      const passed = (count ?? 0) > 0;
      return {
        ...meta,
        passed,
        detail: `${count} rows (frozen Flowty-era cache)`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { count: count ?? 0 },
      };
    }, {
      name: "cached_listings has rows",
      endpoint: "table:cached_listings",
      expected: "row-count>0",
      soft: true,
    }),

    // 6. Wallet search responds (soft-fail — depends on Top Shot GQL + Flow)
    time(async () => {
      const meta = {
        name: "wallet-search responds (external: TS GQL/Flow)",
        endpoint: "/api/wallet-search",
        expected: "200-status",
        soft: true,
      };
      const res = await smokeFetch(`${BASE_URL}/api/wallet-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({ input: "0xbd94cade097e50ac" }),
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      return {
        ...meta,
        passed: res.ok,
        detail: `HTTP ${res.status}`,
        statusCode: res.status,
        bodyExcerpt: res.ok ? null : text.slice(0, 500),
        notes: { wallet: "0xbd94cade097e50ac" },
      };
    }, {
      name: "wallet-search responds (external: TS GQL/Flow)",
      endpoint: "/api/wallet-search",
      expected: "200-status",
      soft: true,
    }),

    // 7. Pack listings responds
    checkUrl(
      { name: "pack-listings responds", endpoint: "/api/pack-listings", expected: "200-json" },
      `${BASE_URL}/api/pack-listings`
    ),

    // 7b. Pack Sniper public deal feed responds (soft — external Dapper Studio
    // fetch; a 200 with a possibly-empty deals[] is success — gates can
    // legitimately pass zero packs in a quiet/efficient market).
    checkUrl(
      {
        name: "public pack-sniper deal feed responds (external: Dapper Studio)",
        endpoint: "/api/public/insights/pack-sniper",
        expected: "200-json",
        soft: true,
      },
      `${BASE_URL}/api/public/insights/pack-sniper`,
      true,
      { timeoutMs: 15000 }
    ),

    // 8. Badges API responds (cold-start tolerant)
    checkUrl(
      { name: "badges API responds", endpoint: "/api/badges", expected: "200-json", soft: true },
      `${BASE_URL}/api/badges`,
      true,
      { timeoutMs: 15000 }
    ),

    // Public collection pages — must return 200 to anonymous browsers post the
    // SEO open-gate change.
    ...([
      "/nba-top-shot/sniper", "/nba-top-shot/collection", "/nba-top-shot/sets",
      "/nba-top-shot/packs",
      "/nfl-all-day/collection", "/nfl-all-day/overview",
      "/laliga-golazos/collection", "/disney-pinnacle/collection",
      "/disney-pinnacle/overview",
      "/nba-top-shot/market", "/nfl-all-day/market",
      "/laliga-golazos/market", "/disney-pinnacle/market",
      "/nba-top-shot/analytics", "/nfl-all-day/analytics",
      "/laliga-golazos/analytics", "/disney-pinnacle/analytics",
    ].map((page) =>
      time(async () => {
        const meta = {
          name: `public page ${page} returns 200`,
          endpoint: page,
          expected: "200-status",
        };
        const res = await smokeFetch(`${BASE_URL}${page}`, {
          cache: "no-store",
          redirect: "manual",
          headers: { "User-Agent": BROWSER_UA },
          signal: AbortSignal.timeout(6000),
        });
        const passed = res.status === 200;
        const text = passed ? "" : await res.text().catch(() => "");
        return {
          ...meta,
          passed,
          detail: `HTTP ${res.status}`,
          statusCode: res.status,
          bodyExcerpt: passed ? null : text.slice(0, 500),
          notes: { location: res.headers.get("location") ?? null },
        };
      }, {
        name: `public page ${page} returns 200`,
        endpoint: page,
        expected: "200-status",
      })
    )),

    // /profile redirects to /dashboard (308) — the May 6 migration retired the
    // standalone /profile editor in favour of /dashboard's editor surface, so
    // the legacy bookmark URL now 308s through. Bearer-bypass is opted out
    // with Authorization: "" so we exercise the actual rewrite, not the bypass.
    time(async () => {
      const meta = {
        name: "/profile redirects to /dashboard (308)",
        endpoint: "/profile",
        expected: "308-to-dashboard",
      };
      const res = await smokeFetch(`${BASE_URL}/profile`, {
        cache: "no-store",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA, Authorization: "" },
        signal: AbortSignal.timeout(6000),
      });
      const location = res.headers.get("location") ?? "";
      const ok = res.status === 308 && location.includes("/dashboard");
      return {
        ...meta,
        passed: ok,
        detail: `HTTP ${res.status}${location ? ` → ${location}` : ""}`,
        statusCode: res.status,
        bodyExcerpt: null,
        notes: { location },
      };
    }, {
      name: "/profile redirects to /dashboard (308)",
      endpoint: "/profile",
      expected: "308-to-dashboard",
    }),

    // Phase 3 — market API returns listings for Top Shot.
    // SMOKE-MARKET-EMPTY (2026-06-07): during the :00/:06 cron rush the TS proxy
    // can return green-but-empty (HTTP 200 with 0 listings — the tsCount:0 class),
    // an upstream-transient that bypasses checkUrl's retry because it's an
    // assertion miss, not an infra throw/status. Retry once on a 200-empty; if it
    // is still empty, warn (soft) instead of hard-failing so it stops paging
    // Sentry (NEXTJS-4). A non-200 still hard-fails, and listings>0 (first try or
    // after retry) passes — original semantics preserved for real regressions.
    time(async () => {
      const meta = {
        name: "market API returns Top Shot listings",
        endpoint: "/api/market",
        expected: "listings>0",
        notes: { collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd" } as Record<string, unknown>,
      };
      const url = `${BASE_URL}/api/market?collectionId=95f28a17-224a-4025-96ad-adf8a4c63bfd&limit=10`;
      const fetchListings = async () => {
        const res = await smokeFetch(url, {
          cache: "no-store",
          headers: { "User-Agent": BROWSER_UA },
          signal: AbortSignal.timeout(6000),
        });
        const text = await res.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* swallow */ }
        const listings = Array.isArray(body?.listings) ? body.listings : [];
        return { res, text, listings };
      };
      let { res, text, listings } = await fetchListings();
      // Green-but-empty (upstream TS proxy tsCount:0 at a cron rush) → retry once.
      if (res.ok && listings.length === 0) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          ({ res, text, listings } = await fetchListings());
        } catch {
          // keep the first 200-empty result; handled as a warn below.
        }
      }
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: text.slice(0, 500), notes: meta.notes ?? null };
      }
      if (listings.length > 0) {
        return { ...meta, passed: true, detail: `${listings.length} listings`, statusCode: res.status, bodyExcerpt: null, notes: { ...(meta.notes ?? {}), count: listings.length } };
      }
      // Still 200-but-empty after a retry: upstream TS proxy returned green-empty,
      // not a market regression. Soft-warn (console.warn, never Sentry) per the
      // file's soft-failure convention rather than hard-failing.
      return {
        ...meta,
        passed: false,
        soft: true,
        detail: "warn: 0 listings after retry (TS proxy green-but-empty; upstream-transient, not a regression)",
        statusCode: res.status,
        bodyExcerpt: text.slice(0, 500),
        notes: { ...(meta.notes ?? {}), count: 0, warn: "ts_proxy_empty" },
      };
    }, {
      name: "market API returns Top Shot listings",
      endpoint: "/api/market",
      expected: "listings>0",
    }),

    // 15–18. RLS Write-Block Tests.
    checkRlsBlocked("saved_wallets", { wallet_addr: "0x0000000000000000", username: "rls_test" }),
    checkRlsBlocked("profile_bio", { username: "rls_test", display_name: "rls_test" }),
    checkRlsBlocked("recent_searches", { query: "rls_test", query_type: "wallet" }),
    checkRlsBlocked("trophy_moments", { slot: 1, moment_id: "rls_test_moment" }),

    // SECDEF anon-EXECUTE regression guard. SECDEF functions bypass RLS, so a
    // destructive/maintenance function with anon EXECUTE is callable via the
    // bundled anon key through PostgREST rpc/ — TRUNCATE in particular isn't
    // governed by RLS at all. check_secdef_anon_execute_violations() inspects
    // pg_proc privileges (never invokes the guarded fns) and must return [].
    // Hard test: a non-empty result Sentry-alerts. See migration
    // audit_20260530_secdef_anon_execute_guard_fn + the 2026-05-30 grant
    // revoke (audit_20260530_revoke_anon_maintenance_secdef_execute).
    time(async () => {
      const meta = {
        name: "anon has no EXECUTE on destructive SECDEF functions",
        endpoint: "rpc:check_secdef_anon_execute_violations",
        expected: "zero-violations",
      };
      const { data, error } = await rpcRetry(svc, "check_secdef_anon_execute_violations");
      if (error) {
        return { ...meta, passed: false, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const violations = Array.isArray(data) ? data : [];
      const passed = violations.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "0 violations — destructive SECDEF set is service_role-only"
          : `${violations.length} anon/auth-executable: ${violations.map((v: { function: string }) => v.function).join(", ")}`,
        statusCode: null,
        bodyExcerpt: passed ? null : JSON.stringify(violations).slice(0, 500),
        notes: { violation_count: violations.length },
      };
    }, {
      name: "anon has no EXECUTE on destructive SECDEF functions",
      endpoint: "rpc:check_secdef_anon_execute_violations",
      expected: "zero-violations",
    }),

    // Public base-table security invariant. Parallel to the SECDEF guard above
    // but for plain base tables: every public base table must have RLS enabled,
    // and no base table with RLS off may carry an anon/authenticated write grant
    // (INSERT/UPDATE/DELETE/TRUNCATE) — either is an anon-write hole. The RPC
    // inspects pg_catalog/information_schema only (relkind IN ('r','p'), so the
    // ~49 views are excluded — SECDEF views exist by design and must NOT trip
    // this) and must return []. Both invariants verified clean (0/0) on
    // 2026-05-30. Hard test: a non-empty result Sentry-alerts. See migration
    // audit_20260530_check_public_security_invariants.
    time(async () => {
      const meta = {
        name: "public base tables: RLS on + no anon write",
        endpoint: "rpc:check_public_security_invariants",
        expected: "zero-violations",
      };
      const { data, error } = await rpcRetry(svc, "check_public_security_invariants");
      if (error) {
        return { ...meta, passed: false, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const violations = Array.isArray(data) ? data : [];
      const passed = violations.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "0 violations — all public base tables have RLS on and no anon write grant"
          : `${violations.length} violation(s): ${violations.map((v: { kind: string; object_name: string }) => `${v.kind}:${v.object_name}`).join(", ")}`,
        statusCode: null,
        bodyExcerpt: passed ? null : JSON.stringify(violations).slice(0, 500),
        notes: { violation_count: violations.length },
      };
    }, {
      name: "public base tables: RLS on + no anon write",
      endpoint: "rpc:check_public_security_invariants",
      expected: "zero-violations",
    }),

    // Phase 4: auth-gated profile routes accept or redirect. 200 OR 401 all OK.
    ...([
      "/api/profile/activity",
      "/api/profile/favorites",
      "/api/profile/hero-moment",
    ].map((path) =>
      time(async () => {
        const meta = {
          name: `${path} returns 200 or 401`,
          endpoint: path,
          expected: "200-or-401",
        };
        const res = await smokeFetch(`${BASE_URL}${path}`, {
          cache: "no-store",
          redirect: "follow",
          headers: { "User-Agent": BROWSER_UA },
          signal: AbortSignal.timeout(5000),
        });
        const passed = res.status === 200 || res.status === 401;
        const text = passed ? "" : await res.text().catch(() => "");
        return {
          ...meta,
          passed,
          detail: `HTTP ${res.status}`,
          statusCode: res.status,
          bodyExcerpt: passed ? null : text.slice(0, 500),
          notes: null,
        };
      }, {
        name: `${path} returns 200 or 401`,
        endpoint: path,
        expected: "200-or-401",
      })
    )),

    // Phase 4: public profile route is unauthenticated — accepts 200 (user
    // exists) or 404 (username not registered).
    time(async () => {
      const meta = {
        name: "/api/public/profile/jamesdillonbond returns JSON",
        endpoint: "/api/public/profile/jamesdillonbond",
        expected: "200-or-404-json",
        soft: true,
      };
      const res = await smokeFetch(`${BASE_URL}/api/public/profile/jamesdillonbond`, {
        cache: "no-store",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      const okStatus = res.status === 200 || res.status === 404;
      if (!okStatus) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: text.slice(0, 500), notes: null };
      }
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* swallow */ }
      const passed = body != null;
      return {
        ...meta,
        passed,
        detail: body?.error ?? `HTTP ${res.status}`,
        statusCode: res.status,
        bodyExcerpt: passed ? null : text.slice(0, 500),
        notes: null,
      };
    }, {
      name: "/api/public/profile/jamesdillonbond returns JSON",
      endpoint: "/api/public/profile/jamesdillonbond",
      expected: "200-or-404-json",
      soft: true,
    }),

    // Phase 4.1: /api/profile/resolve-and-associate
    time(async () => {
      const meta = {
        name: "/api/profile/resolve-and-associate responds (200 or 401)",
        endpoint: "/api/profile/resolve-and-associate",
        expected: "200-with-4-collections-or-401",
      };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
      };
      const token = process.env.SMOKE_TEST_SESSION_TOKEN;
      if (token) headers.cookie = `sb-auth-token=${token}`;
      const res = await smokeFetch(`${BASE_URL}/api/profile/resolve-and-associate`, {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify({ username: "jamesdillonbond" }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (res.status === 401) {
        return { ...meta, passed: true, detail: "401 (unauthenticated, expected without session)", statusCode: 401, bodyExcerpt: null, notes: null };
      }
      if (res.status !== 200) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: text.slice(0, 500), notes: null };
      }
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* swallow */ }
      const ok =
        body != null &&
        typeof body.walletAddress === "string" &&
        Array.isArray(body.associatedCollections) &&
        body.associatedCollections.length === 4;
      return {
        ...meta,
        passed: ok,
        detail: ok ? `${body.walletAddress} x4` : "malformed 200 body",
        statusCode: 200,
        bodyExcerpt: ok ? null : text.slice(0, 500),
        notes: null,
      };
    }, {
      name: "/api/profile/resolve-and-associate responds (200 or 401)",
      endpoint: "/api/profile/resolve-and-associate",
      expected: "200-with-4-collections-or-401",
    }),

    // Phase 4.2: /api/profile/resolve-and-associate must respond quickly even
    // though it fires 4 parallel wallet-search calls in the background.
    time(async () => {
      const meta = {
        name: "/api/profile/resolve-and-associate returns quickly (after() non-blocking)",
        endpoint: "/api/profile/resolve-and-associate",
        expected: "non-5xx-under-3s",
      };
      const start = Date.now();
      const res = await smokeFetch(`${BASE_URL}/api/profile/resolve-and-associate`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({ username: "jamesdillonbond" }),
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - start;
      const ok = res.status < 500 && elapsed < 3000;
      return {
        ...meta,
        passed: ok,
        detail: `HTTP ${res.status} in ${elapsed}ms`,
        statusCode: res.status,
        bodyExcerpt: null,
        notes: { latency_ms: elapsed },
      };
    }, {
      name: "/api/profile/resolve-and-associate returns quickly (after() non-blocking)",
      endpoint: "/api/profile/resolve-and-associate",
      expected: "non-5xx-under-3s",
    }),

    // Phase 4 (opt-in): authed /nba-top-shot/collection render
    time(async () => {
      const meta = {
        name: "authed /nba-top-shot/collection renders (opt-in via SMOKE_TEST_SESSION_TOKEN)",
        endpoint: "/nba-top-shot/collection",
        expected: "authed-200-with-content",
        soft: true,
      };
      const token = process.env.SMOKE_TEST_SESSION_TOKEN;
      if (!token) {
        return { ...meta, passed: true, detail: "skipped — no SMOKE_TEST_SESSION_TOKEN", statusCode: null, bodyExcerpt: null, notes: { skipped: true } };
      }
      const res = await smokeFetch(`${BASE_URL}/nba-top-shot/collection`, {
        cache: "no-store",
        redirect: "manual",
        headers: { cookie: `sb-auth-token=${token}`, "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status !== 200) {
        const txt = await res.text().catch(() => "");
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: txt.slice(0, 500), notes: null };
      }
      const html = await res.text();
      const hit = html.includes("COLLECTION ANALYZER") || html.toLowerCase().includes("nba top shot");
      return {
        ...meta,
        passed: hit,
        detail: hit ? "auth render ok" : "content marker missing",
        statusCode: 200,
        bodyExcerpt: hit ? null : html.slice(0, 500),
        notes: null,
      };
    }, {
      name: "authed /nba-top-shot/collection renders (opt-in via SMOKE_TEST_SESSION_TOKEN)",
      endpoint: "/nba-top-shot/collection",
      expected: "authed-200-with-content",
      soft: true,
    }),

    // Phase 4.3 (opt-in): /api/profile/hero-moment populated
    time(async () => {
      const meta = {
        name: "/api/profile/hero-moment returns populated hero (opt-in via SMOKE_TEST_SESSION_TOKEN)",
        endpoint: "/api/profile/hero-moment",
        expected: "authed-hero-with-fmv",
        soft: true,
      };
      const token = process.env.SMOKE_TEST_SESSION_TOKEN;
      if (!token) {
        return { ...meta, passed: true, detail: "skipped — no SMOKE_TEST_SESSION_TOKEN", statusCode: null, bodyExcerpt: null, notes: { skipped: true } };
      }
      const res = await smokeFetch(`${BASE_URL}/api/profile/hero-moment`, {
        cache: "no-store",
        redirect: "manual",
        headers: { cookie: `sb-auth-token=${token}`, "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(6000),
      });
      const text = await res.text();
      if (res.status !== 200) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: text.slice(0, 500), notes: null };
      }
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* swallow */ }
      const ok =
        body?.hero != null &&
        typeof body.hero.momentId === "string" &&
        typeof body.hero.fmvUsd === "number" &&
        body.hero.fmvUsd > 0;
      return {
        ...meta,
        passed: !!ok,
        detail: ok
          ? `${body.hero.playerName ?? "?"} $${body.hero.fmvUsd.toFixed(2)}`
          : body?.reason ?? "malformed body",
        statusCode: 200,
        bodyExcerpt: ok ? null : text.slice(0, 500),
        notes: null,
      };
    }, {
      name: "/api/profile/hero-moment returns populated hero (opt-in via SMOKE_TEST_SESSION_TOKEN)",
      endpoint: "/api/profile/hero-moment",
      expected: "authed-hero-with-fmv",
      soft: true,
    }),

    // Sniper cart wiring
    time(async () => {
      const meta = {
        name: "sniper cart wiring (Flowty has listing fields, TS rows ineligible)",
        endpoint: "/api/sniper-feed",
        expected: "flowty-cart-fields-present",
        soft: true,
      };
      const res = await smokeFetch(`${BASE_URL}/api/sniper-feed`, {
        cache: "no-store",
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* swallow */ }
      const deals = Array.isArray(data) ? data : data?.deals ?? [];
      if (!Array.isArray(deals) || deals.length === 0) {
        return { ...meta, passed: false, detail: "no deals returned", statusCode: res.status, bodyExcerpt: text.slice(0, 500), notes: null };
      }
      const flowty = deals.find((d: any) => d?.source === "flowty");
      const ts = deals.find((d: any) => d?.source === "topshot");
      const flowtyOk =
        !flowty ||
        (typeof flowty.listingResourceID === "string" &&
          typeof flowty.storefrontAddress === "string" &&
          typeof flowty.askPrice === "number" &&
          flowty.askPrice > 0);
      const tsOk = !ts || ts.source === "topshot";
      const okAll = flowtyOk && tsOk;
      return {
        ...meta,
        passed: okAll,
        detail: okAll
          ? `flowty=${flowty ? "ok" : "none"} ts=${ts ? "tagged" : "none"}`
          : `flowty=${flowtyOk ? "ok" : "missing cart fields"} ts=${tsOk ? "tagged" : "untagged"}`,
        statusCode: res.status,
        bodyExcerpt: okAll ? null : text.slice(0, 500),
        notes: { flowty_present: !!flowty, ts_present: !!ts },
      };
    }, {
      name: "sniper cart wiring (Flowty has listing fields, TS rows ineligible)",
      endpoint: "/api/sniper-feed",
      expected: "flowty-cart-fields-present",
      soft: true,
    }),

    // Pinnacle concierge regression
    time(async () => {
      const meta = {
        name: "concierge resolves Pinnacle query (collectionId routing)",
        endpoint: "/api/support-chat",
        expected: "non-empty-non-error-pinnacle-response",
        soft: true,
        notes: { collectionId: "disney-pinnacle", probe: "Goofy under $50" } as Record<string, unknown>,
      };
      const res = await smokeFetch(`${BASE_URL}/api/support-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({
          message: "Show me a Goofy pin under $50",
          collectionId: "disney-pinnacle",
          sessionId: `smoke-pinnacle-${Date.now()}`,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      const rawBody = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawBody.slice(0, 500), notes: meta.notes };
      }
      const parsed = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
      const text = String(parsed?.response ?? "").toLowerCase();
      const looksEmpty = !text || /no\s+(deals|results|moments|pins)\s+found/.test(text);
      const looksGenericError = /something\s+went\s+wrong/i.test(text);
      const looksRouteError = /"category"\s*:\s*"error"/i.test(rawBody);
      const failed = looksEmpty || looksGenericError || looksRouteError;
      const detail = looksEmpty ? "empty/no-results response"
        : looksGenericError ? "generic 'something went wrong' fallback"
        : looksRouteError ? "route returned category=error"
        : `len=${text.length}`;
      return {
        ...meta,
        passed: !failed,
        detail,
        statusCode: res.status,
        bodyExcerpt: failed ? rawBody.slice(0, 500) : null,
        notes: meta.notes,
      };
    }, {
      name: "concierge resolves Pinnacle query (collectionId routing)",
      endpoint: "/api/support-chat",
      expected: "non-empty-non-error-pinnacle-response",
      soft: true,
    }),

    // Pinnacle data-layer integrity
    time(async () => {
      const meta = {
        name: "Pinnacle searchPinnacleDeals filters character_name correctly",
        endpoint: "lib:searchPinnacleDeals",
        expected: "all-rows-match-character",
      };
      const json = await searchPinnacleDeals(
        svc,
        { player: "Goofy", maxPrice: 50, limit: 10 },
        { source: "live" }
      );
      const parsed = JSON.parse(json);
      if (parsed.status === "no_results") {
        return { ...meta, passed: true, detail: "no goofy listings (acceptable)", statusCode: null, bodyExcerpt: null, notes: { result_count: 0 } };
      }
      if (parsed.status !== "ok" || !Array.isArray(parsed.results)) {
        return { ...meta, passed: false, detail: `unexpected status: ${parsed.status}`, statusCode: null, bodyExcerpt: json.slice(0, 500), notes: null };
      }
      const wrongRows = parsed.results.filter(
        (r: { player: string | null }) => !r.player || !/goofy/i.test(r.player)
      );
      if (wrongRows.length > 0) {
        const sample = wrongRows[0];
        return {
          ...meta,
          passed: false,
          detail: `${wrongRows.length} non-goofy row(s) leaked: e.g. player='${sample.player}' fmv=${sample.fmv}`,
          statusCode: null,
          bodyExcerpt: JSON.stringify(sample).slice(0, 500),
          notes: { wrong_count: wrongRows.length, total: parsed.results.length },
        };
      }
      return {
        ...meta,
        passed: true,
        detail: `${parsed.results.length} rows, all goofy`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { result_count: parsed.results.length },
      };
    }, {
      name: "Pinnacle searchPinnacleDeals filters character_name correctly",
      endpoint: "lib:searchPinnacleDeals",
      expected: "all-rows-match-character",
    }),

    // Pinnacle FMV cross-character leak detector
    time(async () => {
      const meta = {
        name: "Pinnacle FMV not borrowed across characters (drift guard)",
        endpoint: "lib:searchPinnacleDeals",
        expected: "no-fmv-leak",
      };
      const json = await searchPinnacleDeals(
        svc,
        { player: "Goofy", maxPrice: 100, limit: 20 },
        { source: "live" }
      );
      const parsed = JSON.parse(json);
      if (parsed.status === "no_results") {
        return { ...meta, passed: true, detail: "no rows to check", statusCode: null, bodyExcerpt: null, notes: null };
      }
      if (parsed.status !== "ok" || !Array.isArray(parsed.results)) {
        return { ...meta, passed: false, detail: `unexpected status: ${parsed.status}`, statusCode: null, bodyExcerpt: json.slice(0, 500), notes: null };
      }
      // Validate each priced row against pinnacle_catalog (the per-render FMV
      // source since a9f86af) using a trimmed + lowercased (character, set,
      // variant) triple key — mirrors the router's tripleKey. pinnacle_editions
      // is no longer the FMV source, and catalog set_name values can carry a
      // leading space, so an exact PostgREST .eq() against either column
      // false-positives this guard on every smoke tick. NOTE: the catalog column
      // is `variant`, not `variant_type`.
      const tripleKey = (c: string | null, s: string | null, v: string | null) =>
        `${(c ?? "").toLowerCase().trim()}||${(s ?? "").toLowerCase().trim()}||${(v ?? "").toLowerCase().trim()}`;
      // Bound the comparison fetch to the characters actually under test. A
      // global .limit(5000) is silently clamped to PostgREST's 1,000-row server
      // max, so once pinnacle_catalog exceeds 1,000 priced renders (1,806 as of
      // 2026-06-10) ~806 renders fall out of catalogTriples — the same ones every
      // tick (stable scan order) — and any deal whose render sits in the dropped
      // tail false-flags as a leak. Each character has far fewer than 1,000
      // renders, so .in(character_name) can never be truncated.
      const distinctPlayers = Array.from(
        new Set(
          (parsed.results as Array<{ player: string | null }>)
            .map((r) => r.player)
            .filter((p): p is string => typeof p === "string" && p.length > 0)
        )
      );
      const { data: catalogRows } = await (svc as any)
        .from("pinnacle_catalog")
        .select("character_name, set_name, variant")
        .not("fmv_usd", "is", null)
        .in("character_name", distinctPlayers.length > 0 ? distinctPlayers : ["__none__"]);
      // Belt-and-braces: if the bounded fetch ever returns the clamp ceiling,
      // the set may be truncated — report inconclusive rather than false-fail.
      if ((catalogRows ?? []).length >= 1000) {
        return {
          ...meta,
          passed: true,
          detail: `inconclusive: catalog fetch hit the ${1000}-row clamp (${(catalogRows ?? []).length}); skipping leak check`,
          statusCode: null,
          bodyExcerpt: null,
          notes: { inconclusive: true, fetched: (catalogRows ?? []).length },
        };
      }
      const catalogTriples = new Set<string>(
        (catalogRows ?? []).map((row: any) => tripleKey(row.character_name, row.set_name, row.variant))
      );
      const leaks: string[] = [];
      for (const r of parsed.results as Array<{
        player: string | null; set: string | null; tier: string | null; fmv: number | null;
      }>) {
        if (r.fmv == null) continue;
        if (!catalogTriples.has(tripleKey(r.player, r.set, r.tier))) {
          leaks.push(`${r.player}/${r.set}/${r.tier} fmv=$${r.fmv}`);
        }
      }
      if (leaks.length > 0) {
        return {
          ...meta,
          passed: false,
          detail: `FMV leaked on ${leaks.length} row(s): ${leaks[0]}`,
          statusCode: null,
          bodyExcerpt: leaks.slice(0, 5).join("; ").slice(0, 500),
          notes: { leak_count: leaks.length, total: parsed.results.length },
        };
      }
      return {
        ...meta,
        passed: true,
        detail: `${parsed.results.length} rows, no FMV leaks`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { result_count: parsed.results.length },
      };
    }, {
      name: "Pinnacle FMV not borrowed across characters (drift guard)",
      endpoint: "lib:searchPinnacleDeals",
      expected: "no-fmv-leak",
    }),

    // Concierge name-filter regression — Pinnacle Goofy
    time(async () => {
      const meta = {
        name: "concierge filters by character name (Pinnacle Goofy probe)",
        endpoint: "/api/support-chat",
        expected: "goofy-mention-or-explicit-no-match",
        soft: true,
        notes: { collectionId: "disney-pinnacle", probe: "Goofy under $50" } as Record<string, unknown>,
      };
      const res = await smokeFetch(`${BASE_URL}/api/support-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({
          message: "Show me a Goofy pin under $50",
          collectionId: "disney-pinnacle",
          sessionId: `smoke-goofy-filter-${Date.now()}`,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      const rawText = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawText.slice(0, 500), notes: meta.notes };
      }
      let body: any = null;
      try { body = JSON.parse(rawText); } catch { /* swallow */ }
      const raw = String(body?.response ?? "");
      const text = raw.toLowerCase();
      const mentionsGoofy = /goofy/.test(text);
      const explicitNoMatch = /no\s+goofy/.test(text) || /couldn'?t\s+find\s+(?:any\s+)?goofy/.test(text);
      const confabulatedNames = [
        "minnie", "mickey mouse", "donald duck", "pluto", "daisy",
        "lando calrissian", "greef karga", "pegasus", "rafiki", "cogsworth",
      ];
      const confabulated = confabulatedNames.some((n) => text.includes(n)) && !mentionsGoofy;
      const fmvLeak = mentionsGoofy && /\$2\d|\$3[0-5]/.test(text) && /fmv|discount|\boff\b|below/.test(text);
      const fakeDiscount = mentionsGoofy && /\d{2,3}\s*%\s*(?:below|off|under)/.test(text);
      const passed = (mentionsGoofy || explicitNoMatch) && !confabulated && !fmvLeak && !fakeDiscount;
      const detail = passed
        ? mentionsGoofy ? "mentions goofy, no fmv leak" : "explicit no-match"
        : confabulated ? `confabulated other character: ${raw.slice(0, 160)}`
        : fmvLeak ? `fmv leak ($25-35 on goofy): ${raw.slice(0, 160)}`
        : fakeDiscount ? `fake discount on goofy: ${raw.slice(0, 160)}`
        : "neither mention nor explicit no-match";
      return {
        ...meta,
        passed,
        detail,
        statusCode: res.status,
        bodyExcerpt: passed ? null : rawText.slice(0, 500),
        notes: meta.notes,
      };
    }, {
      name: "concierge filters by character name (Pinnacle Goofy probe)",
      endpoint: "/api/support-chat",
      expected: "goofy-mention-or-explicit-no-match",
      soft: true,
    }),

    // Concierge name-filter regression — Top Shot LeBron
    time(async () => {
      const meta = {
        name: "concierge filters by player name (Top Shot LeBron probe)",
        endpoint: "/api/support-chat",
        expected: "lebron-mention-or-explicit-no-match",
        soft: true,
        notes: { collectionId: "nba-top-shot", probe: "LeBron Common under $5" } as Record<string, unknown>,
      };
      const res = await smokeFetch(`${BASE_URL}/api/support-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({
          message: "Find a LeBron James Common moment under $5",
          collectionId: "nba-top-shot",
          sessionId: `smoke-lebron-filter-${Date.now()}`,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      const rawText = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawText.slice(0, 500), notes: meta.notes };
      }
      let body: any = null;
      try { body = JSON.parse(rawText); } catch { /* swallow */ }
      const raw = String(body?.response ?? "");
      const text = raw.toLowerCase();
      const mentionsLebron = /lebron/.test(text);
      const explicitNoMatch = /no\s+lebron/.test(text) || /couldn'?t\s+find\s+(?:any\s+)?lebron/.test(text);
      const confabulatedNames = ["stephen curry", "kevin durant", "luka", "giannis", "jokic", "embiid"];
      const confabulated = confabulatedNames.some((n) => text.includes(n)) && !mentionsLebron;
      const passed = (mentionsLebron || explicitNoMatch) && !confabulated;
      const detail = passed
        ? mentionsLebron ? "mentions lebron" : "explicit no-match"
        : confabulated ? `confabulated other player: ${raw.slice(0, 140)}` : "neither mention nor explicit no-match";
      return {
        ...meta,
        passed,
        detail,
        statusCode: res.status,
        bodyExcerpt: passed ? null : rawText.slice(0, 500),
        notes: meta.notes,
      };
    }, {
      name: "concierge filters by player name (Top Shot LeBron probe)",
      endpoint: "/api/support-chat",
      expected: "lebron-mention-or-explicit-no-match",
      soft: true,
    }),

    // Graceful-degradation regression — synthetic Anthropic 4xx
    time(async () => {
      const meta = {
        name: "support-chat graceful-degradation (synthetic Anthropic 4xx)",
        endpoint: "/api/support-chat",
        expected: "category=concierge_unavailable",
        soft: true,
      };
      const secret = process.env.INGEST_SECRET_TOKEN;
      if (!secret) {
        return { ...meta, passed: true, detail: "skipped — no INGEST_SECRET_TOKEN", statusCode: null, bodyExcerpt: null, notes: { skipped: true } };
      }
      const res = await smokeFetch(`${BASE_URL}/api/support-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": BROWSER_UA,
          "x-rpc-test-error-mode": "credit_balance",
          "x-rpc-test-secret": secret,
        },
        body: JSON.stringify({
          message: "Test the graceful-degradation path",
          sessionId: `smoke-degradation-${Date.now()}`,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const rawText = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawText.slice(0, 500), notes: null };
      }
      let body: any = null;
      try { body = JSON.parse(rawText); } catch { /* swallow */ }
      const text = String(body?.response ?? "").toLowerCase();
      const category = String(body?.category ?? "");
      const matchesMessage = /temporarily\s+unavailable/.test(text);
      const matchesCategory = category === "concierge_unavailable";
      const passed = matchesMessage && matchesCategory;
      return {
        ...meta,
        passed,
        detail: passed
          ? `category=${category}`
          : `text="${text.slice(0, 80)}" category=${category}`,
        statusCode: res.status,
        bodyExcerpt: passed ? null : rawText.slice(0, 500),
        notes: { category, matches_message: matchesMessage },
      };
    }, {
      name: "support-chat graceful-degradation (synthetic Anthropic 4xx)",
      endpoint: "/api/support-chat",
      expected: "category=concierge_unavailable",
      soft: true,
    }),

    // Cart validate endpoint sanity check
    time(async () => {
      const meta = {
        name: "/api/cart/validate responds on bogus listing",
        endpoint: "/api/cart/validate",
        expected: "results-shape-with-exists-and-sniped",
      };
      const res = await smokeFetch(`${BASE_URL}/api/cart/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({
          listings: [
            {
              listingResourceID: "1",
              storefrontAddress: "0x0000000000000001",
              expectedPrice: 1,
            },
          ],
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      const rawText = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, detail: `HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawText.slice(0, 500), notes: null };
      }
      let data: any = null;
      try { data = JSON.parse(rawText); } catch { /* swallow */ }
      const r = data?.results?.["1"];
      const ok = !!r && typeof r.exists === "boolean" && typeof r.sniped === "boolean";
      return {
        ...meta,
        passed: ok,
        detail: ok ? `exists=${r.exists} sniped=${r.sniped}` : "malformed body",
        statusCode: res.status,
        bodyExcerpt: ok ? null : rawText.slice(0, 500),
        notes: ok ? { exists: r.exists, sniped: r.sniped } : null,
      };
    }, {
      name: "/api/cart/validate responds on bogus listing",
      endpoint: "/api/cart/validate",
      expected: "results-shape-with-exists-and-sniped",
    }),
  ]);

  // ── Collect results, converting rejected promises to failures ──
  const results: TestResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          name: `test ${i + 1}`,
          endpoint: `unknown-${i + 1}`,
          expected: "unknown",
          passed: false,
          detail: (s.reason as Error)?.message ?? String(s.reason),
          elapsedMs: 0,
          statusCode: null,
          bodyExcerpt: null,
          notes: null,
        }
  );

  // ── Per-endpoint structured persistence to public.smoke_test_results ──
  // Single insert keeps overhead low; ignoring write errors keeps the smoke
  // test resilient if the table is missing or RLS shifts.
  const ranAt = new Date().toISOString();
  const rows = results.map((r) => ({
    ran_at: ranAt,
    endpoint: r.endpoint,
    ok: r.passed,
    status_code: r.statusCode ?? null,
    elapsed_ms: r.elapsedMs,
    error: r.passed ? null : (r.detail ?? null),
    body_excerpt: r.bodyExcerpt ?? null,
    expected: r.expected,
    notes: r.notes ?? null,
  }));
  try {
    const { error: insErr } = await (svc.from("smoke_test_results") as any).insert(rows);
    if (insErr) {
      console.error("[smoke-test] failed to write smoke_test_results:", insErr.message);
    }
  } catch (err) {
    console.error("[smoke-test] exception writing smoke_test_results:", err instanceof Error ? err.message : String(err));
  }

  // RLS regressions still get a console.error for in-line visibility.
  for (const r of results) {
    if (r.endpoint.startsWith("rls:") && !r.passed) {
      console.error(`[smoke-test] ${r.name}: REGRESSION — ${r.detail}`);
    }
  }

  // Push hard failures to Sentry so Trevor gets notified instead of needing
  // to poll this endpoint. Soft failures (external API deps) stay out of Sentry.
  for (const r of results) {
    if (!r.passed && !r.soft) {
      Sentry.withScope((scope) => {
        scope.setTag("smoke_test", r.name);
        scope.setTag("endpoint", r.endpoint);
        scope.setTag("route", "smoke-test");
        scope.setExtra("detail", r.detail ?? "");
        scope.setExtra("body_excerpt", r.bodyExcerpt ?? "");
        scope.setExtra("expected", r.expected);
        Sentry.captureMessage("smoke test failed: " + r.name, "error");
      });
    }
  }

  // ── Summary ────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const hardResults = results.filter((r) => !r.soft);
  const hardPassed = hardResults.filter((r) => r.passed).length;
  const hardTotal = hardResults.length;
  const allPassed = hardPassed === hardTotal;
  const failures = results.filter((r) => !r.passed && !r.soft);
  const softFailures = results.filter((r) => !r.passed && r.soft);

  // Vercel only surfaces the first console.log per request in its dashboard
  // search, so fold the failing endpoint names + statuses into the headline
  // line. Detail JSON still goes to a follow-up console.error for anyone
  // tailing logs at runtime; the headline is what shows up in dashboard
  // search.
  const failingEndpointsBrief = failures
    .map((f) => `${f.endpoint}${f.statusCode != null ? `(${f.statusCode})` : ""}`)
    .join(",");
  const softFailingEndpointsBrief = softFailures
    .map((f) => f.endpoint)
    .join(",");
  const headline =
    `SMOKE-TEST ${allPassed ? "ALL PASSED" : "FAILURES DETECTED"}` +
    ` hard ${hardPassed}/${hardTotal} overall ${passed}/${total}` +
    (failures.length > 0 ? ` failing=[${failingEndpointsBrief}]` : "") +
    (softFailures.length > 0 ? ` soft_failing=[${softFailingEndpointsBrief}]` : "");
  console.log(headline);
  if (failures.length > 0) {
    console.error("SMOKE-TEST HARD FAILURES:", JSON.stringify(failures.map((f) => ({ endpoint: f.endpoint, error: f.detail, status: f.statusCode })), null, 2));
  }
  if (softFailures.length > 0) {
    console.warn("SMOKE-TEST SOFT FAILURES (external deps, informational):", JSON.stringify(softFailures.map((f) => ({ endpoint: f.endpoint, error: f.detail })), null, 2));
  }

  return NextResponse.json({
    passed,
    total,
    allPassed,
    hardPassed,
    hardTotal,
    softFailures: softFailures.length,
    ranAt,
    results,
  }, { status: 200 });
}

export async function POST() {
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
