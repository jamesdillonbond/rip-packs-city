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
    m.includes("57014") // postgres query_canceled SQLSTATE
  );
}
