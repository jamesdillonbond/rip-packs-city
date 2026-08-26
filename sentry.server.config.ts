// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { SHARED_SENTRY_OPTIONS } from "@/lib/observability/sentry-quota-guard";


Sentry.init({
  dsn: "https://a3f2b01b1923ae3282262d55a793b051@o4511283179159552.ingest.us.sentry.io/4511283198623744",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 0.1,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Bound how much of the org's finite error quota one already-tracked signature
  // may consume. Measured 2026-08-25: the org quota was exhausted
  // (`error_usage_exceeded`) and one RPC-timeout signature alone produced 15,388
  // events in a week. See lib/observability/sentry-quota-guard.ts for the rule and
  // for why the default is SEND.
  ...SHARED_SENTRY_OPTIONS,
});
