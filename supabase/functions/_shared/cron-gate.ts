// _shared/cron-gate.ts — the ONE gate for pg_cron-dispatched edge functions.
//
// ── What it replaces (2026-10-13, register D2b / R21) ───────────────────────
// Each gated function used to compare `?key=` against its own env secret
// (`<NAME>_GATE_KEY`, plus `_OLD` during a rotation). Rotating meant a human
// generating a value and pasting it into the Supabase dashboard while cron was
// re-pointed — the step through which nine keys leaked on 2026-08-18, and which
// no agent session can perform (the MCP cannot set secrets).
//
// Since 2026-09-22 pg_cron reads each function's key from Vault at dispatch time
// (`public.cron_gate_key('<fn>')`, secret `cron_gate_key__<fn>`). This helper
// makes the FUNCTION read the same Vault value. Cron and function therefore
// cannot disagree by construction, and a rotation is one in-database
// `vault.update_secret(...)` whose new value is generated in SQL and never
// selected by anyone. The env secrets become unused.
//
// ── Where the key may arrive ───────────────────────────────────────────────
// The `x-rpc-gate-key` header first, then `?key=`. The header exists so the key
// can leave the URL: Supabase edge logs record full request URLs, so a `?key=`
// is re-published into the log store on every tick. During the move both are
// accepted; once every dispatcher sends the header, `?key=` support can go.
//
// ── THREE outcomes, never two ──────────────────────────────────────────────
//   ok          — the presented key matches Vault
//   denied      — no key, or a key that does not match           → 403
//   unavailable — the Vault read FAILED; nothing was compared    → 503
// A failed read is not a wrong key. Answering 403 for it would make a database
// blip look exactly like a rotation mistake (a 403'd function writes no
// pipeline_runs row, so the 403 is the only signal anyone gets).

export type CronGateResult = "ok" | "denied" | "unavailable"

export const GATE_HEADER = "x-rpc-gate-key"

/** The key the caller presented: the header first, then `?key=`. Blank counts as absent. */
export function presentedGateKey(req: Request): string | null {
  const h = req.headers.get(GATE_HEADER)
  if (h && h.trim() !== "") return h.trim()
  const q = new URL(req.url).searchParams.get("key")
  return q && q.trim() !== "" ? q.trim() : null
}

/** Constant-time string comparison (no early exit on the first differing char). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/** Check the request against `cron_gate_key('<fnName>')`. Needs a service-role client. */
export async function checkCronGate(req: Request, sb: RpcClient, fnName: string): Promise<CronGateResult> {
  const presented = presentedGateKey(req)
  if (!presented) return "denied"
  let data: unknown
  let error: { message?: string } | null
  try {
    ;({ data, error } = await sb.rpc("cron_gate_key", { p_fn: fnName }))
  } catch (e) {
    console.log(`[cron-gate] ${fnName}: vault read threw: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    return "unavailable"
  }
  if (error || typeof data !== "string" || data === "") {
    console.log(`[cron-gate] ${fnName}: vault read failed: ${(error?.message ?? "empty key").slice(0, 160)}`)
    return "unavailable"
  }
  return timingSafeEqual(presented, data) ? "ok" : "denied"
}

/** The response for a non-ok gate, or null to proceed. */
export function cronGateResponse(result: CronGateResult): Response | null {
  if (result === "ok") return null
  if (result === "unavailable") {
    return new Response(JSON.stringify({ error: "gate_unavailable", retry: true }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "60" },
    })
  }
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  })
}

/** Convenience: check and return the Response to send, or null to proceed. */
export async function cronGate(req: Request, sb: RpcClient, fnName: string): Promise<Response | null> {
  return cronGateResponse(await checkCronGate(req, sb, fnName))
}
