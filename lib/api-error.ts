// lib/api-error.ts
//
// Turn a thrown value into something safe to put in an API response body.
//
// WHY THIS EXISTS (deep-audit D3). /api/sets caught its error, extracted
// `err.message`, and returned it to the browser, where the sets page renders
// `body.error` verbatim under an "ERROR" heading. Under disk-IO saturation that
// message is Postgres's own text, so the flagship Top Shot Set Tracker showed
// end users:
//
//     ERROR
//     canceling statement due to statement timeout
//
// Two defects in one: the page is dead, and it leaks internal database detail to
// anonymous visitors. The leak was introduced by an earlier well-intentioned fix
// — the message used to render as "[object Object]" because Supabase throws a
// PostgrestError (a plain object, not an Error), and the repair reached for the
// real message without asking whether the real message was publishable.
//
// The rule: classify server-side, log the detail, return a stable code plus copy
// a human can act on. Never pass a driver message through.

import { NextResponse } from "next/server";
import { RPC_READ_TIMEOUT_CODE } from "@/lib/api/bounded-read";

/** A response body shape safe to serialize to any client. */
export interface SafeApiError {
  /** Human-facing copy. Rendered as-is by several clients, so keep it plain. */
  error: string;
  /** Stable machine code for the client/telemetry to branch on. */
  code: "timeout" | "unavailable" | "not_found" | "bad_request" | "internal";
  /** True when simply trying again later is a reasonable action. */
  retryable: boolean;
}

/**
 * Codes that mean "the read gave up", not "you asked wrong".
 *
 * 🚨 `RPC_READ_TIMEOUT` was ADDED 2026-09-04 and it is not a SQLSTATE — it is the
 * code `lib/api/bounded-read.ts` stamps when OUR client-side bound fires. Until
 * it was here, a bound timeout matched nothing in this function: its message is
 * "[route] read exceeded 8000ms", which contains none of the substrings below.
 * So it fell through to the generic branch and all **86 routes** pairing
 * `boundedRead` with `apiErrorResponse` answered a timeout as
 * `{ code: "internal", retryable: false }` at status **500**, with no
 * `Retry-After` — telling the caller a transient failure was permanent.
 *
 * ⭐ Measured live on `/api/collection-stats` before the fix: **500 at 8.2 s,
 * then 200 at 4.0 s on the very next request.** The one thing the caller should
 * have done was the one thing the response told it not to do.
 *
 * ⚠ The import is deliberate — the string is not re-typed here, because a typo
 * on either side fails OPEN (back to a silent non-retryable 500).
 */
const TIMEOUT_SQLSTATES = new Set<string>([
  "57014", // query_canceled — statement_timeout
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  RPC_READ_TIMEOUT_CODE, // our own client-side read bound
]);

function readCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

function readMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/**
 * Classify a thrown value into a publishable error.
 *
 * Matches on SQLSTATE first and only falls back to message sniffing, because a
 * PostgrestError carries `code` reliably while its message wording is not a
 * contract. Anything unrecognized becomes a generic internal error — the
 * default is to say LESS, not to pass the message through.
 */
export function safeApiError(err: unknown, fallback = "Something went wrong."): SafeApiError {
  const code = readCode(err);
  const message = readMessage(err).toLowerCase();

  if (
    (code && TIMEOUT_SQLSTATES.has(code)) ||
    message.includes("statement timeout") ||
    message.includes("canceling statement") ||
    message.includes("timeout acquiring") ||
    message.includes("connection pool")
  ) {
    return {
      error:
        "This is taking longer than it should right now — the database is under heavy load. Try again in a minute.",
      code: "timeout",
      retryable: true,
    };
  }

  // PostgREST surfaces a missing relation/function as 42P01/42883. That is a
  // deploy/schema problem, never the caller's fault, and its text names internal
  // objects — so it is reported as unavailable without detail.
  if (code === "42P01" || code === "42883") {
    return { error: "This data isn't available right now.", code: "unavailable", retryable: true };
  }

  return { error: fallback, code: "internal", retryable: false };
}

