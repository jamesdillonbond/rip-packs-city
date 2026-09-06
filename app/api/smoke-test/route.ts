// app/api/smoke-test/route.ts
// build-id: 20260717-go-live-ungate (trigger fresh Vercel prod build)
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@supabase/supabase-js";
import { searchPinnacleDeals } from "@/lib/concierge/pinnacle-router";
import { sendOpsAlert } from "@/lib/ops-alert";
import { CANDY_MLB_PUBLIC, PANINI_PUBLIC } from "@/lib/launch-flags";

// Explicit Vercel Function budget (GHA-triggered; some use after() fire-and-forget).
export const maxDuration = 300;

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

// Retry timeout ceiling. The caller's per-attempt `AbortSignal.timeout(N)` is
// ONE-SHOT — once it fires it stays aborted — so the retry can't reuse it; it
// gets a fresh, generous signal instead (>= every caller's first-attempt value,
// so a retry is never stricter than the attempt it follows).
const SMOKE_RETRY_TIMEOUT_MS = 15000;

// smokeFetch + one retry on the timeout/transient class, so a single transient
// blip doesn't log a false failure. Mirrors the retry the helper probes
// (checkUrl / checkPublicPage / checkHtmlContains) already do; the inline
// soft probes (sniper-feed, og, wallet-search, profile) predate it and a bare
// single fetch made them flap on one-off timeouts — indistinguishable, in the
// smoke summary, from a real outage. A non-transient error (real 4xx/5xx
// contract breach surfaced as a throw) still propagates on the first attempt;
// a second transient failure rethrows so the caller's soft handling records it.
// Exported for unit tests.
export async function smokeFetchRetry(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await smokeFetch(url, init);
  } catch (e: any) {
    if (!isTimeoutOrTransient(e?.message ?? String(e))) throw e;
    await new Promise((r) => setTimeout(r, 500));
    // Callers pass their timeout as `signal: AbortSignal.timeout(N)`, which is
    // one-shot: if it already fired on the first attempt it stays aborted, so
    // reusing the same `init` here makes the retry fetch abort INSTANTLY —
    // silently defeating the retry on the very timeout class this helper exists
    // to tolerate (the resolve-and-associate cry-wolf, NEXTJS-K, flapped 43×
    // this way). Give the retry a fresh timeout signal when the original has
    // already aborted; otherwise reuse init (a non-timeout transient leaves the
    // signal live with time to spare).
    const retryInit: RequestInit = init.signal?.aborted
      ? { ...init, signal: AbortSignal.timeout(SMOKE_RETRY_TIMEOUT_MS) }
      : init;
    return smokeFetch(url, retryInit);
  }
}

