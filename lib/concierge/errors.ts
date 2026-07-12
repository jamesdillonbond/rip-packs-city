// Concierge error classification + canned user-facing messages.
//
// Extracted from app/api/support-chat/route.ts (2026-07) so this pure logic —
// the map from an Anthropic API failure to a user-facing error mode — can be
// unit-tested in isolation. The route imports these back; behavior is
// unchanged. No DB, no network, no side effects.

// Bare-greeting detector — short-circuits the model call for "hi" / "gm" / etc.
export const GREETING_RE =
  /^\s*(hi+|hello|ping|hey+|sup|test|yo|hola|howdy|gm|gn)\s*[!.?]*\s*$/i

export type ConciergeErrorMode =
  | "credit_balance"
  | "model_error"
  | "rate_limit"
  | "overloaded"
  | "unknown"

export function classifyAnthropicError(err: any): ConciergeErrorMode {
  const status: number = Number(err?.status ?? 0)
  const errType: string = String(
    err?.type ?? err?.error?.error?.type ?? err?.error?.type ?? ""
  )
  const msg: string = String(err?.message ?? err ?? "").toLowerCase()
  const name: string = String(err?.name ?? "")

  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    errType === "authentication_error" ||
    errType === "permission_error" ||
    /credit\s*balance|insufficient[_\s]+(?:funds|credit|balance)|invalid[_\s]+api[_\s]+key|billing/.test(
      msg
    )
  ) {
    return "credit_balance"
  }
  // Model retired / not found. This route names only ONE remote resource — the
  // model — so a 404 / not_found_error here is overwhelmingly a model problem.
  // Classify it distinctly so it pages instead of hiding in "unknown".
  if (
    status === 404 ||
    errType === "not_found_error" ||
    /\bmodel\b[^.]*\b(not[_\s]*found|retired|deprecat|unavailable|does not exist)\b|model:\s/.test(
      msg
    )
  ) {
    return "model_error"
  }
  if (
    status === 429 ||
    errType === "rate_limit_error" ||
    /rate[_\s]*limit/.test(msg)
  ) {
    return "rate_limit"
  }
  if (
    status >= 500 ||
    errType === "overloaded_error" ||
    errType === "api_error" ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    /overloaded|connection|fetch failed|network|timeout|socket/.test(msg)
  ) {
    return "overloaded"
  }
  return "unknown"
}

export const CONCIERGE_ERROR_MESSAGES: Record<
  ConciergeErrorMode,
  { response: string; category: string }
> = {
  credit_balance: {
    response:
      "AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets.",
    category: "concierge_unavailable",
  },
  model_error: {
    response:
      "AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets.",
    category: "concierge_model_error",
  },
  rate_limit: {
    response:
      "AI concierge is busy. Please try again in a minute, or use the Sniper page directly.",
    category: "concierge_rate_limited",
  },
  overloaded: {
    response: "AI concierge is having a moment. Please try again shortly.",
    category: "concierge_overloaded",
  },
  unknown: {
    response:
      "Something went wrong on my end. Try again, or reach out to the team on Discord.",
    category: "error",
  },
}
