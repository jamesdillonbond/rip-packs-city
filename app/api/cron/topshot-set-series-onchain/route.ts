import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"

// Top Shot sets that have NO SERIES get one from the chain, and their editions
// follow.
//
// WHY THIS EXISTS (2026-09-25, known-issues #137 h). `catalog_topshot_from_atlas`
// creates a `sets` row with `series NULL` by construction — Atlas' badge_editions
// carries no series, and its `series_number` is read back FROM editions,
// circularly — so every set it discovers (13 on 09-24: "WNBA Bag Work", "WNBA
// Rookie Revelation", "Signature Style", …) and every edition under it (154)
// arrived without a series, and the site's series filters, share-card bars
// and the analytics split counted them as "No series". The chain has it:
// `TopShot.getSetSeries(setID)` (verified through Flow REST: 253/275/278/279 →
// 8, 140 → 6, 1 → 0, unknown → nil). The 09-25 migration filled the backlog;
// this keeps every future discovery filled within a day.
//
// HOW. Read the Top Shot sets with `series IS NULL AND set_id_onchain IS NOT
// NULL` (bounded), one Cadence script for up to SETS_PER_SCRIPT ids (a single
// contract read per id — nowhere near the 40-pair ceiling the circulation
// route measured for its two-call pairs), write `sets.series` fill-only, then
// fill `editions.series` from the set for editions still NULL. ⚠ The DB stores
// the on-chain UInt32 VERBATIM — 0 and 1 are both real values (Series 1 is 0
// on chain) — so nothing here remaps; the display map owns that.
//
// HONESTY. A Flow REST failure is a pipeline failure (ok=false); a set the
// chain does not know is `not_on_chain` and stays NULL; the written counts are
// the rows the UPDATEs returned; a write error fails the run.
//
// Auth: `Bearer $CRON_SECRET` (Vercel cron) or `Bearer $INGEST_SECRET_TOKEN`.
// 202 + after(): heartbeat FIRST, terminal row LAST.

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PIPELINE_NAME = "topshot-set-series-onchain"
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const FLOW_REST = process.env.FLOW_REST_URL ?? "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
const MAX_SETS_PER_RUN = 200
const SETS_PER_SCRIPT = 40

/** `getSetSeries` returned nil — the set id is not a set on chain. */
export const NOT_ON_CHAIN = 4294967295

// Verified on mainnet 2026-09-25 through Flow REST against 0x0b2a3299cc857e29.
// Re-verify with the cadence MCP before any change — the repo's Cadence lint
// gate does not see scripts embedded in routes.
export const SET_SERIES_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(setIDs: [UInt32]): [UInt32] {
  let out: [UInt32] = []
  for id in setIDs { out.append(TopShot.getSetSeries(setID: id) ?? 4294967295) }
  return out
}
`

type SetRow = { id: string; set_id_onchain: number }

/** Decode the script's JSON-Cadence `[UInt32]`. Throws on any shape surprise. */
export function decodeSeriesArray(decoded: unknown, expected: number): number[] {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) {
    throw new Error("script result is not a JSON-Cadence Array")
  }
  const nums = (node.value as Array<{ value?: unknown }>).map((v) => {
    const n = Number(v?.value)
    if (!Number.isFinite(n)) throw new Error("non-numeric element in script result")
    return n
  })
  if (nums.length !== expected) throw new Error(`script returned ${nums.length} values for ${expected} sets`)
  return nums
}

async function readSeries(sets: SetRow[]): Promise<number[]> {
  const arg = { type: "Array", value: sets.map((s) => ({ type: "UInt32", value: String(s.set_id_onchain) })) }
  const body = {
    script: Buffer.from(SET_SERIES_SCRIPT, "utf8").toString("base64"),
    arguments: [Buffer.from(JSON.stringify(arg), "utf8").toString("base64")],
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200).replace(/\s+/g, " ")).catch(() => "")
    throw new Error(`Flow REST HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`)
  }
  const json = (await res.json()) as { value?: string } | string
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) throw new Error("Flow REST returned an empty script result")
  const decoded = JSON.parse(Buffer.from(raw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8"))
  return decodeSeriesArray(decoded, sets.length)
}

async function readUnseriesedSets(): Promise<{ rows: SetRow[]; complete: boolean }> {
  const { data, error } = await (supabaseAdmin as any)
    .from("sets")
    .select("id,set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .is("series", null)
    .not("set_id_onchain", "is", null)
    .order("set_id_onchain", { ascending: true })
    .limit(MAX_SETS_PER_RUN + 1)
  if (error) throw new Error(`sets read failed: ${error.message}`)
  const rows = (data ?? []) as SetRow[]
  return { rows: rows.slice(0, MAX_SETS_PER_RUN), complete: rows.length <= MAX_SETS_PER_RUN }
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
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: startedMs })

    let ok = true
    let errMsg: string | null = null
    let complete = true
    let unseriesed = 0
    let notOnChain = 0
    let setsWritten = 0
    let editionsWritten = 0
    let scriptCalls = 0
    let scriptErrors = 0
    let writeErrors = 0

    try {
      const read = await readUnseriesedSets()
      complete = read.complete
      unseriesed = read.rows.length
      for (let i = 0; i < read.rows.length; i += SETS_PER_SCRIPT) {
        const chunk = read.rows.slice(i, i + SETS_PER_SCRIPT)
        let series: number[]
        try {
          scriptCalls++
          series = await readSeries(chunk)
        } catch (e) {
          scriptErrors++
          ok = false
          errMsg = errMsg ?? `flow rest: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
        for (let k = 0; k < chunk.length; k++) {
          const s = series[k]
          if (s === NOT_ON_CHAIN) {
            notOnChain++
            continue
          }
          // Fill-only under a concurrent writer; the returned rows are what LANDED.
          const { data, error } = await (supabaseAdmin as any)
            .from("sets")
            .update({ series: s })
            .eq("id", chunk[k].id)
            .is("series", null)
            .select("id")
          if (error) {
            writeErrors++
            ok = false
            errMsg = errMsg ?? `sets write: ${error.message}`
            continue
          }
          const landed = Array.isArray(data) ? data.length : 0
          setsWritten += landed
          if (landed === 0) continue
          const { data: eds, error: edErr } = await (supabaseAdmin as any)
            .from("editions")
            .update({ series: s })
            .eq("collection_id", COLLECTION_ID)
            .eq("set_id_onchain", chunk[k].set_id_onchain)
            .is("series", null)
            .select("id")
          if (edErr) {
            writeErrors++
            ok = false
            errMsg = errMsg ?? `editions write: ${edErr.message}`
            continue
          }
          editionsWritten += Array.isArray(eds) ? eds.length : 0
        }
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
      rowsFound: unseriesed,
      rowsWritten: setsWritten + editionsWritten,
      rowsSkipped: notOnChain,
      collectionSlug: "nba-top-shot",
      extra: {
        complete,
        unseriesed,
        sets_written: setsWritten,
        editions_written: editionsWritten,
        not_on_chain: notOnChain,
        script_calls: scriptCalls,
        script_errors: scriptErrors,
        write_errors: writeErrors,
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
