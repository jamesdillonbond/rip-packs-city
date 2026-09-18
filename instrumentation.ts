// instrumentation.ts — Next's server instrumentation hook.
//
// Sentry was retired 2026-09-18 (known-issues #34): its init files and the
// build-plugin wrapper are gone. What stays is the one hook that still has a
// reader: `onRequestError` receives every unhandled error in a route or server
// component, and the runtime log is where those were being read anyway.
import { captureRequestError } from "@/lib/observability/report"

export async function register() {
  // Nothing to initialise. Kept so the hook file exists and the export below
  // is picked up; a future tracer registers here.
}

export const onRequestError = captureRequestError
