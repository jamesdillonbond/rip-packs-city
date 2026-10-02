// Stands in for https://deno.land/std/http/server.ts: `serve(handler)` only
// records the handler, it never listens.
import { served } from "./recorder.ts"

// The overload keeps std's call shape for the functions' type check; the
// implementation takes only what it uses.
// deno-lint-ignore no-explicit-any
export function serve(handler: any, opts?: unknown): Promise<void>
// deno-lint-ignore no-explicit-any
export function serve(handler: any): Promise<void> {
  served.handler = handler
  return Promise.resolve()
}