/** HTTP status that goes with a classified error. */
export function statusForSafeError(e: SafeApiError): number {
  switch (e.code) {
    case "timeout":
      // 503 + Retry-After, not 500: this is transient capacity, and it keeps the
      // route out of the hard-5xx budget that pages on genuine breakage.
      return 503;
    case "unavailable":
      return 503;
    case "not_found":
      return 404;
    case "bad_request":
      return 400;
    default:
      return 500;
  }
}

// ── The response builder ────────────────────────────────────────────────────
//
// safeApiError classifies; this turns the classification into the actual
// NextResponse, so every anon-reachable route ends its failure path the same
// way. It exists because the classify-then-hand-roll-the-response version was
// only ever applied where someone happened to look: D3 fixed /api/sets, the
// 2026-08-11 sweep fixed the 29 /api/public/insights routes, and a sweep of the
// routes proxy.ts actually lets anonymous visitors reach then found 43 more
// sites across 33 files still returning `{ error: error.message }` — Postgres's
// own text, published to anyone, at a 500 that inflates the hard-5xx budget.

/**
 * Callers hand us three different error shapes:
 *   - a PostgrestError object  (`.from(...)` / `.rpc(...)`)
 *   - a thrown Error           (catch blocks)
 *   - a bare STRING            (lib/supabase-paginate returns `error: string`)
 * safeApiError's message reader only understands the first two, so a bare string
 * would fall through to "internal" and a statement timeout would be reported as
 * a 500 instead of a retryable 503. Normalize before classifying.
 */
function normalizeErr(err: unknown): unknown {
  return typeof err === "string" ? { message: err } : err;
}

/** Detail for the SERVER LOG only — never merged into the response body. */
export function errorLogDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    return `${code}${code && message ? " " : ""}${message}`.trim() || String(err);
  }
  return String(err);
}

/**
 * Build the publishable failure response for an API route.
 *
 * Two things this adds on top of a bare safeApiError() call, both load-bearing:
 *
 *  1. `Cache-Control: no-store`. Many of these routes set a PUBLIC edge cache on
 *     their success response (`s-maxage=300`..`3600`). Without an explicit
 *     no-store on the failure, a transient 503 risks being held at the CDN and
 *     served to everyone for the rest of the TTL — pinning a momentary blip into
 *     a sustained outage.
 *  2. `Retry-After` when the classification says retrying is reasonable, so the
 *     status is actionable rather than merely honest.
 *
 * @param err      the PostgrestError (or thrown value) — logged, never published
 * @param tag      log scope, normally the route path (e.g. "api/market")
 * @param fallback human copy for an unclassified failure
 */
export function apiErrorResponse(
  err: unknown,
  tag: string,
  fallback = "Something went wrong."
): NextResponse {
  const safe = safeApiError(normalizeErr(err), fallback);
  // Detail goes to the log so the failure is still diagnosable in Vercel.
  console.error(`[${tag}] code=${safe.code} detail=${errorLogDetail(err)}`);
  return NextResponse.json(safe, {
    status: statusForSafeError(safe),
    headers: {
      "Cache-Control": "no-store",
      ...(safe.retryable ? { "Retry-After": "30" } : {}),
    },
  });
}

/**
 * A "we couldn't turn that username into a wallet" failure is a CALLER error,
 * not an internal one, and its copy is OUR OWN — written for the user, not by a
 * driver. Classifying it as `internal` (which is what safeApiError does, since
 * it only knows Postgres) replaces the one thing the user needed to be told
 * with "Something went wrong.", and returns 500 for what is really a 400.
 *
 * The check is on the message because that is where the routes' own resolvers
 * encode it (`throw new Error("Could not resolve …")`). Reading a message
 * server-side to CLASSIFY is fine; what must never happen is publishing it, so
 * callers of this pair return fixed copy rather than the message itself.
 */
export function isUnresolvedIdentifierError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /could not resolve/i.test(m);
}

/** The publishable 400 for the above. Fixed copy — never the thrown message. */
export function unresolvedIdentifierResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "We couldn't find that wallet or username. Check the spelling and try again.",
      code: "not_found" as const,
      retryable: false,
    },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );
}
