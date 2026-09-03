// Turning an API error response into something a person can act on.
//
// ⚠ THE CONVENTION THIS EXISTS FOR. Several routes deliberately send BOTH a
// machine code and human copy:
//
//   { error: "plan_limit_reached",
//     message: "Free plan supports 3 saved wallets. Remove the wallet you have
//               saved, or upgrade to RPC Pro.",
//     upgrade_url: "/pricing" }
//
// `DashboardClient` threw `data.error` at five call sites, so a user who hit the
// wallet cap was shown the literal string **"plan_limit_reached"** while the
// sentence written for them sat unused in the same payload. The route author
// wrote the copy; the client discarded it.
//
// ⚠ `error` is NOT always a slug — most routes put human text there
// ("Couldn't find that Dapper username…"). So this PREFERS `message` and falls
// back to `error`, which is a strict improvement: routes that send only `error`
// are unaffected, routes that send both stop leaking the code.
//
// ⓘ Unlike /login?error=, this value is our own API's response body rather than
// a query string, so there is nothing attacker-controlled to allowlist here.
// The defect is a discarded field, not an injected one.

/** Human-facing text for a failed fetch, given the parsed body and the status. */
export function apiErrorMessage(body: unknown, status: number): string {
  const data = (body ?? {}) as { message?: unknown; error?: unknown };
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  return `HTTP ${status}`;
}
