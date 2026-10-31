// lib/user-quota-key.ts
//
// 2026-10-31: a signed-in account with no wallet is quota-keyed `user:<auth uuid>` —
// the same key /api/telemetry and the concierge's usage rows already write for that
// account. check_feature_quota / record_feature_usage are text-keyed and resolve such
// a key to the free plan. Its own module (not lib/pro-tier) so callers that mock
// pro-tier keep a real key builder.

export const USER_QUOTA_KEY_RE = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function userQuotaKey(userId: string | null | undefined): string | null {
  const key = typeof userId === "string" ? `user:${userId.trim().toLowerCase()}` : ""
  return USER_QUOTA_KEY_RE.test(key) ? key : null
}
