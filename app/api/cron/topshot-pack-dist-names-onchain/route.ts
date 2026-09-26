import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { fillMissingDistImages, type DistImagePassResult } from "@/lib/packs/topshot-dist-images"

// Top Shot pack distributions that have NO NAME get one from the chain.
//
// WHY THIS EXISTS (2026-09-25). `pack_distributions.title` for Top Shot came
// from Dapper's `searchPackNft` GraphQL, and that host has answered 530 since
// ~08-28, so every distribution created since (48 rows, dist 8734–8869 on the
// day this shipped) sat with `title NULL`, `metadata.tier NULL` — and the pack
// page, the pack-history table and the alert copy fell back to "NBA Top Shot
// Pack #8825". Known-issues #137(d) filed it as "nothing to do on our side,
// watch the source". Wrong: the name is ON CHAIN. Every Dapper pack
// distribution is registered with the shared Pack Distribution Service
// contract (`PDS` at 0xb6f2481eba4df97b — the same one the All Day / Golazos
// seeder walks), and `PDS.getDistInfo(distId)` returns the title, the tier and
// the slot count. Verified live before this shipped: 8825 → "Portland Fire
// Seasonal Leaderboard Snapshot 2" (rare, 1 slot); 8869 → "WNBA Rookie
// Revelation Case Topper"; 8734 → "WNBA Origins Set Completion Reward Pack".
//
// HOW. Read the unnamed Top Shot rows (bounded), one PDS script per dist
// (the population is dozens, not thousands — a script per row is ~0.4 s and
// needs no batching), and write `title` plus the metadata keys the row lacks
// (`tier`, `number_of_pack_slots`, `description`) — fill-only, never
// overwriting a value another writer set. Counts and images are NOT this
// route's business: `total_minted` etc. stay with their own writer.
//
// HONESTY. A Flow REST failure is a pipeline failure (ok=false), never a
// quietly smaller sweep; a dist the chain does not know is counted as
// `not_on_chain` and left unnamed (a NULL, not a fabricated title); a budget
// stop is `complete:false` on an ok run; a write error fails the run and the
// row count means rows the UPDATE actually returned.
//
// DISCOVERY (2026-09-25). Nothing else creates a row for a PDS-era dist
// (Studio Platform, the old seeder's source, does not carry them), and the
// passes below only fill rows that EXIST — so a brand-new dist a collector
// opened stayed "Pack" forever (64 had piled up). The run starts by calling
// discover_missing_topshot_pack_distributions(7): a placeholder row (title
// NULL) for every dist a rip or purchase of the last 7 days references and the
// table lacks. The naming and image passes then fill it in the same run.
//
// IMAGES (2026-09-25). A second pass fills `image_url` for dists that have
// none, from the pack NFT's own media redirect (lib/packs/topshot-dist-images.ts)
// — PDS carries no image for most new dists. Same honesty rules; its counts
// ride in `extra.images`, and its failure fails the run.
//
// COUNTER CHECKS (2026-09-25). Last, refresh_pack_supply_counter_checks()
// re-checks every Top Shot supply counter pack_table_rows publishes against the
// opens we observed on-chain (a floor) — the view hides a contradicted counter.
// Its verdict counts ride in `extra.counter_checks`; its failure fails the run.
//
// Auth: `Bearer $CRON_SECRET` (Vercel cron) or `Bearer $INGEST_SECRET_TOKEN`
// (manual/backstop). 202 + after(): heartbeat FIRST, terminal row LAST.

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "topshot-pack-dist-names-onchain"
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const FLOW_REST = process.env.FLOW_REST_URL ?? "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
const MAX_ROWS_PER_RUN = 200
const TIME_BUDGET_MS = (maxDuration - 45) * 1000
const DISCOVERY_DAYS = 7

// Verified on mainnet 2026-09-25 through Flow REST against 0xb6f2481eba4df97b
// (dists 8825, 8869, 8734, 5266). Re-verify with the cadence MCP before any
// change — the repo's Cadence lint gate does not see scripts embedded in routes.
export const DIST_INFO_SCRIPT = `
import PDS from 0xb6f2481eba4df97b
access(all) fun main(distId: UInt64): {String: String}? {
  if let info = PDS.getDistInfo(distId: distId) {
    var result: {String: String} = {"title": info.title, "state": info.state.rawValue.toString()}
    for key in info.metadata.keys { result["meta_".concat(key)] = info.metadata[key]! }
    return result
  }
  return nil
}
`

export interface DistInfo {
  title: string
  tier: string | null
  numberOfPackSlots: number | null
  description: string | null
}

type DistRow = { id: string; dist_id: string; metadata: Record<string, unknown> | null }

/**
 * Decode the script's JSON-Cadence `{String: String}?` into a DistInfo, or
 * null when the chain has no such distribution. Throws on any shape surprise
 * (a surprise is a failure, not an absence).
 */
export function decodeDistInfo(decoded: unknown): DistInfo | null {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Optional") throw new Error("script result is not a JSON-Cadence Optional")
  if (node.value == null) return null
  const dict = node.value as { type?: string; value?: unknown }
  if (dict.type !== "Dictionary" || !Array.isArray(dict.value)) throw new Error("script result is not a Dictionary")
  const map: Record<string, string> = {}
  for (const entry of dict.value as Array<{ key?: { value?: unknown }; value?: { value?: unknown } }>) {
    const k = entry?.key?.value
    const v = entry?.value?.value
    if (typeof k === "string" && typeof v === "string") map[k] = v
  }
  const title = (map.title ?? "").trim()
  if (!title) return null
  const slotsRaw = map.meta_numberOfPackSlots
  const slots = slotsRaw != null && slotsRaw !== "" && Number.isFinite(Number(slotsRaw)) ? Number(slotsRaw) : null
  const tier = map.meta_tier ? map.meta_tier.trim().toLowerCase() : null
  // The chain carries the marketing copy as HTML (<p>, <span style=…>); the
  // column is read as TEXT by pack_table_rows, so store text.
  const description = map.meta_description
    ? map.meta_description.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    : null
  return { title, tier: tier || null, numberOfPackSlots: slots, description: description || null }
}

