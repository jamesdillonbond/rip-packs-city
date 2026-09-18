// lib/pipeline/saturation.ts
//
// Shared classifier: was a pipeline/query error caused by DB SATURATION (a
// statement timeout, connection-pool exhaustion, or a fetch abort under load)
// rather than a real regression or data loss?
//
// A saturation error is INCONCLUSIVE — the DB was slow, not broken — so callers
// should treat it as a soft/warn ("db saturated") outcome instead of a hard
// failure that pages or pollutes pipeline health. Genuine threshold breaches
// (zero sales, stale FMV, a schema/security check that actually evaluated to a
// failure) are NOT saturation and must still be surfaced normally.
//
// Mirrors the classifier originally inlined in app/api/sentinel/route.ts; kept
// here so other monitoring surfaces (analytics-smoke, …) can share one list.

export function isSaturationError(msg: string | undefined | null): boolean {
  // Empty/missing message: supabase-js surfaces aborted/undici failures under
  // load as { message: "" }. An empty error can never PROVE a real failure, so
  // treat it as inconclusive-saturated (warn), not hard-fail.
  if (!msg) return true;
  const m = String(msg).toLowerCase();
  return (
    m.includes("statement timeout") ||
    m.includes("canceling statement") ||
    m.includes("connection pool") ||
    m.includes("timeout acquiring") ||
    m.includes("connection terminated") ||
    m.includes("upstream request timeout") ||
    m.includes("fetch failed") ||
    m.includes("the operation was aborted") ||
    m.includes("aborted") ||
    m.includes("57014") || // postgres query_canceled SQLSTATE
    // ── GATEWAY responses only, added 2026-09-18 (register #122) ──────────
    // A read that came back as a WEB PAGE never reached Postgres, so it cannot
    // prove a threshold was breached and must warn rather than page. Added after
    // the Supabase outage, where the project origin answered at the CLOUDFLARE
    // edge with a 522 — callers got an HTML DOCUMENT where JSON belongs, and
    // this classifier, which already knew "connection terminated", did not know
    // that shape. ⚠ Note "connection timed out" is NOT "connection terminated";
    // the list above matches only the latter, which is how a 522 slipped past.
    //
    // ⛔ DELIBERATELY NOT INCLUDED: ECONNREFUSED / ECONNRESET / ETIMEDOUT /
    // "socket hang up" / a bare "connection timed out". I added them, and
    // `api-sentinel-branches` caught it — its "hard (non-saturation)
    // sniper-feed error" arm uses ECONNREFUSED precisely because a refused
    // connection to one of OUR OWN services is a real outage that SHOULD page.
    //
    // ⭐ THE LESSON, because the same token list appears in lib/api-error.ts and
    // the right answer there is the OPPOSITE: that classifier asks "should the
    // CLIENT RETRY" (a transport failure → yes), this one asks "should we PAGE"
    // (a transport failure → yes, page). **Same strings, opposite verdicts,
    // because the decisions differ.** Do not unify them.
    m.includes("<!doctype html") ||
    m.includes("522:") ||
    m.includes("523:") ||
    m.includes("524:")
  );
}
