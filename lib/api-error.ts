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

/** A response body shape safe to serialize to any client. */
export interface SafeApiError {
  /** Human-facing copy. Rendered as-is by several clients, so keep it plain. */
  error: string;
  /** Stable machine code for the client/telemetry to branch on. */
  code: "timeout" | "unavailable" | "not_found" | "bad_request" | "internal";
  /** True when simply trying again later is a reasonable action. */
  retryable: boolean;
}

/** Postgres/PostgREST codes that mean "the database gave up", not "you asked wrong". */
const TIMEOUT_SQLSTATES = new Set([
  "57014", // query_canceled — statement_timeout
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
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
