// sentry.server.config.ts — Server-side Sentry initialization
// Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  enabled: process.env.NODE_ENV === "production",

  // Tie errors to environment + commit so Sentry can group by release.
  environment: process.env.VERCEL_ENV || "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  // Performance: sample 10% of transactions.
  tracesSampleRate: 0.1,
  // Profiling disabled — not needed for error tracking and costs extra quota.
  profilesSampleRate: 0,

  // Filter out noise: expected 404s and request aborts are not actionable.
  beforeSend(event, hint) {
    const err = hint?.originalException as { name?: string; message?: string; status?: number } | undefined
    if (err) {
      if (err.name === "AbortError") return null
      if (err.status === 404) return null
      const msg = typeof err.message === "string" ? err.message : ""
      if (msg.includes("ECONNRESET") || msg.includes("The operation was aborted")) return null
    }
    return event
  },
})
