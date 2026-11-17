// Shared state between the stubs and auth_gate_test.ts. One module instance per
// `deno test` process, so every stub writes to the same arrays.

/** `payload`: the first argument of a write (insert / upsert / update) or an rpc's params, as JSON. */
export type Call = { kind: "db" | "auth" | "fetch"; what: string; payload?: string }

export const calls: Call[] = []

// deno-lint-ignore no-explicit-any
type Handler = (req: Request, info?: any) => Response | Promise<Response>

export const served: { handler: Handler | null } = { handler: null }

/** Promises handed to EdgeRuntime.waitUntil — the work an `accepted` response leaves running. */
export const background: Promise<unknown>[] = []

export function reset() {
  calls.length = 0
  background.length = 0
}
