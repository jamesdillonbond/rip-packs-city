import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"

// Top Shot BASE-edition circulation, read from the chain.
//
// WHY THIS EXISTS (2026-09-04). `topshot-catalog-backfill` refreshed
// `editions.circulation_count` from Top Shot GraphQL, and that host
// (public-api.nbatopshot.com) is decommissioned — every tick since ~08-28 is a
// Cloudflare 530. The count is on chain: `TopShot.getNumMomentsInEdition`.
// Measured on a hashed sample before this shipped: every BASE row
// (external_id `<set>:<play>`) agreed with the chain exactly after the series-8
// normaliser; every mismatch was a PARALLEL row (`<set>:<play>::<sub>`), whose
// per-parallel count is NOT readable from the public contract and is owned by
// `backfill-topshot-subedition-circulation`. So this route touches base rows
// only, and the RPC it calls enforces that with its own predicate.
//
// HOW. One Cadence script takes arrays of setIDs/playIDs and returns
// [numMinted, retiredFlag] per pair — 250 pairs per Flow REST call, ~40 calls
// for the whole base population, well inside the budget. The route does NOT
// compare values: `apply_topshot_onchain_circulation(p_rows)` compares each
// on-chain value against the stored one through the same normaliser the
// write trigger uses, so only rows the chain actually moved are written (a raw
// compare would rewrite every series-8 Base Set row daily to the same value).
//
// HONESTY. A Flow REST failure or an RPC error is a pipeline failure
// (ok=false), never a quietly smaller sweep. A pair the chain does not know
// (numMinted nil → sentinel) is counted as `not_on_chain` and not written. A
// budget stop is recorded as `complete:false` on an ok run. The paged read
// throws on error rather than returning a partial list.
//
// Auth: `Bearer $CRON_SECRET` (Vercel cron) or `Bearer $INGEST_SECRET_TOKEN`
// (manual/backstop) — the dual-secret pattern; an unset secret never lets a bare
// "Bearer " through. 202 + after(): heartbeat FIRST, terminal row LAST.

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "topshot-circulation-onchain"
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const FLOW_REST = process.env.FLOW_REST_URL ?? "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
const PAIRS_PER_SCRIPT = 250
const READ_PAGE = 1000
const TIME_BUDGET_MS = (maxDuration - 45) * 1000

/** `getNumMomentsInEdition` returned nil — the pair is not an edition on chain. */
export const NOT_ON_CHAIN = 4294967295

