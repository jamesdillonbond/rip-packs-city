// lib/redact-secrets.ts
//
// One redactor, shared, because the alternative is the documented copy-paste
// failure: a helper duplicated per call site drifts, and the copy that drifts
// is the one that leaks.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// 2026-08-30. The sentinel reported `telegram-FAILED` on a CRITICAL run and the
// REASON went to `console.error` only, so from outside the failure was
// unfalsifiable — a revoked token, a non-2xx and a thrown fetch all rendered
// identically. Surfacing the reason is the fix, and surfacing it is exactly
// what makes redaction load-bearing:
//
// 🚨 **THE TELEGRAM BOT TOKEN IS IN THE URL PATH** (`/bot<TOKEN>/sendMessage`).
// A thrown fetch whose message quotes the URL would otherwise write a live
// credential into `pipeline_runs.extra` and into the sentinel's JSON response —
// the transcript-leak class CLAUDE.md already paid for once.
//
// ⚠ TWO INDEPENDENT ARMS, and the second is not redundant:
//   1. Replace each secret VALUE this process holds.
//   2. Rewrite the token-bearing SHAPES (`/bot…`, `Bearer …`) regardless.
// Arm 1 cannot cover a token the process no longer holds (a rotation, a value
// read from a different env var, a partial echo). Arm 2 cannot cover a value
// that appears outside those shapes. Both are tested.

/**
 * Just the shape this module needs. ⚠ Deliberately NOT `NodeJS.ProcessEnv`,
 * which requires `NODE_ENV` and so cannot be satisfied by a test fixture
 * carrying only the keys under test.
 */
export type SecretEnv = Record<string, string | undefined>

/** The env vars whose values must never reach a log, a row, or a response. */
export function secretValues(env: SecretEnv = process.env): string[] {
  return [
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    env.RESEND_API_KEY,
    env.INGEST_SECRET_TOKEN,
    env.CRON_SECRET,
    env.RPC_ADMIN_TOKEN,
    env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length >= 8)
}

/**
 * Scrub secrets out of a string that is about to be published.
 *
 * ⚠ `length >= 8` is a guard against a SHORT env value turning the redactor
 * into a mangler: a 2-character token would replace every occurrence of those
 * two characters in the message and destroy the diagnosis this exists to give.
 */
export function redactSecrets(input: unknown, env: SecretEnv = process.env): string {
  let out = typeof input === "string" ? input : String(input ?? "")
  for (const secret of secretValues(env)) out = out.split(secret).join("***")
  // Shape-based, so it holds for a value this process does not hold.
  out = out.replace(/\/bot[^/\s"'&?]+/gi, "/bot***")
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
  return out
}
