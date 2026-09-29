// lib/giveaways/flow-script.ts
//
// Run a read-only Cadence script on mainnet through Flow's REST API and decode
// the JSON-CDC result. Server-only. Throws on any failure — a giveaway never
// acts on a read that did not complete. A script panic comes back as a 400
// whose body carries the panic message; that message is OUR copy (the
// giveaway scripts' own panic strings), so the admin route may show it.

import { FLOW_SCRIPTS_URL } from "@/lib/giveaways/topshot-holdings"

export type CdcArg =
  | { type: "Address"; value: string }
  | { type: "UInt64"; value: string }
  | { type: "Array"; value: CdcArg[] }

export interface CdcValue {
  type: string
  value: unknown
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 20_000

export class FlowScriptError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "FlowScriptError"
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** The panic text inside a Flow REST error body, if there is one. */
export function panicMessage(body: string): string | null {
  const m = body.match(/panic: ([^\\"\n]+)/) ?? body.match(/assertion failed: ([^\\"\n]+)/)
  return m ? m[1].trim() : null
}

export async function runFlowScript(script: string, args: CdcArg[], fetchImpl: FetchLike = fetch): Promise<CdcValue> {
  const res = await fetchImpl(FLOW_SCRIPTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: b64(script), arguments: args.map((a) => b64(JSON.stringify(a))) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const panic = panicMessage(text)
    throw new FlowScriptError(panic ? `Cadence: ${panic}` : `Flow script HTTP ${res.status}`, res.status)
  }
  try {
    return JSON.parse(Buffer.from(text.trim().replace(/^"|"$/g, ""), "base64").toString("utf8")) as CdcValue
  } catch {
    throw new FlowScriptError("Flow script returned an undecodable body", 502)
  }
}

export const addr = (value: string): CdcArg => ({ type: "Address", value })
export const u64 = (value: string): CdcArg => ({ type: "UInt64", value })
export const arrayOf = (items: CdcArg[]): CdcArg => ({ type: "Array", value: items })
