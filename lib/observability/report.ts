// lib/observability/report.ts — the server-side error/event record after Sentry.
//
// WHY THIS EXISTS (known-issues #34, closed 2026-09-18). Sentry accepted its last
// event on 2026-08-18 (org error quota exhausted) and Trevor decided on
// 2026-09-07 not to buy more: the browser SDK was switched off then, and the
// client-side detector is components/telemetry/ClientErrorBeacon.tsx →
// `usage_events.client_error`. The SDK itself still shipped — ~37 KB gz of the
// homepage's first-load JS (2026-09-08 sample) and a build plugin wrapping
// next.config — for a sink that stored nothing. Removing the dependency left the
// five server routes that called `Sentry.withScope/captureException/
// captureMessage/addBreadcrumb` needing a destination.
//
// ⚠ THE DESTINATION IS THE VERCEL RUNTIME LOG, and this module is deliberately
// the same API SUBSET the routes already called, so each route's diff is its
// import line and every existing test assertion (tags reach the exception, a
// rate-gated "page" is emitted or not, breadcrumbs are attached) still pins the
// same property. `get_runtime_errors` groups on the bracketed prefix, so every
// line here starts with `[report]`.
//
// ⛔ NOT a paging channel. Sentry never paged either — the quota was dead — so
// nothing that mattered lost a destination; the rate-gated `captureMessage`
// calls in the listings indexers were the only "page" semantic and they were
// already going nowhere. The fleet alarm is the sentinel (`/api/sentinel`) and
// the pipeline-alerts arms; this is the forensic record beside them.

type Level = "fatal" | "error" | "warning" | "log" | "info" | "debug"

export interface Scope {
  setTag(key: string, value: string): void
  setExtra(key: string, value: unknown): void
}

export interface Breadcrumb {
  category?: string
  level?: Level
  message?: string
  data?: Record<string, unknown>
}

export interface CaptureContext {
  level?: Level
  tags?: Record<string, string>
  extra?: Record<string, unknown>
}

// Sentry kept breadcrumbs in memory and attached them to the NEXT event rather
// than emitting one line per crumb — a listings tick can add hundreds. Same
// here: a bounded ring, drained into the next capture.
const MAX_BREADCRUMBS = 50
let breadcrumbs: Breadcrumb[] = []
let current: { tags: Record<string, string>; extra: Record<string, unknown> } | null = null

function drainBreadcrumbs(): Breadcrumb[] {
  const out = breadcrumbs
  breadcrumbs = []
  return out
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function emit(level: Level, label: string, payload: Record<string, unknown>, err?: unknown): void {
  const line = `[report] ${label} ${safe(payload)}`
  if (level === "fatal" || level === "error") {
    if (err !== undefined) console.error(line, err)
    else console.error(line)
  } else if (level === "warning") {
    console.warn(line)
  } else {
    console.log(line)
  }
}

/** Run `cb` with a scope whose tags/extra attach to any capture made inside it. */
export function withScope(cb: (scope: Scope) => void): void {
  const prev = current
  const tags: Record<string, string> = prev ? { ...prev.tags } : {}
  const extra: Record<string, unknown> = prev ? { ...prev.extra } : {}
  current = { tags, extra }
  try {
    cb({
      setTag: (k, v) => {
        tags[k] = v
      },
      setExtra: (k, v) => {
        extra[k] = v
      },
    })
  } finally {
    current = prev
  }
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  breadcrumbs.push(crumb)
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs = breadcrumbs.slice(-MAX_BREADCRUMBS)
}

export function captureException(err: unknown, ctx?: CaptureContext): void {
  const tags = { ...(current?.tags ?? {}), ...(ctx?.tags ?? {}) }
  const extra = { ...(current?.extra ?? {}), ...(ctx?.extra ?? {}) }
  const message = err instanceof Error ? err.message : String(err)
  emit(ctx?.level ?? "error", "exception", { message, tags, extra, breadcrumbs: drainBreadcrumbs() }, err)
}

/** `captureMessage(msg, "error")` and `captureMessage(msg, { level, tags, extra })` both work. */
export function captureMessage(message: string, ctx?: Level | CaptureContext): void {
  const c: CaptureContext = typeof ctx === "string" ? { level: ctx } : (ctx ?? {})
  const tags = { ...(current?.tags ?? {}), ...(c.tags ?? {}) }
  const extra = { ...(current?.extra ?? {}), ...(c.extra ?? {}) }
  emit(c.level ?? "info", "message", { message, tags, extra, breadcrumbs: drainBreadcrumbs() })
}

/**
 * Next's `onRequestError` hook (instrumentation.ts): an unhandled error in a
 * route or server component. Previously Sentry.captureRequestError; the same
 * facts now go to the runtime log, where they were the only place anyone read
 * them anyway.
 */
export function captureRequestError(
  err: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; routeType?: string },
): void {
  captureException(err, {
    tags: {
      route: String(context.routePath ?? request.path ?? ""),
      method: String(request.method ?? ""),
      routeType: String(context.routeType ?? ""),
      routerKind: String(context.routerKind ?? ""),
    },
  })
}

/** Test seam: what is currently buffered, without draining it. */
export function pendingBreadcrumbs(): readonly Breadcrumb[] {
  return breadcrumbs
}