async function readDistInfo(distId: string): Promise<DistInfo | null> {
  const body = {
    script: Buffer.from(DIST_INFO_SCRIPT, "utf8").toString("base64"),
    arguments: [Buffer.from(JSON.stringify({ type: "UInt64", value: String(distId) }), "utf8").toString("base64")],
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
  return decodeDistInfo(decoded)
}

/** Merge the chain's facts into the row's metadata, filling only what is NULL/absent. */
export function mergeMetadata(existing: Record<string, unknown> | null, info: DistInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) }
  if (out.tier == null && info.tier) out.tier = info.tier
  if (out.number_of_pack_slots == null && info.numberOfPackSlots != null) out.number_of_pack_slots = info.numberOfPackSlots
  if (out.description == null && info.description) out.description = info.description
  return out
}

async function readUnnamed(): Promise<{ rows: DistRow[]; complete: boolean }> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pack_distributions")
    .select("id,dist_id,metadata")
    .eq("collection_id", COLLECTION_ID)
    .is("title", null)
    .order("dist_id", { ascending: true })
    .limit(MAX_ROWS_PER_RUN + 1)
  if (error) throw new Error(`pack_distributions read failed: ${error.message}`)
  const rows = (data ?? []) as DistRow[]
  return { rows: rows.slice(0, MAX_ROWS_PER_RUN), complete: rows.length <= MAX_ROWS_PER_RUN }
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
    let unnamed = 0
    let notOnChain = 0
    let named = 0
    let scriptCalls = 0
    let scriptErrors = 0
    let writeErrors = 0
    let images: DistImagePassResult | null = null
    let discovered: number | null = null
    let counterChecks: Record<string, unknown> | null = null

    // Discovery first, so the passes below see the new rows. A failure fails
    // the run but does not stop naming/pictures for the rows that do exist.
    try {
      const { data, error } = await (supabaseAdmin as any).rpc("discover_missing_topshot_pack_distributions", {
        p_days: DISCOVERY_DAYS,
      })
      if (error) throw new Error(error.message)
      // null is not 0 — an absent count must not become a measured zero.
      if (data == null) throw new Error("no count returned")
      discovered = typeof data === "number" ? data : Number(data)
      if (!Number.isFinite(discovered)) throw new Error(`unexpected result ${JSON.stringify(data)}`)
    } catch (e) {
      ok = false
      discovered = null
      errMsg = errMsg ?? `discover: ${e instanceof Error ? e.message : String(e)}`
    }

    try {
      const read = await readUnnamed()
      complete = read.complete
      unnamed = read.rows.length
      for (const row of read.rows) {
        if (Date.now() - startedMs > TIME_BUDGET_MS) {
          complete = false
          break
        }
        let info: DistInfo | null
        try {
          scriptCalls++
          info = await readDistInfo(row.dist_id)
        } catch (e) {
          scriptErrors++
          ok = false
          errMsg = errMsg ?? `flow rest: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
        if (!info) {
          notOnChain++
          continue
        }
        // ⚠ `.is("title", null)` keeps this fill-only under a concurrent namer;
        // the returned rows are the count that LANDED, never the count sent.
        const { data, error } = await (supabaseAdmin as any)
          .from("pack_distributions")
          .update({ title: info.title, metadata: mergeMetadata(row.metadata, info), updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .is("title", null)
          .select("id")
        if (error) {
          writeErrors++
          ok = false
          errMsg = errMsg ?? `write: ${error.message}`
          continue
        }
        named += Array.isArray(data) ? data.length : 0
      }
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    // Images after names, so a dist named this run is also pictured this run.
    try {
      images = await fillMissingDistImages({
        db: supabaseAdmin,
        collectionId: COLLECTION_ID,
        maxRows: MAX_ROWS_PER_RUN,
        deadlineMs: startedMs + TIME_BUDGET_MS,
      })
      if (!images.ok) {
        ok = false
        errMsg = errMsg ?? images.error
      }
      if (!images.complete) complete = false
    } catch (e) {
      ok = false
      errMsg = errMsg ?? `images: ${e instanceof Error ? e.message : String(e)}`
    }

    // Counter checks last, after discovery added any new dist.
    try {
      const { data, error } = await (supabaseAdmin as any).rpc("refresh_pack_supply_counter_checks")
      if (error) throw new Error(error.message)
      if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
        throw new Error(`unexpected result ${JSON.stringify(data)}`)
      }
      counterChecks = data as Record<string, unknown>
    } catch (e) {
      ok = false
      counterChecks = null
      errMsg = errMsg ?? `counter checks: ${e instanceof Error ? e.message : String(e)}`
    }

    await logTerminalRun({
      pipeline: PIPELINE_NAME,
      startedAt: startedMs,
      ok,
      error: errMsg,
      rowsFound: unnamed + (images?.imageless ?? 0),
      rowsWritten: (discovered ?? 0) + named + (images?.filled ?? 0),
      rowsSkipped: notOnChain,
      collectionSlug: "nba-top-shot",
      extra: {
        complete,
        discovered,
        unnamed,
        named,
        not_on_chain: notOnChain,
        script_calls: scriptCalls,
        script_errors: scriptErrors,
        write_errors: writeErrors,
        images,
        counter_checks: counterChecks,
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
