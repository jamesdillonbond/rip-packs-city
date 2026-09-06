"use client"

// components/telemetry/ClientErrorBeacon.tsx
//
// THE client-side error detector (2026-09-06, known-issues #34 / go-live bar M7).
//
// Until this shipped a browser-only failure was captured by NOTHING: Sentry has
// dropped every event since 08-18 (quota), Vercel sees only server execution,
// and no `window.onerror` existed — the scheduled DOM smoke was the entire
// detection surface, on a handful of URLs, once a night. Trevor delegated the
// decision (Sentry money vs. a free beacon); this is the free beacon, and it can
// coexist with Sentry if that is ever re-enabled.
//
// What it does: on `error` and `unhandledrejection` it POSTs ONE small row to
// `/api/telemetry` (`feature: "client_error"`, public at the proxy, written via
// `after()`), keyed so the reader can group: message, source file, line/col, a
// bounded stack, the page path, the viewport width, and a coarse UA. No cookies,
// no query strings (a `?verify=` or a magic-link fragment must never land in a
// row), no user identity beyond what the route already resolves server-side.
//
// What it refuses to do: flood. Per page load it sends at most MAX_PER_LOAD
// events and never the same (message, source, line) twice — a render loop that
// throws 10,000 times is ONE row, which is what a reader wants. It also skips
// the two classes that are noise by construction: cross-origin "Script error."
// with no detail, and `ResizeObserver loop` warnings.
//
// How it is READ: `select … from usage_events where feature_name = 'client_error'
// and occurred_at > now() - interval '24 hours'` grouped by metadata->>'message'
// — and the pipeline-alerts `client_errors` arm (migration
// `audit_20260906_client_error_beacon_arm`) raises medium when a single message
// recurs across ≥ 5 distinct paths or ≥ 25 times in 24 h. Prove the watcher can
// see a failure before trusting it: throw in the console on prod and read the row.

import { useEffect } from "react"

const MAX_PER_LOAD = 6
const MAX_FIELD = 300
const MAX_STACK = 1200

export function clientErrorPayload(input: {
  kind: "error" | "unhandledrejection"
  message: unknown
  source?: unknown
  lineno?: unknown
  colno?: unknown
  stack?: unknown
  path: string
  width: number
  ua: string
}): { feature: string; metadata: Record<string, unknown> } {
  const s = (v: unknown, max = MAX_FIELD) => (typeof v === "string" ? v.slice(0, max) : v == null ? null : String(v).slice(0, max))
  return {
    feature: "client_error",
    metadata: {
      kind: input.kind,
      message: s(input.message),
      source: s(input.source),
      line: typeof input.lineno === "number" ? input.lineno : null,
      col: typeof input.colno === "number" ? input.colno : null,
      stack: s(input.stack, MAX_STACK),
      // Path ONLY — never `location.href` (query strings can carry tokens).
      path: s(input.path),
      width: input.width,
      ua: s(input.ua, 120),
    },
  }
}

/** Errors that carry no actionable detail; sending them only buries the real ones. */
export function isNoiseError(message: unknown, source: unknown): boolean {
  const m = typeof message === "string" ? message : ""
  if (/^Script error\.?$/i.test(m) && !source) return true
  if (/ResizeObserver loop/i.test(m)) return true
  return false
}

export function dedupeKey(message: unknown, source: unknown, lineno: unknown): string {
  return `${String(message ?? "").slice(0, 120)}|${String(source ?? "").slice(0, 120)}|${String(lineno ?? "")}`
}

export default function ClientErrorBeacon() {
  useEffect(() => {
    if (typeof window === "undefined") return
    let sent = 0
    const seen = new Set<string>()

    const send = (payload: { feature: string; metadata: Record<string, unknown> }) => {
      try {
        const body = JSON.stringify(payload)
        // sendBeacon survives page unload; keepalive fetch is the fallback.
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          const ok = navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }))
          if (ok) return
        }
        void fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {})
      } catch {
        /* a failing beacon must never throw into the page it is watching */
      }
    }

    const report = (kind: "error" | "unhandledrejection", message: unknown, source: unknown, lineno: unknown, colno: unknown, stack: unknown) => {
      if (sent >= MAX_PER_LOAD) return
      if (isNoiseError(message, source)) return
      const key = dedupeKey(message, source, lineno)
      if (seen.has(key)) return
      seen.add(key)
      sent += 1
      send(
        clientErrorPayload({
          kind,
          message,
          source,
          lineno,
          colno,
          stack,
          path: window.location.pathname,
          width: window.innerWidth,
          ua: navigator.userAgent,
        }),
      )
    }

    const onError = (e: ErrorEvent) => {
      const err = e.error as { stack?: unknown } | undefined
      report("error", e.message, e.filename, e.lineno, e.colno, err && typeof err === "object" ? err.stack : undefined)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: unknown; stack?: unknown } | undefined
      const message = r && typeof r === "object" && "message" in r ? r.message : r
      const stack = r && typeof r === "object" && "stack" in r ? r.stack : undefined
      report("unhandledrejection", message, undefined, undefined, undefined, stack)
    }

    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
    }
  }, [])

  return null
}
