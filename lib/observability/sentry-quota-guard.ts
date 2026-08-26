// lib/observability/sentry-quota-guard.ts
//
// WHY THIS EXISTS — measured 2026-08-25 (PT), and it is the cause of the
// week-long Sentry blackout, not a tidy hypothesis:
//
//   POST https://o4511283179159552.ingest.us.sentry.io/api/4511283198623744/envelope/
//   -> HTTP 429
//      x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
//
// The organisation's ERROR quota is exhausted. Sentry accepted its last event on
// 2026-08-18T13:21:59Z and has dropped every event since — which is why every
// honesty-layer capture written after that date went nowhere.
//
// What exhausted it is ONE known, already-tracked degradation. From the bounded
// comment in app/(collections)/[collection]/edition/[slug]/page.tsx, measured over
// the 7 days to 2026-08-23:
//
//   "edition detail unavailable: rpc get_edition_detail timed out after 45000ms"
//     -> 15,388 events / 2,963 distinct users, in ONE week, from ONE error.
//
// So raising the quota ALONE does not fix this: the next quota burns the same way
// in about the same time. The durable half is here — bound how much of a finite
// shared quota any single already-tracked signature may consume, so that a NOVEL
// error still has somewhere to land.
//
// ⚠ THE HONESTY RULE THIS FILE HAD TO OBEY. Dropping errors is the error-channel
// version of "a failed read must not render as an answer": a silently thinned
// stream reads as a quieter system. Three things keep it honest:
//   1. DEFAULT IS SEND. Only signatures listed in KNOWN_HIGH_VOLUME below are
//      sampled. An unrecognised error is NEVER dropped — no catch-all, no
//      allowlist inversion. A new failure mode always arrives at full rate.
//   2. EVERY KEPT EVENT CARRIES ITS OWN SAMPLE RATE. `sentry_sample_rate` and
//      `sentry_sampled_signature` are set as tags on the events that survive, so
//      an issue's event count can be read back to an incidence (multiply by
//      1/rate) instead of being quietly wrong by 20x.
//   3. THE DROPS ARE COUNTED BY SENTRY ITSELF. Returning null from beforeSend
//      makes the SDK record a client report with reason `before_send`, which shows
//      up in Stats > Dropped. The true volume stays observable in the product; it
//      just stops costing quota.
//
// ⛔ This does NOT fix the underlying RPC timeouts, and must not be read as having
// done so. It stops a known-broken thing from blinding us to everything else.

/** An event Sentry is about to send. Structurally typed so this module can be unit
 *  tested without importing the SDK, and so it works for client, server and edge. */
export type MinimalSentryEvent = {
  message?: string
  exception?: {
    values?: Array<{ type?: string; value?: string }>
  }
  // ⚠ `unknown`, and NO string index signature. Both were measured, not guessed
  // (TS2345 on all three init files): Sentry's own `Primitive` includes `bigint`,
  // so a hand-written primitive union makes `ErrorEvent` unassignable here; and
  // `ErrorEvent` has no index signature, so adding one here breaks it the other
  // way. This type is the INTERSECTION the SDK's event actually satisfies.
  tags?: Record<string, unknown>
}

/**
 * Signatures we already track, that are high-volume, and whose incidence is
 * measurable from the database rather than from Sentry.
 *
 * `match` is deliberately a substring test on the fully-rendered message, NOT a
 * regex over a stack: the repo's own rule is to key on the property, not the
 * spelling, and the property here is "this is the RPC-deadline shape produced by
 * lib/analytics/rpc-with-retry.ts::timeoutError".
 *
 * `rate` is the fraction KEPT. 0.05 keeps 1 in 20.
 */
export const KNOWN_HIGH_VOLUME: ReadonlyArray<{
  signature: string
  match: (text: string) => boolean
  rate: number
}> = [
  {
    // `rpc <fn> timed out after <n>ms with no response` — RPC_TIMEOUT from
    // lib/analytics/rpc-with-retry.ts, and every page-level wrapper that
    // interpolates it ("edition detail unavailable: ...", "team detail ...", etc).
    signature: "rpc-deadline",
    match: (t) => t.includes("timed out after") && t.includes("with no response"),
    rate: 0.05,
  },
]

/** Everything Sentry will fingerprint on, flattened to one lowercase string. */
export function eventText(event: MinimalSentryEvent): string {
  const parts: string[] = []
  if (typeof event.message === "string") parts.push(event.message)
  for (const v of event.exception?.values ?? []) {
    if (v?.type) parts.push(v.type)
    if (v?.value) parts.push(v.value)
  }
  return parts.join(" ")
}

/**
 * The decision, pure and independently testable.
 * Returns the matching rule, or null when the event is not a known high-volume one.
 */
export function classify(event: MinimalSentryEvent) {
  const text = eventText(event)
  if (!text) return null
  for (const rule of KNOWN_HIGH_VOLUME) {
    if (rule.match(text)) return rule
  }
  return null
}

/**
 * `beforeSend` for Sentry.init(). Send by default; sample only the known list.
 *
 * `random` is injectable so the sampling decision is testable without stubbing
 * globals — CLAUDE.md's rule that a test must assert the contract, not a shape.
 */
export function makeBeforeSend(random: () => number = Math.random) {
  return function beforeSend(event: MinimalSentryEvent): MinimalSentryEvent | null {
    const rule = classify(event)
    if (!rule) return event // DEFAULT IS SEND — never drop an unrecognised error.
    if (random() >= rule.rate) return null // dropped; SDK records a client report
    event.tags = {
      ...(event.tags ?? {}),
      sentry_sampled_signature: rule.signature,
      sentry_sample_rate: rule.rate,
    }
    return event
  }
}

/**
 * Options shared by the client, server and edge inits so they cannot drift.
 *
 * ⚠ `environment` and `release` are here because, until now, they were set ONLY in
 * `sentry.client.config.ts` — which production's turbopack build never bundles
 * (filed 2026-08-24). So no event, on any runtime, has ever been attributable to a
 * deploy. Setting them on the three LIVE inits fixes that without touching the
 * dead file, and without adding session replay, which would consume more of the
 * quota this module exists to protect.
 *
 * The cast is confined to this one line: the module above is deliberately
 * SDK-free so `classify`/`makeBeforeSend` can be unit-tested without importing
 * `@sentry/nextjs`, and `SentryBeforeSend` is a TYPE-only import (no runtime cost).
 */
type SentryBeforeSend = NonNullable<Parameters<typeof import("@sentry/nextjs").init>[0]>["beforeSend"]

export const SHARED_SENTRY_OPTIONS = {
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || "development",
  release:
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
  beforeSend: makeBeforeSend() as SentryBeforeSend,
} as const
