// sentry.edge.config.ts — Edge runtime Sentry initialization
// Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  enabled: process.env.NODE_ENV === "production",

  environment: process.env.VERCEL_ENV || "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.1,
  profilesSampleRate: 0,

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
