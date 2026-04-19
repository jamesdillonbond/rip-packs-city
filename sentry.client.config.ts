// sentry.client.config.ts — Browser-side Sentry initialization
// Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  enabled: process.env.NODE_ENV === "production",

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.1,
  profilesSampleRate: 0,

  // Session replay: capture 1% normally, 100% on error.
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration(),
  ],
})