// Verified on mainnet 2026-09-04 against 0x0b2a3299cc857e29 (three pairs incl. a
// non-existent one). Re-verify with the cadence MCP before any change — the
// repo's Cadence lint gate does not see scripts embedded in routes.
export const BATCH_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(setIDs: [UInt32], playIDs: [UInt32]): [UInt32] {
  pre { setIDs.length == playIDs.length: "length mismatch" }
  let out: [UInt32] = []
  var i = 0
  while i < setIDs.length {
    let n = TopShot.getNumMomentsInEdition(setID: setIDs[i], playID: playIDs[i])
    let r = TopShot.isEditionRetired(setID: setIDs[i], playID: playIDs[i])
    out.append(n ?? 4294967295)
    out.append(r == nil ? 2 : (r! ? 1 : 0))
    i = i + 1
  }
  return out
}
`

type EditionRow = { id: string; set_id_onchain: number; play_id_onchain: number; external_id: string }

const BASE_KEY = /^[0-9]+:[0-9]+$/

/** Decode the script's JSON-Cadence `[UInt32]` into numbers. Throws on any shape surprise. */
export function decodeCountArray(decoded: unknown, expectedPairs: number): number[] {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) {
    throw new Error("script result is not a JSON-Cadence Array")
  }
  const nums = (node.value as Array<{ type?: string; value?: unknown }>).map((v) => {
    const n = Number(v?.value)
    if (!Number.isFinite(n)) throw new Error("non-numeric element in script result")
    return n
  })
  if (nums.length !== expectedPairs * 2) {
    throw new Error(`script returned ${nums.length} values for ${expectedPairs} pairs`)
  }
  return nums
}

async function runBatch(pairs: EditionRow[]): Promise<number[]> {
  const args = [
    { type: "Array", value: pairs.map((p) => ({ type: "UInt32", value: String(p.set_id_onchain) })) },
    { type: "Array", value: pairs.map((p) => ({ type: "UInt32", value: String(p.play_id_onchain) })) },
  ]
  const body = {
    script: Buffer.from(BATCH_SCRIPT, "utf8").toString("base64"),
    arguments: args.map((a) => Buffer.from(JSON.stringify(a), "utf8").toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Flow REST HTTP ${res.status}`)
  // ⚠ The signal stays live for the body read — keep it inside the caller's try.
  const json = (await res.json()) as { value?: string } | string
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) throw new Error("Flow REST returned an empty script result")
  const decoded = JSON.parse(Buffer.from(raw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8"))
  return decodeCountArray(decoded, pairs.length)
}

// ⚠ Paged with a deterministic order on the PK and a throw on error — a
// `break` here would hand the sweep a partial population it could not tell
// from a complete one.
async function readBaseEditions(): Promise<EditionRow[]> {
  const out: EditionRow[] = []
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("id,set_id_onchain,play_id_onchain,external_id")
      .eq("collection_id", COLLECTION_ID)
      .not("set_id_onchain", "is", null)
      .not("play_id_onchain", "is", null)
      .not("external_id", "like", "%::%")
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE - 1)
    if (error) throw new Error(`editions read failed at offset ${from}: ${error.message}`)
    const rows = (data ?? []) as EditionRow[]
    for (const r of rows) if (BASE_KEY.test(r.external_id)) out.push(r)
    if (rows.length < READ_PAGE) return out
  }
}

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cron = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cron && auth === `Bearer ${cron}`) || (!!ingest && auth === `Bearer ${ingest}`)
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedMs = Date.now()

  after(async () => {
    // ⚠ INVOCATION HEARTBEAT — first, before any work. A maxDuration kill after
    // this leaves a marker with no terminal row, which is how a kill is read.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: startedMs })

    let ok = true
    let errMsg: string | null = null
    let complete = true
    let pairsRead = 0
    let notOnChain = 0
    let retired = 0
    let sentToRpc = 0
    let changed = 0
    let scriptCalls = 0
    let scriptErrors = 0
    let rpcErrors = 0

    try {
      const editions = await readBaseEditions()
      for (let i = 0; i < editions.length; i += PAIRS_PER_SCRIPT) {
        if (Date.now() - startedMs > TIME_BUDGET_MS) {
          complete = false
          break
        }
        const chunk = editions.slice(i, i + PAIRS_PER_SCRIPT)
        let counts: number[]
        try {
          scriptCalls++
          counts = await runBatch(chunk)
        } catch (e) {
          scriptErrors++
          ok = false
          errMsg = errMsg ?? `flow rest: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
        pairsRead += chunk.length
        const rows: Array<{ id: string; n: number }> = []
        for (let k = 0; k < chunk.length; k++) {
          const n = counts[k * 2]
          const r = counts[k * 2 + 1]
          if (n === NOT_ON_CHAIN) {
            notOnChain++
            continue
          }
          if (r === 1) retired++
          rows.push({ id: chunk[k].id, n })
        }
        if (rows.length === 0) continue
        sentToRpc += rows.length
        const { data, error } = await (supabaseAdmin as any).rpc("apply_topshot_onchain_circulation", { p_rows: rows })
        if (error) {
          rpcErrors++
          ok = false
          errMsg = errMsg ?? `apply rpc: ${error.message}`
          continue
        }
        changed += Number((data as { changed?: number } | null)?.changed ?? 0)
      }
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    await logTerminalRun({
      pipeline: PIPELINE_NAME,
      startedAt: startedMs,
      ok,
      error: errMsg,
      rowsFound: pairsRead,
      rowsWritten: changed,
      rowsSkipped: notOnChain,
      collectionSlug: "nba-top-shot",
      extra: {
        complete,
        pairs_read: pairsRead,
        not_on_chain: notOnChain,
        retired,
        sent_to_rpc: sentToRpc,
        changed,
        script_calls: scriptCalls,
        script_errors: scriptErrors,
        rpc_errors: rpcErrors,
        duration_ms: Date.now() - startedMs,
      },
    })
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
