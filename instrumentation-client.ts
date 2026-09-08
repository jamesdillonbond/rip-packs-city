// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { SHARED_SENTRY_OPTIONS } from "@/lib/observability/sentry-quota-guard";


Sentry.init({
  dsn: "https://a3f2b01b1923ae3282262d55a793b051@o4511283179159552.ingest.us.sentry.io/4511283198623744",

  // ⛔ DISABLED ON THE CLIENT 2026-09-07 (Trevor: "we're not upgrading Sentry unless we
  // absolutely need to"). The org error quota has been exhausted since 2026-08-18
  // (known-issues #34) — every browser event and 10 % of traces were POSTed to
  // sentry.io and answered 429, carrying `sendDefaultPii` user data to a sink
  // nobody reads. The client-side detector is components/telemetry/ClientErrorBeacon.tsx
  // (`usage_events.client_error` + the pipeline-alerts `client_errors` arm), proven
  // on prod 2026-09-06 and again 2026-09-08. `enabled: false` stops the transport and
  // the traces; the SDK code itself still ships (~37 KB gz of the ~285 KB gz homepage
  // JS, measured 2026-09-08) until the dependency is removed — see #34 for that handoff.
  enabled: false,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 0,

  // Do not send user PII to a third party that is not receiving events.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,

  // Bound how much of the org's finite error quota one already-tracked signature
  // may consume. Measured 2026-08-25: the org quota was exhausted
  // (`error_usage_exceeded`) and one RPC-timeout signature alone produced 15,388
  // events in a week. See lib/observability/sentry-quota-guard.ts for the rule and
  // for why the default is SEND.
  ...SHARED_SENTRY_OPTIONS,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
