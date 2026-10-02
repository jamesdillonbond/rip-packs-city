// Loads an edge function's module with its server, its database client and the
// network replaced by recorders, then probes its handler. Used by
// auth_gate_test.ts; see that file's header for why.
import { background, type Call, calls, reset, served } from "./stubs/recorder.ts"

export const FN_ROOT = new URL("../", import.meta.url)

/** Every deployable function: a directory with an index.ts, `_`-prefixed dirs excluded. */
export function functionNames(): string[] {
  const out: string[] = []
  for (const e of Deno.readDirSync(FN_ROOT)) {
    if (!e.isDirectory || e.name.startsWith("_")) continue
    try {
      Deno.statSync(new URL(`${e.name}/index.ts`, FN_ROOT))
      out.push(e.name)
    } catch {
      // no index.ts: not a function
    }
  }
  return out.sort()
}

let installed = false

/** Replace Deno.serve, fetch and EdgeRuntime, and give every env var a value. */
export function install(files: URL[]) {
  if (installed) return
  installed = true
  // deno-lint-ignore no-explicit-any
  const D = Deno as any
  // deno-lint-ignore no-explicit-any
  D.serve = (a: any, b?: any) => {
    served.handler = typeof a === "function" ? a : (b ?? a?.handler ?? null)
    return { finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {}, addr: {} }
  }
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime = {
    waitUntil(p: Promise<unknown>) {
      background.push(Promise.resolve(p).catch(() => {}))
    },
  }
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ kind: "fetch", what: url.slice(0, 80) })
    return Promise.resolve(new Response("{}", { status: 503 }))
  }
  // Every secret a function reads gets a value, so a function that fails
  // closed on an UNSET key cannot pass for the wrong reason: the probes below
  // must be refused because the caller is wrong, not because the key is empty.
  for (const f of files) {
    const src = Deno.readTextFileSync(f)
    for (const m of src.matchAll(/Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g)) {
      Deno.env.set(m[1], `test-value-${m[1]}`)
    }
  }
  Deno.env.set("SUPABASE_URL", "http://stub.invalid")
}

export async function load(url: URL): Promise<(req: Request) => Promise<Response>> {
  served.handler = null
  reset()
  await import(url.href)
  // Read through a cast: TS narrowed the field to null at the assignment above
  // and cannot see that the import set it.
  const h = (served as { handler: ((req: Request) => Response | Promise<Response>) | null }).handler
  if (!h) throw new Error(`${url.pathname} registered no handler with Deno.serve or serve()`)
  return async (req: Request) => await h(req)
}

export type Probe = { label: string; status: number | "TIMEOUT"; work: Call[] }

/** Callers that hold no credential, or the wrong one. */
export function anonymousRequests(name: string): [string, Request][] {
  const base = `http://localhost/functions/v1/${name}`
  return [
    ["POST, no credential", new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })],
    ["GET, no credential", new Request(base)],
    [
      "POST, wrong key in every slot",
      new Request(`${base}?key=wrong`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong", apikey: "wrong", "x-gate-key": "wrong" },
        body: "{}",
      }),
    ],
  ]
}

export async function probe(handler: (req: Request) => Promise<Response>, label: string, req: Request): Promise<Probe> {
  reset()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"TIMEOUT">((res) => {
    timer = setTimeout(() => res("TIMEOUT"), 5_000)
  })
  try {
    const r = await Promise.race([handler(req), timeout])
    return { label, status: r === "TIMEOUT" ? r : r.status, work: calls.filter((c) => c.kind !== "auth") }
  } catch {
    // An uncaught throw is a 500 on the platform, which is not a refusal.
    return { label, status: 500, work: calls.filter((c) => c.kind !== "auth") }
  } finally {
    clearTimeout(timer)
  }
}

/** Refused (a 4xx) and did no work before refusing. */
export function refused(p: Probe): boolean {
  return typeof p.status === "number" && p.status >= 400 && p.status < 500 && p.work.length === 0
}

/**
 * The minimum input a function needs before it does any work. Without it the
 * admitted probe gets a 400 and exercises nothing. Wallet / ids are inert:
 * every read fails here regardless.
 */
const INPUTS: Record<string, { query?: string; body?: unknown; method?: "GET" | "POST" }> = {
  "enrich-ufc-wallet": { query: "wallet=0x0123456789abcdef" },
  "scan-pinnacle-wallet": { query: "wallet=0x0123456789abcdef" },
  "scan-ufc-wallet": { body: { wallet: "0x0123456789abcdef" } },
  "backfill-pack-opens-api": { query: "collection=topshot" },
  "ingest-topshot-atlas-pool": { method: "GET", query: "mode=targets" },
  "flowty-proxy": { body: { contractAddress: "0x0b2a3299cc857e29", contractName: "TopShot", payload: {} } },
}

export type AdmittedRun = {
  /** The env var whose test value got past the gate (`VAULT_GATE_KEY` for a Vault key). */
  via: string
  status: number | "TIMEOUT"
  body: string
  calls: Call[]
  /** How many promises the handler left running through EdgeRuntime.waitUntil. */
  background: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Get past the function's gate WITHOUT knowing its scheme: every env var it
 * reads holds `test-value-<NAME>` (see install), so present each value in every
 * slot a gate in this fleet reads (Bearer, ?key=, apikey, x-gate-key) until one
 * is not refused. Then let any background work finish, so the run's own
 * pipeline_runs write is in `calls`. Null when no value is admitted.
 */
export async function admit(name: string, handler: (req: Request) => Promise<Response>): Promise<AdmittedRun | null> {
  const src = Deno.readTextFileSync(new URL(`${name}/index.ts`, FN_ROOT))
  const envs = [...new Set([...src.matchAll(/Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g)].map((m) => m[1]))]
  const input = INPUTS[name] ?? {}
  for (const via of [...envs, "VAULT_GATE_KEY"]) {
    const v = `test-value-${via}`
    const method = input.method ?? "POST"
    const qs = new URLSearchParams(input.query ?? "")
    qs.set("key", v)
    const req = new Request(`http://localhost/functions/v1/${name}?${qs}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${v}`, apikey: v, "x-gate-key": v },
      body: method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
    })
    reset()
    let status: number | "TIMEOUT" = 500
    let body = ""
    try {
      const r = await Promise.race([handler(req), sleep(8_000).then(() => "TIMEOUT" as const)])
      if (r === "TIMEOUT") status = r
      else {
        status = r.status
        body = await r.text()
      }
    } catch (e) {
      body = `THREW ${String(e)}`
    }
    if (status === 401 || status === 403) continue
    await Promise.race([Promise.allSettled([...background]), sleep(6_000)])
    await sleep(200) // fire-and-forget work not handed to waitUntil
    return { via, status, body, calls: [...calls], background: background.length }
  }
  return null
}
