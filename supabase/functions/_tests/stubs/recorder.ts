// Shared state between the stubs and auth_gate_test.ts. One module instance per
// `deno test` process, so every stub writes to the same arrays.

export type Call = { kind: "db" | "auth" | "fetch"; what: string }

export const calls: Call[] = []

// deno-lint-ignore no-explicit-any
type Handler = (req: Request, info?: any) => Response | Promise<Response>

export const served: { handler: Handler | null } = { handler: null }

export function reset() {
  calls.length = 0
}
