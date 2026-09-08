// sentry.client.config.ts — Browser-side Sentry initialization
// Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  // ⛔ DISABLED 2026-09-07 — see instrumentation-client.ts (the file Next actually
  // loads; this legacy config is kept only so the Sentry build plugin finds it).
  enabled: false,

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.1,
  profilesSampleRate: 0,

  // Session replay removed 2026-09-07 with the client disable — a replay recorder
  // buffering DOM mutations for a dead quota is pure cost.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
})
