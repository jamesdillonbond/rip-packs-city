// Stands in for supabase-js. `createClient` returns a client on which every
// property chain is RECORDED and every await resolves to a failed read, so a
// handler that touches the database before checking its caller is visible as a
// `db` call. Anything under `.auth`, and an `rpc` whose name contains
// `gate_key` (hybrid-custody-backfill reads its key from Vault that way), is
// recorded as `auth`: checking the caller IS the gate, not work done before it.
import { calls } from "./recorder.ts"

/** What `rpc("cron_gate_key", …)` returns here; the admitted probe presents it. */
export const VAULT_GATE_KEY = "test-value-VAULT_GATE_KEY"

const RESULT = {
  data: null,
  error: { message: "auth-gate test stub: no database", code: "STUB" },
  count: null,
  status: 503,
  statusText: "stub",
}

// deno-lint-ignore no-explicit-any
function chain(kind: "db" | "auth", path: string): any {
  const fn = () => {}
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") {
        // deno-lint-ignore no-explicit-any
        return (resolve: (v: any) => unknown) => resolve(kind === "auth" ? { data: { user: null, session: null }, error: RESULT.error } : RESULT)
      }
      if (typeof prop === "symbol") return undefined
      return chain(kind, path ? `${path}.${prop}` : prop)
    },
    apply(_t, _this, args) {
      const first = typeof args[0] === "string" ? `(${args[0]})` : "()"
      const k = kind === "db" && path === "rpc" && /gate_key/.test(first) ? "auth" : kind
      const write = /(^|\.)(insert|upsert|update)$/.test(path) ? args[0] : path === "rpc" ? args[1] : undefined
      let payload: string | undefined
      if (write !== undefined) {
        try {
          payload = JSON.stringify(write).slice(0, 2000)
        } catch {
          payload = "<unserialisable>"
        }
      }
      calls.push({ kind: k, what: `${path}${first}`, ...(payload === undefined ? {} : { payload }) })
      // A Vault gate-key read answers with a KNOWN key, so a probe can present it.
      if (k === "auth" && kind === "db") return { then: (resolve: (v: unknown) => unknown) => resolve({ data: VAULT_GATE_KEY, error: null }) }
      return chain(kind, `${path}${first}`)
    },
  })
}

// deno-lint-ignore no-explicit-any
export function createClient(url: string, key: string, opts?: unknown): any
// deno-lint-ignore no-explicit-any
export function createClient(): any {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      return chain(prop === "auth" ? "auth" : "db", String(prop))
    },
  })
}