type TestResult = {
  name: string;
  passed: boolean;
  detail?: string;
  soft?: boolean;
  // The check could not RUN (its RPC/fetch errored) — as opposed to running and
  // finding a violation. Still a hard failure: an unevaluated guard is not a
  // passing guard, and the guard family below deliberately pages on RPC error.
  // But the Sentry title must not restate an assertion the check never reached.
  // Every guard name here reads as a claim about production ("RLS on + no anon
  // write"), so a pool timeout was surfacing as `smoke test failed: public base
  // tables: RLS on + no anon write` — indistinguishable from a live security
  // breach. Observed 2026-08-09 (Sentry JAVASCRIPT-NEXTJS-25) on the cursor-stall
  // guard during a disk-IO saturation window. See the Sentry loop at the bottom.
  couldNotRun?: boolean;
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
const TRANSIENT_RX = /connection pool|statement timeout|timed out|ECONNRESET|fetch failed|terminating connection|too many clients/i; // retry-build: 2026-07-03

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

// A health-RPC (detect_stalled_pipelines / analytics_pipeline_health) that still
// errored after rpcRetry's single retry: if it's the saturation/timeout class
// (connection pool / statement timeout / canceling statement) it's cry-wolf at
// the :00/:06 cron rush — the cause is DB-IO load, not a real
// pipeline/FMV regression. Report SOFT inconclusive (never Sentry, per the
// !passed && !soft gate) instead of hard-failing. A non-transient RPC error
// stays a real FAIL. (ANALYTICS-SMOKE-RESIDUAL / Sentry NEXTJS-A, 2026-06-22.)
// The security guards (check_*_invariants / check_secdef_anon_execute_violations)
// deliberately do NOT use this — a guard RPC error must page.
//
// Either way the RPC ERRORED, so the assertion was never evaluated: set
// couldNotRun so the non-transient hard-fail titles as "smoke check could not
// run: <name>" rather than "smoke test failed: sales indexers running
// (detect_stalled_pipelines)" — the latter sends the triager hunting a stalled
// indexer that the check never actually looked at. Same never-evaluated-guard
// class as the security guards' couldNotRun (JAVASCRIPT-NEXTJS-25). No effect on
// the transient branch (soft failures skip the Sentry loop).
function softIfTransientRpc(
  meta: { name: string; endpoint: string; expected: string },
  error: { message?: string },
): TestSeed {
  const transient = TRANSIENT_RX.test(error.message ?? "");
  return {
    ...meta,
    passed: false,
    soft: transient,
    couldNotRun: true,
    detail: transient
      ? `inconclusive: transient rpc error after retry (${error.message})`
      : `rpc error: ${error.message}`,
    statusCode: null,
    bodyExcerpt: null,
    notes: transient ? { inconclusive: true, warn: "rpc_transient" } : null,
  };
}

// ⚠ FAIL CLOSED ON SHAPE — the guard-fails-open trap, closed 2026-08-25.
//
// Every zero-violation guard below read `Array.isArray(data) ? data : []`,
// which coerces ANY non-array payload — a jsonb object, a scalar, or a NULL
// jsonb — into an EMPTY violation list. `passed` is then `length === 0`, so an
// unrecognised shape does not FAIL the guard: it PASSES it, permanently and
// silently. Same class as `?? 0` on a supabase count — the coercion publishes a
// measured-clean verdict the check never earned.
//
// ⚠ Not hypothetical here, because these guards already use BOTH PostgREST
// shapes (verified against pg_proc 2026-08-25):
//   check_public_security_invariants     → TABLE(kind, object_name) → JSON array
//   check_anon_write_surface             → TABLE(...)               → JSON array
//   check_secdef_anon_execute_violations → scalar jsonb
//   check_cursor_stall_threshold_drift   → scalar jsonb
//   detect_stalled_pipelines             → scalar jsonb
//   check_cron_heavy_job_exec_drift      → scalar jsonb, and it is the ONE that
//                                          returns a jsonb OBJECT rather than an
//                                          array — {inspected, offenders}. Its arm
//                                          reads `offenders` explicitly and treats
//                                          any other shape as couldNotRun, so it is
//                                          outside the array-vs-scalar hazard below
//                                          by construction rather than by luck.
// The first five return a JSON array TODAY (measured 2026-08-25 via jsonb_typeof, and
// each COALESCEs its own NULL), so nothing is currently mis-reporting. The
// exposure is PROSPECTIVE and cheap to close: a scalar-jsonb function returning
// SQL NULL arrives as `null`, and rewriting any of them to the object shape a
// sibling uses would silence the guard with no test going red.
//
// So an unexpected shape is handled exactly as an `error` already is:
// couldNotRun + hard fail, never soft — a shape change is not transient and a
// retry cannot fix it. ⚠ Only the TYPE is reported, never the payload: these
// guards read privilege catalogs and their rows must not reach Sentry.
function shapeCouldNotRun(
  meta: { name: string; endpoint: string; expected: string },
  data: unknown,
): TestSeed {
  const shape = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
  return {
    ...meta,
    passed: false,
    couldNotRun: true,
    detail: `rpc returned an unexpected payload shape (${shape}, expected array) — the guard never evaluated`,
    statusCode: null,
    bodyExcerpt: null,
    notes: null,
  };
}

// HTML-contains probe for the public entity pages (edition / pack dist). These
// render a lot server-side (FMV, asks, sales, parallels, packs) — ~2.5s anon
// normally, but >8s under DB saturation. A raw 10s fetch with no retry made
// them the SMOKE-EDITION-TIMEOUT cry-wolf (NEXTJS-1H/1J, 9+8 ticks/8h). Now:
// a generous budget, ONE retry on the timeout/transient class, and a SOFT
// inconclusive (never Sentry) if it's still just slow. A genuine regression —
// non-200, or a 200 that's missing the asserted section — still hard-fails.
//
// STREAMED-BODY TIMEOUT (2026-07-16): the asserted sections on these pages
// (pack "Sales History", edition "Activity") flush from a <Suspense> boundary
// AFTER the 200 shell headers. `fetch()` resolves the instant the headers
// arrive, so the retry/inconclusive guard around the fetch was already past by
// the time the streamed body read ran — and the body read (`res.text()`) shares
// the same AbortSignal budget. Under DB read-contention the streamed flush blew
// the budget, `res.text()` rejected mid-stream, the old `.catch(() => "")`
// swallowed it to "", and `needle`-absent read out as a HARD "HTTP 200,
// <needle>=false" false-fail (dist 5048 fired this on 2026-07-16 during the
// 60s-statement-timeout contention window). Fix: read the body INSIDE the same
// retry/inconclusive handling so a mid-stream timeout is transient (retry once →
// SOFT inconclusive), while a body that fully reads but lacks the needle still
// hard-fails as a real module regression.
// Exported for unit tests (regression coverage on the streamed-body-timeout
// classification below). Next.js App Router only treats HTTP-method exports as
// route handlers; this named export is ignored by the router.
export async function checkHtmlContains(
  meta: { name: string; endpoint: string; expected: string },
  url: string,
  needle: string,
  timeoutMs = 18_000,
): Promise<TestResult> {
  // Fetch AND fully read the (possibly streamed) body under one timeout budget.
  // A timeout in either phase rejects here so the caller's transient handling
  // sees it — never swallow the streamed-body read into "".
  const attemptOnce = async (): Promise<{ res: Response; text: string }> => {
    const res = await smokeFetch(url, {
      cache: "no-store",
      redirect: "manual",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.status === 200 ? await res.text() : "";
    return { res, text };
  };
  return time(async () => {
    let attempt: { res: Response; text: string };
    try {
      attempt = await attemptOnce();
    } catch (e: any) {
      if (!isTimeoutOrTransient(e?.message ?? String(e))) throw e;
      await new Promise((r) => setTimeout(r, 500));
      try {
        attempt = await attemptOnce();
      } catch (e2: any) {
        if (!isTimeoutOrTransient(e2?.message ?? String(e2))) throw e2;
        // Still slow after a retry (fetch OR streamed-body read) — inconclusive,
        // not a regression.
        return {
          ...meta,
          passed: false,
          soft: true,
          detail: `page slow — inconclusive (timeout ${timeoutMs}ms after retry)`,
          statusCode: null,
          bodyExcerpt: null,
          notes: { inconclusive: true, warn: "page_stream_timeout_transient" },
        };
      }
    }
    const { res, text } = attempt;
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

// 200-probe for the public collection pages. The overview / analytics / market
// pages are ISR/SSR pages that render a lot server-side and go slow (>6s) under
// Supabase connection-pool pressure at the :00/:06 cron rush — the
// SMOKE-PAGE-TIMEOUT cry-wolf (NEXTJS-E /nfl-all-day/overview, NEXTJS-W
// /disney-pinnacle/overview, NEXTJS-X /laliga-golazos/analytics — chronic
// flappers since 2026-05-06). The old inline probe used a raw 6s AbortSignal
// with NO retry, so a slow-but-healthy page aborted → escaped to time()'s
// non-soft fallback → hard-fired Sentry ("The operation was aborted due to
// timeout"). Now: a generous budget, ONE retry on the timeout/transient class,
// and a SOFT inconclusive (never Sentry) if it is still just slow. A genuine
// regression — a reachable non-200 that is NOT a transient gateway status
// (4xx / non-transient 5xx) — still hard-fails. Mirrors the checkHtmlContains
// inconclusive pattern.
async function checkPublicPage(page: string, timeoutMs = 15_000): Promise<TestResult> {
  const meta = {
    name: `public page ${page} returns 200`,
    endpoint: page,
    expected: "200-status",
  };
  const fetchOnce = () =>
    smokeFetch(`${BASE_URL}${page}`, {
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
        // Still slow after a retry — inconclusive (infra), not a regression.
        return {
          ...meta,
          passed: false,
          soft: true,
          detail: `page slow — inconclusive (timeout ${timeoutMs}ms after retry)`,
          statusCode: null,
          bodyExcerpt: null,
          notes: { inconclusive: true, warn: "page_timeout_transient" },
        };
      }
    }
    // Transient gateway/pool/rate status (reachable server, infra-transient) →
    // retry once, then SOFT inconclusive if it persists.
    if (!res.ok && TRANSIENT_STATUS.has(res.status)) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        res = await fetchOnce();
      } catch {
        /* keep the transient response; handled below */
      }
    }
    if (!res.ok && TRANSIENT_STATUS.has(res.status)) {
      return {
        ...meta,
        passed: false,
        soft: true,
        detail: `inconclusive: HTTP ${res.status} (transient gateway)`,
        statusCode: res.status,
        bodyExcerpt: null,
        notes: { inconclusive: true, warn: "page_status_transient" },
      };
    }
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
  }, meta);
}

// The 3 live `/api/support-chat` probes each make a real Claude Sonnet + 5-tool
// round-trip — measured at ~99.7% of the RPC product's Anthropic API Console
// spend (the smoke suite ran them every ~20-40 min). They now run only when
// `liveConcierge` is set (daily window / ?concierge=1), NOT on the per-tick run.
// Per-tick router-regression coverage is preserved by the two direct
// searchPinnacleDeals lib tests + the synthetic-4xx graceful-degradation probe,
// none of which call the model.
async function runSmokeTests(opts: { liveConcierge?: boolean } = {}) {
  const liveConcierge = opts.liveConcierge ?? false;
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
      const res = await smokeFetchRetry(`${BASE_URL}/api/sniper-feed`, {
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
      const res = await smokeFetchRetry(`${BASE_URL}/api/og/collection?id=nba-top-shot`, {
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
    // mount the "Sales History" module and the edition page its sales/activity
    // section — both render unconditionally (empty state still emits the title),
    // so a missing string means the module regressed, not just thin data.
    // SMOKE-EDITION-TIMEOUT (2026-06-14): these two are the heaviest SSR pages
    // in the suite (full FMV + asks + sales + parallels + pack pool). The 18s
    // default still timed out on them at the cron rush, so give them a 25s
    // per-fetch budget (the heavy-probe value used elsewhere in this file).
    // The soft-inconclusive retry path still keeps a genuinely slow page from
    // crying wolf; a real regression (non-200 / missing section) still hard-fails.
    //
    // EDITION PROBE (2026-07-03): retargeted off the TS Base-Set common
    // 124:4493 — its bottom sections stream behind <Suspense> and, on that
    // many-parallel/many-pack page, the streamed body routinely blew the 25s
    // budget (HTTP 200 shell, section not yet flushed → "Recent Sales=false"
    // false-fail firing daily since 2026-06-08). Now probes a liquid, LIGHT
    // AllDay Base edition (Tom Brady 446 — no ::subedition parallels / special-
    // serials, so the Suspense block flushes well inside budget) and asserts the
    // "Activity" section title (the sales module was renamed Recent Sales →
    // Activity on 2026-07-03; the <Section title="Activity"> heading renders
    // unconditionally as the first bottom section).
    // PACK PROBE (2026-07-16): retargeted off dist 7800 — the single most
    // pathological dist in the catalog (20,577 opens / 19,675 purchase rows;
    // ~14s cold even after the per-dist RPC work), whose tail blew the 25s
    // budget whenever the hourly smoke overlapped the :34/:40 heavy pg_cron
    // windows (offers-raise, cross-source-dedup) — firing false "Sales
    // History=false" pages daily. Dist 5048 is a representative mid-size dist
    // (353 purchases, 324 traced sales, ~4.6s cold) that still exercises the
    // full module chain; a genuine module regression still hard-fails.
    checkHtmlContains(
      { name: "pack dist page has Sales History", endpoint: "/nba-top-shot/pack/dist/5048", expected: "html-contains-Sales-History" },
      `${BASE_URL}/nba-top-shot/pack/dist/5048`,
      "Sales History",
      25_000,
    ),

    checkHtmlContains(
      { name: "edition page has Activity section", endpoint: "/nfl-all-day/edition/446", expected: "html-contains-Activity" },
      `${BASE_URL}/nfl-all-day/edition/446`,
      "Activity",
      25_000,
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
        return softIfTransientRpc(meta, error);
      }
      if (!Array.isArray(data)) return shapeCouldNotRun(meta, data);
      const stalled: any[] = data;
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
        return softIfTransientRpc(meta, error);
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
      const { count, error } = await (svc.from("cached_listings") as any)
        .select("*", { count: "exact", head: true });
      if (error) {
        // couldNotRun: the check never evaluated, so its assertion must not be
        // restated as though it had been violated. supabase-js RETURNS
        // `{ count: null, error }` for a statement timeout rather than throwing,
        // so time()'s catch never sees it — and `count ?? 0` would then publish
        // a MEASURED ZERO, rendering `detail: "null rows (frozen Flowty-era
        // cache)"` and `notes.count: 0` as facts about the table when the read
        // simply failed. A failed read is not an answer.
        return { ...meta, passed: false, couldNotRun: true, detail: `query error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
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
      const res = await smokeFetchRetry(`${BASE_URL}/api/wallet-search`, {
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

    // 7. Pack listings responds. SMOKE-PACK-LISTINGS-TIMEOUT (NEXTJS-J, chronic
    // flapper since 2026-05-06): the route proxies the Dapper Studio internal
    // GraphQL endpoint behind a 2-min cache, so a cache-miss/cold-start makes the
    // upstream fetch blow the old 4s default → "operation was aborted due to
    // timeout" hard-fail. The sibling pack-sniper feed (7b) hits the SAME
    // fetchLivePackListings and already gets a 15s budget; match it here.
    // checkUrl still retries once on the transient/timeout class and a genuine
    // 4xx/5xx contract breach still hard-fails.
    checkUrl(
      { name: "pack-listings responds", endpoint: "/api/pack-listings", expected: "200-json" },
      `${BASE_URL}/api/pack-listings`,
      true,
      { timeoutMs: 15000 }
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
      // STAGED surfaces — added only once their launch flag flips. While
      // CANDY_MLB_PUBLIC is false, proxy.ts 302s this to /login and the check
      // would red the smoke gate; the moment it flips, the first public
      // /insights page in the smoke list starts being verified on every push
      // and on the daily run. This is the ONLY thing standing between a broken
      // Candy launch and a silent one — a gate that can't fail is worse than
      // none (see memory: rpc-silent-failure-class).
      ...(CANDY_MLB_PUBLIC ? ["/insights/candy-mlb"] : []),
      // The thin-tab Candy overview (published 2026-09-06) — the launch page.
      "/candy-mlb/overview",
      ...(PANINI_PUBLIC ? ["/insights/panini-squeeze"] : []),
    ].map((page) => checkPublicPage(page))),

    // 🚨 THIS CHECK USED TO ASSERT "/profile 308s to /dashboard" AND WOULD HAVE
    // GONE PERMANENTLY RED the moment register R36 shipped — the exact failure
    // this repo records as indistinguishable from a broken instrument at a
    // glance. Found by grepping for what READS a path before changing it.
    //
    // What it asserts now is the fix itself: an ANONYMOUS visitor gets a real
    // page, not a login wall. `/profile` is the leftmost mobile tab, and the
    // measured pre-fix chain was 308 → /dashboard → 307 → /login?next=%2Fdashboard.
    // `Authorization: ""` opts out of the bearer bypass so this exercises the
    // genuine anonymous path, exactly as the old check did.
    time(async () => {
      const meta = {
        name: "/profile serves the anonymous entry page (200, no login wall)",
        endpoint: "/profile",
        expected: "200-anon-entry",
      };
      const res = await smokeFetch(`${BASE_URL}/profile`, {
        cache: "no-store",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA, Authorization: "" },
        signal: AbortSignal.timeout(8000),
      });
      const location = res.headers.get("location") ?? "";
      const body = res.status === 200 ? await res.text().catch(() => "") : "";
      // ⚠ Assert the ABSENCE of the redirect AND the PRESENCE of the page's own
      // copy. Status alone would pass on any 200, including a future regression
      // that renders an empty shell.
      const ok =
        res.status === 200 &&
        !location.includes("/login") &&
        body.includes("No account needed");
      return {
        ...meta,
        passed: ok,
        detail: `HTTP ${res.status}${location ? ` → ${location}` : ""}`,
        statusCode: res.status,
        bodyExcerpt: null,
        notes: { location, hasAnonCopy: body.includes("No account needed") },
      };
    }, {
      name: "/profile serves the anonymous entry page (200, no login wall)",
      endpoint: "/profile",
      expected: "200-anon-entry",
    }),

    // Phase 3 — market API returns listings for Top Shot.
    // SMOKE-MARKET-EMPTY (2026-06-07): during the :00/:06 cron rush the TS proxy
    // can return green-but-empty (HTTP 200 with 0 listings — the tsCount:0 class),
    // an upstream-transient that bypasses checkUrl's retry because it's an
    // assertion miss, not an infra throw/status. Retry once on a 200-empty; if it
    // is still empty, warn (soft) instead of hard-failing so it stops paging
    // Sentry (NEXTJS-4). A non-200 still hard-fails, and listings>0 (first try or
    // after retry) passes — original semantics preserved for real regressions.
    //
    // 2026-06-11 (NEXTJS-4 stayed live): the 2026-06-07 fix only softened the
    // 200-empty ASSERTION path. The leak was the THROW path — the 6s fetch
    // AbortSignal aborts on a slow/cold /api/market (cry-wolf even on a calm DB),
    // which escaped to time()'s fallback that lacked `soft`, so it hard-fired.
    // Now: transport timeout/transient throws AND transient gateway statuses
    // (502/503/504/etc.) report soft INCONCLUSIVE; only a reachable-server
    // non-200 that isn't transient (4xx contract breach / non-transient 5xx)
    // stays a real hard FAIL. Mirrors the checkHtmlContains inconclusive pattern.
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
      const softInconclusive = (detail: string, statusCode: number | null) => ({
        ...meta,
        passed: false,
        soft: true,
        detail,
        statusCode,
        bodyExcerpt: null,
        notes: { ...(meta.notes ?? {}), inconclusive: true, warn: "market_transport_transient" },
      });

      // Transport throw (timeout/abort/network) → retry once, then soft-INCONCLUSIVE
      // on a transient class. A genuine non-transient throw rethrows to time().
      let first: { res: Response; text: string; listings: any[] };
      try {
        first = await fetchListings();
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (!isTimeoutOrTransient(msg)) throw e;
        await new Promise((r) => setTimeout(r, 400));
        try {
          first = await fetchListings();
        } catch (e2: any) {
          const msg2 = e2?.message ?? String(e2);
          if (!isTimeoutOrTransient(msg2)) throw e2;
          return softInconclusive(`inconclusive: /api/market transport timeout after retry (${msg2})`, null);
        }
      }

      let { res, text, listings } = first;
      // Green-but-empty (upstream TS proxy tsCount:0 at a cron rush) → retry once.
      if (res.ok && listings.length === 0) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          ({ res, text, listings } = await fetchListings());
        } catch {
          // keep the first 200-empty result; handled as a warn below.
        }
      }
      // Transient gateway/pool/rate status (reachable server, infra-transient) →
      // soft INCONCLUSIVE, not a regression.
      if (!res.ok && TRANSIENT_STATUS.has(res.status)) {
        return softInconclusive(`inconclusive: HTTP ${res.status} (transient gateway)`, res.status);
      }
      // Genuine non-200 (4xx contract breach / non-transient 5xx) stays HARD.
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
      soft: true,
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
        // couldNotRun: the guard never evaluated, so do NOT let the Sentry title
        // restate its assertion. Still hard-fails (these guards must page).
        return { ...meta, passed: false, couldNotRun: true, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      if (!Array.isArray(data)) return shapeCouldNotRun(meta, data);
      const violations = data;
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
        // couldNotRun: the guard never evaluated, so do NOT let the Sentry title
        // restate its assertion. Still hard-fails (these guards must page).
        return { ...meta, passed: false, couldNotRun: true, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      if (!Array.isArray(data)) return shapeCouldNotRun(meta, data);
      const violations = data;
      const passed = violations.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "0 violations across all 6 invariant arms (RLS-off / anon-write base tables, updatable+writable views, unexpected-definer views, anon-EXECUTE secdef trigger fns, anon-readable materialized views)"
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

    // ⚠ IS THE CONCIERGE ACTUALLY ANSWERING ANYONE? Hard test, added 2026-08-16.
    //
    // The concierge failed ~780 consecutive conversations over FOURTEEN DAYS
    // (2026-08-02 → 08-16) — Anthropic returning 403 `credit_balance` on nearly
    // every call — and every instrument read green the whole time. The smoke
    // test logged `ALL PASSED hard 37/37` while it was down. Trevor found it by
    // using the product.
    //
    // Nothing caught it because the only concierge probes here are (a) SOFT and
    // (b) opt-in, since each one spends real Anthropic tokens. So this check
    // deliberately measures the OUTCOME instead of making a call: what share of
    // real conversations got a degraded fallback rather than an answer. It
    // costs one indexed read and cannot itself burn credits.
    //
    // ⚠ Keyed on `category`, NOT on the fallback COPY. The strings in
    // CONCIERGE_ERROR_MESSAGES are user-facing prose that will be reworded, and
    // a check that greps for them would go quietly vacuous the day someone
    // improves the wording — while still reporting green.
    //
    // ⚠ The sample floor is load-bearing. Without it a single failed
    // conversation on a quiet night is "100% degraded" and pages for nothing;
    // this repo has already paid for cry-wolf alarms (`ufc_fmv_stale_hours`).
    // Below the floor the check reports PASS with an explicit low-sample note
    // rather than a verdict it did not earn.
    //
    // ⚠ AND AS OF 2026-08-16 THE FLOOR IS THE NORMAL PATH, NOT THE EDGE CASE.
    // Once smoke rows are excluded (see the query below), REAL concierge traffic
    // is ~0–3 conversations/day — 0 on nine of the last ten days. So this check
    // will usually report `low_sample: true` and no verdict. That is the honest
    // outcome and it is deliberately NOT "fixed" by lowering MIN_SAMPLE or by
    // counting smoke rows: a verdict computed from one conversation, or from a
    // fixture we generated ourselves, is worse than an explicit no-verdict. The
    // check starts earning its keep the moment real traffic exists, which is
    // exactly when its answer would matter.
    time(async () => {
      const WINDOW_HOURS = 6;
      const MIN_SAMPLE = 5;
      const FAIL_AT_SHARE = 0.5;
      const meta = {
        name: "concierge answers rather than degrading",
        endpoint: "db:support_conversations.category",
        expected: `degraded-share-below-${FAIL_AT_SHARE * 100}pct-over-${WINDOW_HOURS}h`,
      };
      // Categories CONCIERGE_ERROR_MESSAGES writes when it cannot answer.
      const DEGRADED = [
        "concierge_unavailable",
        "concierge_model_error",
        "concierge_rate_limited",
        "concierge_overloaded",
      ];
      const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
      // ⚠ EXCLUDE SMOKE-TEST ROWS, OR THIS CHECK MEASURES ITSELF AND PAGES FOREVER.
      //
      // Without this filter the check read its own sibling's fixture. The
      // `support-chat graceful-degradation (synthetic Anthropic 4xx)` check below
      // deliberately POSTs `x-rpc-test-error-mode: credit_balance` on EVERY smoke
      // tick to prove the degradation path works — which writes a
      // `support_conversations` row with category `concierge_unavailable` and
      // `is_smoke_test = true`. That is the correct behaviour of a good test, and
      // it is manufactured evidence for this one.
      //
      // Measured 2026-08-16, live: of 905 conversations since 08-02, **902 were
      // smoke tests and 3 were real**, and ALL 863 degraded rows were smoke rows —
      // real degraded conversations: ZERO. With real traffic near zero and one
      // synthetic degraded row guaranteed per tick, the share sat at ~100% and
      // this check could NEVER go green on its own. It fired as
      // JAVASCRIPT-NEXTJS-2E (27 users, escalating) reporting an outage that was
      // not happening: the only 3 real conversations in 10 days all SUCCEEDED.
      //
      // ⚠ This also means the "~780 degraded conversations" figure this check was
      // built from was smoke traffic, not user impact. (It does NOT prove the
      // concierge was healthy then — there was independent evidence of an
      // Anthropic 403 — only that the user-impact number came from the wrong rows.)
      //
      // `not.is.true` rather than `.eq(false)`: legacy rows may carry NULL, and a
      // NULL is not a smoke test.
      const { data, error } = await svc
        .from("support_conversations")
        .select("category")
        .gte("created_at", since)
        .not("is_smoke_test", "is", true)
        .neq("category", "beta_feedback");
      if (error) {
        // couldNotRun: the check never evaluated, so its assertion must not be
        // restated as though it had been violated.
        return { ...meta, passed: false, couldNotRun: true, detail: `query error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const rows = (data ?? []) as Array<{ category: string | null }>;
      const total = rows.length;
      const degraded = rows.filter((r) => DEGRADED.includes(String(r.category))).length;
      const share = total > 0 ? degraded / total : 0;
      if (total < MIN_SAMPLE) {
        return {
          ...meta,
          passed: true,
          detail: `only ${total} conversation(s) in ${WINDOW_HOURS}h — below the ${MIN_SAMPLE}-sample floor, no verdict`,
          statusCode: null,
          bodyExcerpt: null,
          notes: { total, degraded, low_sample: true },
        };
      }
      const passed = share < FAIL_AT_SHARE;
      return {
        ...meta,
        passed,
        detail: passed
          ? `${degraded}/${total} degraded over ${WINDOW_HOURS}h (${Math.round(share * 100)}%)`
          : `CONCIERGE DEGRADED: ${degraded}/${total} conversations (${Math.round(share * 100)}%) returned a fallback instead of an answer in the last ${WINDOW_HOURS}h. Check the ANTHROPIC_API_KEY's balance/spend limit — a 403 credit_balance looks identical to a healthy route from the outside (HTTP 200).`,
        statusCode: null,
        bodyExcerpt: null,
        notes: { total, degraded, share_pct: Math.round(share * 100) },
      };
    }, {
      name: "concierge answers rather than degrading",
      endpoint: "db:support_conversations.category",
      expected: "degraded-share-below-50pct-over-6h",
    }),

    // Anon-write SURFACE invariant. Complements the check above, which only
    // catches RLS-OFF tables. This one catches the sneakier hole: a table with
    // RLS ON that STILL lets anon write because it carries an anon write grant
    // plus a permissive write policy with no auth-identity gate. Must return []
    // (the deliberate bounded anon-insert tables are allowlisted inside the RPC).
    // See migration audit_20260725_check_anon_write_surface.
    time(async () => {
      const meta = {
        name: "public base tables: no anon-satisfiable write policy",
        endpoint: "rpc:check_anon_write_surface",
        expected: "zero-violations",
      };
      const { data, error } = await rpcRetry(svc, "check_anon_write_surface");
      if (error) {
        // couldNotRun: the guard never evaluated, so do NOT let the Sentry title
        // restate its assertion. Still hard-fails (these guards must page).
        return { ...meta, passed: false, couldNotRun: true, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      if (!Array.isArray(data)) return shapeCouldNotRun(meta, data);
      const violations = data;
      const passed = violations.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "0 violations — no base table is anon-writable outside the bounded allowlist"
          : `${violations.length} anon-writable: ${violations.map((v: { object_name: string; cmd: string }) => `${v.object_name}:${v.cmd}`).join(", ")}`,
        statusCode: null,
        bodyExcerpt: passed ? null : JSON.stringify(violations).slice(0, 500),
        notes: { violation_count: violations.length },
      };
    }, {
      name: "public base tables: no anon-satisfiable write policy",
      endpoint: "rpc:check_anon_write_surface",
      expected: "zero-violations",
    }),

    // Alerting-integrity invariant (2026-07-29). The cursor-stall threshold is ONE
    // concept that used to be written as two independent literals: the view
    // silent_indexer_failures classified 'cursor_stalled' at 2h, while
    // get_pipeline_alerts() alerted on it at 6h off event_cursor. The view's CASE is
    // first-match-wins, so at 2h an indexer flipped to 'cursor_stalled' and thereby
    // stopped matching the ok/resolving_editions/silent_failure arms the alert fn
    // consumes — and nothing alerts on that status. Result: a 4h window in which a
    // stalled indexer was invisible to EVERY alert branch (observed live on
    // ufc_sales). Both now call public.cursor_stall_threshold(); this asserts they
    // still do, so a CREATE OR REPLACE that re-inlines a literal reddens CI instead
    // of silently re-opening the window. Must return [].
    // See migrations audit_20260729_unify_cursor_stall_threshold +
    // audit_20260729_check_cursor_stall_threshold_drift.
    time(async () => {
      const meta = {
        name: "cursor-stall threshold shared by classifier and alert arm",
        endpoint: "rpc:check_cursor_stall_threshold_drift",
        expected: "zero-violations",
      };
      const { data, error } = await rpcRetry(svc, "check_cursor_stall_threshold_drift");
      if (error) {
        // couldNotRun: the guard never evaluated, so do NOT let the Sentry title
        // restate its assertion. Still hard-fails (these guards must page).
        return { ...meta, passed: false, couldNotRun: true, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      if (!Array.isArray(data)) return shapeCouldNotRun(meta, data);
      const violations = data;
      const passed = violations.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? "0 violations — cursor-stall threshold expressed once and shared by both objects"
          : `${violations.length} drift: ${violations.map((v: { kind: string; object_name: string }) => `${v.kind}:${v.object_name}`).join(", ")}`,
        statusCode: null,
        bodyExcerpt: passed ? null : JSON.stringify(violations).slice(0, 500),
        notes: { violation_count: violations.length },
      };
    }, {
      name: "cursor-stall threshold shared by classifier and alert arm",
      endpoint: "rpc:check_cursor_stall_threshold_drift",
      expected: "zero-violations",
    }),

    // A `cron_heavy` job that cannot EXECUTE the function it is scheduled to call
    // fails in 0.0 s with `permission denied for function`, writes NO pipeline_runs
    // row (the function never runs, so it never logs), and leaves the message only
    // in `cron.job_run_details` — which nothing in this repo reads. It is therefore
    // indistinguishable from a job that was never scheduled: silent, free, and green
    // on every instrument.
    //
    // ⚠ IT IS THE DEFAULT OUTCOME OF THE CORRECT ANON REVOKE, NOT AN ODDITY. A new
    // public function is executable by `cron_heavy` only via the PUBLIC grant it
    // inherits at creation, and the mandated
    // `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` removes exactly that. Four
    // recorded instances: two Pinnacle trade jobs and a series rollup (2026-08-23),
    // then `run_topshot_onchain_rekey` (2026-09-02) — which shipped from a session
    // that had the write-up available and walked into it anyway. Three prose records
    // did not prevent a fourth, which is why this arm exists at all.
    //
    // ⚠ `inspected` is checked, not just `offenders`. The guard walks `cron.job` and
    // regex-extracts `public.<fn>(` from each command; if that walk ever matches
    // nothing it would report zero offenders and read as a clean bill of health. A
    // guard that passes by inspecting an empty set is this repo's most-repeated
    // failure, so an implausibly small population is a FAILURE here, not a pass.
    // See migration audit_20260902_revoke_from_public_silently_unschedules_a_cron_heavy_job.
    time(async () => {
      const meta = {
        name: "cron_heavy can execute every function it is scheduled to call",
        endpoint: "rpc:check_cron_heavy_job_exec_drift",
        expected: "zero-offenders",
      };
      const { data, error } = await rpcRetry(svc, "check_cron_heavy_job_exec_drift");
      if (error) {
        return { ...meta, passed: false, couldNotRun: true, detail: `rpc error: ${error.message}`, statusCode: null, bodyExcerpt: null, notes: null };
      }
      const payload = data as { inspected?: unknown; offenders?: unknown } | null;
      const inspected = typeof payload?.inspected === "number" ? payload.inspected : null;
      const offenders = Array.isArray(payload?.offenders) ? payload.offenders : null;
      if (inspected === null || offenders === null) {
        const shape = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
        return {
          ...meta,
          passed: false,
          couldNotRun: true,
          detail: `rpc returned an unexpected payload shape (${shape}, expected {inspected, offenders}) — the guard never evaluated`,
          statusCode: null,
          bodyExcerpt: null,
          notes: null,
        };
      }
      // 56 pairs live at 2026-09-02. The floor is deliberately far below that so
      // ordinary unscheduling does not trip it, and far above zero so a broken walk
      // cannot pass.
      if (inspected < 20) {
        return {
          ...meta,
          passed: false,
          couldNotRun: true,
          detail: `the walk inspected only ${inspected} job/function pair(s) — that is a broken guard, not a clean run`,
          statusCode: null,
          bodyExcerpt: null,
          notes: { inspected, offender_count: offenders.length },
        };
      }
      const passed = offenders.length === 0;
      return {
        ...meta,
        passed,
        detail: passed
          ? `0 offenders across ${inspected} scheduled job/function pair(s)`
          : `${offenders.length} cron_heavy job(s) cannot execute their own function: ${offenders
              .map((o: { jobname?: string; function?: string }) => `${o.jobname}→${o.function}`)
              .join(", ")}`,
        statusCode: null,
        bodyExcerpt: passed ? null : JSON.stringify(offenders).slice(0, 500),
        notes: { inspected, offender_count: offenders.length },
      };
    }, {
      name: "cron_heavy can execute every function it is scheduled to call",
      endpoint: "rpc:check_cron_heavy_job_exec_drift",
      expected: "zero-offenders",
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
      const res = await smokeFetchRetry(`${BASE_URL}/api/public/profile/jamesdillonbond`, {
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
      // smokeFetchRetry (not bare smokeFetch): this correctness probe fires 4
      // parallel wallet-search calls server-side and intermittently blows the
      // 8s ceiling at the cron rush — a single transient timeout was logging a
      // false failure (NEXTJS-K, 43× over 3mo). One retry on the timeout class
      // keeps genuine breaches (wrong status / bad body / two-in-a-row timeout).
      const res = await smokeFetchRetry(`${BASE_URL}/api/profile/resolve-and-associate`, {
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
    //
    // ⚠ THE 3 s BUDGET ONLY MEANS SOMETHING ON A 200, AND SAYING SO IS THE FIX.
    // A 401 short-circuits at the auth gate BEFORE those four searches, so its
    // wall clock says nothing about `after()`. This check used to apply the
    // budget to every status and report `HTTP ${status} in ${ms}ms`, so a
    // COLD-START 401 at 3,030 ms — 30 ms over, on a path that never reaches the
    // background work — hard-failed the whole workflow with the message
    // `HARD FAIL: … — HTTP 401 in 3030ms`. **That reads as an auth breakage and
    // sends the reader to the wrong subsystem** (observed 2026-09-02; the
    // sibling run 24 s later was green). Its Phase 4.1 twin already carries a
    // retry for this endpoint's known latency flap — NEXTJS-K, 43 false failures
    // over three months — so the cry-wolf history here is documented, not
    // theoretical.
    // ⛔ Deliberately NOT wrapped in smokeFetchRetry like 4.1: a retry's time is
    // included in `elapsed`, so hardening it would corrupt the very measurement
    // this check exists to take.
    time(async () => {
      const meta = {
        name: "/api/profile/resolve-and-associate responds non-5xx (after() budget applies only to a 200)",
        endpoint: "/api/profile/resolve-and-associate",
        expected: "non-5xx; under-3s only when it authenticates",
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
      // Only a 200 reaches the four parallel wallet searches, so only a 200 can
      // test whether they block the response.
      const afterExercised = res.status === 200;
      const badStatus = res.status >= 500;
      const tooSlow = afterExercised && elapsed >= 3000;
      // ⚠ The two failure modes are reported SEPARATELY. One message covering
      // both is what made a latency miss read as a status failure.
      const detail = badStatus
        ? `server error: HTTP ${res.status} in ${elapsed}ms`
        : tooSlow
          ? `after() budget exceeded: ${elapsed}ms >= 3000ms on a 200`
          : afterExercised
            ? `HTTP 200 in ${elapsed}ms`
            : `HTTP ${res.status} in ${elapsed}ms — auth short-circuit, after() NOT exercised`;
      return {
        ...meta,
        passed: !badStatus && !tooSlow,
        detail,
        statusCode: res.status,
        bodyExcerpt: null,
        // `after_exercised` is ALWAYS emitted, including false, so a reader can
        // tell "the property held" from "the property was never tested" without
        // reading this route.
        notes: { latency_ms: elapsed, after_exercised: afterExercised },
      };
    }, {
      name: "/api/profile/resolve-and-associate responds non-5xx (after() budget applies only to a 200)",
      endpoint: "/api/profile/resolve-and-associate",
      expected: "non-5xx; under-3s only when it authenticates",
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

    // Sniper outbound-listing wiring
    time(async () => {
      const meta = {
        name: "sniper listing wiring (Flowty rows carry outbound listing fields)",
        endpoint: "/api/sniper-feed",
        expected: "flowty-listing-fields-present",
        soft: true,
      };
      const res = await smokeFetchRetry(`${BASE_URL}/api/sniper-feed`, {
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
          : `flowty=${flowtyOk ? "ok" : "missing listing fields"} ts=${tsOk ? "tagged" : "untagged"}`,
        statusCode: res.status,
        bodyExcerpt: okAll ? null : text.slice(0, 500),
        notes: { flowty_present: !!flowty, ts_present: !!ts },
      };
    }, {
      name: "sniper listing wiring (Flowty rows carry outbound listing fields)",
      endpoint: "/api/sniper-feed",
      expected: "flowty-listing-fields-present",
      soft: true,
    }),

    // Pinnacle concierge regression — LIVE LLM call (Sonnet + tools), gated.
    // Runs only on the daily window / ?concierge=1, never on the per-tick run.
    // ⚠ THE ONLY HARD LIVE CONCIERGE CHECK, AND THE ONLY ONE THAT WOULD HAVE
    // CAUGHT THE FOURTEEN-DAY OUTAGE. Added 2026-08-16.
    //
    // The concierge — RPC's flagship differentiator — returned a fallback on
    // essentially every call from ~2026-08-02, and every instrument read green
    // until Trevor found it by using the product. Two later attempts to close
    // that both missed:
    //   · the live probes below assert CONTENT (Pinnacle results, a LeBron
    //     mention) and are therefore, correctly, SOFT — model output is flaky and
    //     an empty result can be a true answer. A soft check never pages, so a
    //     dead concierge stayed invisible even on the days they ran.
    //   · the outcome check further up counts DEGRADED CONVERSATIONS, which is
    //     the right idea and is now honest — but with real concierge traffic at
    //     ~0–3/day it sits below its sample floor and returns no verdict.
    //
    // This check asserts the one thing that is decisive, unambiguous and NOT
    // model-dependent: did the concierge ANSWER, or did it hand back a degraded
    // fallback? That is exactly the shape of the outage (`concierge_unavailable`
    // on every call), so it can be HARD without the cry-wolf cost that made the
    // others soft.
    //
    // ⚠ THE SPLIT IS LOAD-BEARING. A DEGRADED CATEGORY is a hard fail — the
    // product is broken and someone must know. A TRANSPORT failure (timeout,
    // non-2xx, unparseable body) is `soft: true` + couldNotRun, because we cannot
    // tell our outage from a network blip from inside the probe, and the gate
    // keys on `soft` — a hard fail there would page on a hiccup and this repo has
    // already paid for that (`ufc_fmv_stale_hours`).
    //
    // ⚠ Keyed on CATEGORY, never on the fallback copy — the same reason recorded
    // on the outcome check: CONCIERGE_ERROR_MESSAGES is user-facing prose that
    // will be reworded, and a copy-keyed check goes quietly vacuous while green.
    //
    // COST: one Anthropic call per live run, i.e. ~1/day (see wantsLiveConcierge
    // and the scheduled `?concierge=1` in .github/workflows/smoke-tests.yml).
    // Fractions of a cent against a flagship feature silently dying for a
    // fortnight. It is deliberately NOT run per-tick: that would be ~720
    // calls/day, which is how a check becomes expensive, then optional, then not
    // a monitor at all.
    ...(liveConcierge ? [ time(async () => {
      const meta = {
        name: "concierge answers rather than returning a fallback (live)",
        endpoint: "/api/support-chat",
        expected: "category-not-degraded",
      };
      const DEGRADED = [
        "concierge_unavailable",
        "concierge_model_error",
        "concierge_rate_limited",
        "concierge_overloaded",
      ];
      let res: Response;
      try {
        res = await smokeFetch(`${BASE_URL}/api/support-chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
          body: JSON.stringify({
            message: "What is Rip Packs City?",
            sessionId: `smoke-concierge-alive-${Date.now()}`,
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...meta, passed: false, soft: true, couldNotRun: true, detail: `inconclusive: probe could not reach the route (${msg})`, statusCode: null, bodyExcerpt: null, notes: { inconclusive: true } };
      }
      const rawBody = await res.text();
      if (!res.ok) {
        return { ...meta, passed: false, soft: true, couldNotRun: true, detail: `inconclusive: HTTP ${res.status}`, statusCode: res.status, bodyExcerpt: rawBody.slice(0, 500), notes: { inconclusive: true } };
      }
      const parsed = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
      if (!parsed) {
        return { ...meta, passed: false, soft: true, couldNotRun: true, detail: "inconclusive: unparseable body", statusCode: res.status, bodyExcerpt: rawBody.slice(0, 500), notes: { inconclusive: true } };
      }
      const category = String(parsed?.category ?? "");
      const degraded = DEGRADED.includes(category);
      return {
        ...meta,
        passed: !degraded,
        detail: degraded
          ? `CONCIERGE IS NOT ANSWERING: category=${category}. The route returns HTTP 200 with a fallback, so it looks healthy from outside — check the ANTHROPIC_API_KEY's balance and its workspace SPEND LIMIT (a 403 credit_balance presents exactly like this).`
          : `answered (category=${category || "none"})`,
        statusCode: res.status,
        bodyExcerpt: degraded ? rawBody.slice(0, 500) : null,
        notes: { category },
      };
    }, {
      name: "concierge answers rather than returning a fallback (live)",
      endpoint: "/api/support-chat",
      expected: "category-not-degraded",
    }) ] : []),

    ...(liveConcierge ? [ time(async () => {
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
    }) ] : []),

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
      // Connection-pool exhaustion / statement timeout at the :00/:06 cron rush
      // surfaces as status:"error" with a TRANSIENT_RX message ("Timed out
      // acquiring connection from connection pool"). That's DB-IO load, not a
      // filter-logic regression — report SOFT inconclusive (never Sentry, per
      // the !passed && !soft gate) instead of hard-failing. (Sentry NEXTJS-13.)
      if (parsed.status === "error" && TRANSIENT_RX.test(parsed.message ?? "")) {
        return { ...meta, passed: false, soft: true, detail: `inconclusive: transient db error (${parsed.message})`, statusCode: null, bodyExcerpt: null, notes: { inconclusive: true, warn: "pinnacle_transient" } };
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

    // RETIRED 2026-08-14: "Pinnacle FMV not borrowed across characters (drift
    // guard)". It asserted that every priced row searchPinnacleDeals returns has
    // a matching (character, set, variant) triple in pinnacle_catalog — but the
    // deals rows ARE pinnacle_catalog rows, mapped straight through, so the
    // triple was guaranteed present and the check could not fail for its stated
    // reason. It went tautological when a9f86af moved the Pinnacle FMV source
    // off pinnacle_editions onto the catalog; nothing failed, so nothing said so.
    // Cost while it lived: Sentry JAVASCRIPT-NEXTJS-14, 54 hard pages since
    // 2026-05-11, every one verified false — the ufc_fmv_stale_hours failure
    // exactly, an arm that trains the operator to skim past the board.
    //
    // The filed recommendation was to RE-POINT it at pinnacle_fmv_history by
    // render_id. That was measured and REJECTED: pinnacle_fmv_history is not an
    // independent source, it is written by an AFTER INSERT/UPDATE TRIGGER on
    // pinnacle_catalog, so the comparison is the same tautology one hop removed —
    // except where the trigger drops a row, which it does for 776 renders (see
    // docs/overnight/inbox/2026-08-15T0620Z-pinnacle-fmv-history-silently-drops-the-ask-only-revision.md).
    // Re-pointing would have shipped a guard that pages immediately on a
    // history-capture bug while still saying nothing about FMV drift.
    //
    // Nothing replaces it at RUNTIME because the property is now enforced by
    // CONSTRUCTION: searchPinnacleDeals reads ask and FMV from the SAME catalog
    // row, so there is no join across which a character's FMV could leak. That
    // is what the retired guard was really protecting, and it is pinned
    // statically instead by __tests__/pinnacle-router-fmv-same-row-guard.test.ts,
    // which fails if anyone reintroduces a cross-table FMV read into the router.
    // The sibling "filters character_name correctly" probe above still covers the
    // query-shape risk at runtime.

    // Concierge name-filter regression — Pinnacle Goofy — LIVE LLM call, gated.
    ...(liveConcierge ? [ time(async () => {
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
    }) ] : []),

    // Concierge name-filter regression — Top Shot LeBron — LIVE LLM call, gated.
    // No standalone Top Shot router lib exists to assert directly (unlike
    // searchPinnacleDeals), so TS end-to-end concierge coverage lives in this
    // daily-only probe; per-tick the route plumbing is still covered by the
    // graceful-degradation probe below.
    ...(liveConcierge ? [ time(async () => {
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
    }) ] : []),

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
        // A check that ERRORED never evaluated its assertion, so titling it
        // "smoke test failed: <assertion>" sends the triager hunting a bug that
        // may not exist — and for the security guards it reads as a live breach.
        // Distinct prefix ⇒ distinct Sentry issue group, so infra noise during a
        // saturation window cannot bury a real violation in the same thread.
        scope.setTag("failure_kind", r.couldNotRun ? "check_errored" : "assertion_violated");
        Sentry.captureMessage(
          (r.couldNotRun ? "smoke check could not run: " : "smoke test failed: ") + r.name,
          "error",
        );
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
    `${liveConcierge ? " [+live-concierge]" : ""}` +
    ` hard ${hardPassed}/${hardTotal} overall ${passed}/${total}` +
    (failures.length > 0 ? ` failing=[${failingEndpointsBrief}]` : "") +
    (softFailures.length > 0 ? ` soft_failing=[${softFailingEndpointsBrief}]` : "");
  console.log(headline);
  if (failures.length > 0) {
    console.error("SMOKE-TEST HARD FAILURES:", JSON.stringify(failures.map((f) => ({ endpoint: f.endpoint, error: f.detail, status: f.statusCode })), null, 2));
    // Push to ops channels on HARD failures only (soft/external-dep failures
    // are expected to flake and stay GitHub-native). The per-check retry-once
    // already filters transient infra timeouts. Debounced 60m.
    await sendOpsAlert({
      key: "smoke-test",
      cooldownMinutes: 60,
      subject: `\u{1F6A8} RPC smoke-test: ${failures.length} hard failure(s)`,
      text:
        `Smoke test hard failures (hard ${hardPassed}/${hardTotal}):\n` +
        failures
          .map((f) => `  • ${f.endpoint}${f.statusCode != null ? ` (${f.statusCode})` : ""}: ${f.detail ?? "failed"}`)
          .join("\n"),
    });
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
    liveConcierge,
    ranAt,
    results,
  }, { status: 200 });
}

// The live `/api/support-chat` LLM probes run only when explicitly requested
// (?concierge=1 — wire a once-daily cron-job.org call) OR inside a narrow daily
// UTC window so a broken concierge still trips at least once/day even before the
// operator wires that cron. Default (per-tick run) skips them entirely.
function wantsLiveConcierge(req: Request): boolean {
  try {
    const q = (new URL(req.url).searchParams.get("concierge") ?? "").toLowerCase();
    if (q === "1" || q === "true" || q === "full" || q === "live") return true;
  } catch {
    /* fall through to the time window */
  }
  const now = new Date();
  // ~09:00–09:24 UTC (≈02:00 PT). Cadence is ~20-40 min, so a tick lands here
  // ~once/day (rarely twice — still a ~99% cut from per-tick). If the operator
  // wires the explicit ?concierge=1 daily cron, that is the reliable path.
  return now.getUTCHours() === 9 && now.getUTCMinutes() < 25;
}

export async function POST(req: Request) {
  try {
    return await runSmokeTests({ liveConcierge: wantsLiveConcierge(req) });
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

export async function GET(req: Request) {
  try {
    return await runSmokeTests({ liveConcierge: wantsLiveConcierge(req) });
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
