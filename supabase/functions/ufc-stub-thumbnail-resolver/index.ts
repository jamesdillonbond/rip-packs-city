// supabase/functions/ufc-stub-thumbnail-resolver/index.ts
//
// UFC stub thumbnail auto-resolver. Modeled after topshot-stub-resolver.
// Pulls a batch of UFC editions whose thumbnail_url IS NULL, looks up one
// owner per edition via wallet_moments_cache, then borrows that owner's
// moment on-chain to fetch MetadataViews.Display.thumbnail.uri().
//
// Cadence pattern is the same one in enrich-ufc-wallet:
//   - acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)!
//   - ref.borrowNFT(id)!
//   - resolveView(Type<MetadataViews.Display>()) -> d.thumbnail.uri()
// Memory note line 17 (CLAUDE.md "Per-collection Cadence gotchas / UFC"):
// UFC_NFT.MomentNFTCollectionPublic does NOT exist; we use the generic
// NonFungibleToken.CollectionPublic + force-unwrap as the existing UFC scan
// code does.
//
// Why pivot on wmc to find an owner: UFC stubs (the recent
// stub_editions_from_wmc migration) have no specific moment_id of their own
// — they're synthesized from edition_keys observed in wmc. We pick ONE
// (wallet, moment_id) pair per stub edition and borrow that NFT to read
// Display.thumbnail.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — service-role client
//   INGEST_SECRET_TOKEN                     — Bearer auth on the function
//
// Deploy with `verify_jwt = false` so cron-job.org can hit it with a
// shared-secret Bearer header instead of a Supabase user JWT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=final"
const PER_REQUEST_TIMEOUT_MS = 8_000
const BATCH_LIMIT = 50
const MAX_BATCH_DURATION_MS = 110_000
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

// Returns a flat {String: String} with `thumbnail` (Display.thumbnail.uri()).
// Mirrors enrich-ufc-wallet.GET_META but trimmed to the thumbnail field
// because everything else (name/serial/max) is unused here.
const CADENCE_RESOLVE = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import UFC_NFT from 0x329feb3ab062d289

access(all) fun main(addr: Address, id: UInt64): {String: String} {
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)!
  let nft = ref.borrowNFT(id)!
  let result: {String: String} = {}

  if let display = nft.resolveView(Type<MetadataViews.Display>()) {
    let d = display as! MetadataViews.Display
    result["thumbnail"] = d.thumbnail.uri()
  }

  return result
}
`.trim()

interface StubTarget {
  edition_id: string
  external_id: string
  owner_wallet: string
  owner_moment_id: string
}

function b64Utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}
function argB64(arg: { type: string; value: string }): string {
  return btoa(JSON.stringify(arg))
}

// Cadence's Flow REST encoding for `{String: String}` returns a `value` array
// of `{key: {value, type}, value: {value, type}}` entries. Flatten to JS dict.
function flattenCadenceDict(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  // deno-lint-ignore no-explicit-any
  const v = (parsed as any)?.value
  if (!Array.isArray(v)) return out
  for (const entry of v) {
    const k = entry?.key?.value
    const val = entry?.value?.value
    if (typeof k === "string" && typeof val === "string") out[k] = val
  }
  return out
}

async function resolveThumbnailViaCadence(addr: string, momentId: string): Promise<{ thumbnail: string } | { error: string }> {
  const body = {
    script: b64Utf8(CADENCE_RESOLVE),
    arguments: [
      argB64({ type: "Address", value: addr }),
      argB64({ type: "UInt64", value: String(momentId) }),
    ],
  }

  let res: Response
  try {
    res = await fetch(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { error: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!res.ok) {
    const txt = await res.text()
    return { error: `http_${res.status}: ${txt.slice(0, 200)}` }
  }

  let raw: string
  try {
    raw = await res.text()
  } catch (err) {
    return { error: `read_body_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  let parsed: unknown
  try {
    const decoded = atob(raw.replace(/^"|"$/g, "").trim())
    parsed = JSON.parse(decoded)
  } catch (err) {
    return { error: `decode_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const meta = flattenCadenceDict(parsed)
  const thumbnail = meta.thumbnail?.trim()
  if (!thumbnail) return { error: "no_thumbnail_in_display" }
  return { thumbnail }
}

async function loadTargets(): Promise<StubTarget[]> {
  // Pick ONE wmc owner per null-thumbnail UFC edition via DISTINCT ON.
  // Plain SQL via Postgres via rpc('execute_sql', ...) would be the
  // service-role-only path, but a simple two-step approach works too and
  // keeps the function dependency surface small.
  // deno-lint-ignore no-explicit-any
  const { data: eds, error: edErr } = await (supabase as any)
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", UFC_COLLECTION_ID)
    .or("thumbnail_url.is.null,thumbnail_url.eq.")
    .limit(BATCH_LIMIT)
  if (edErr) throw new Error(`editions load: ${edErr.message}`)
  const targets = (eds ?? []) as Array<{ id: string; external_id: string }>
  if (!targets.length) return []

  const out: StubTarget[] = []
  for (const ed of targets) {
    // deno-lint-ignore no-explicit-any
    const { data: wmcRows } = await (supabase as any)
      .from("wallet_moments_cache")
      .select("wallet_address, moment_id")
      .eq("collection_id", UFC_COLLECTION_ID)
      .eq("edition_key", ed.external_id)
      .limit(1)
    const owner = (wmcRows ?? [])[0] as { wallet_address: string; moment_id: string } | undefined
    if (!owner) continue
    out.push({
      edition_id: ed.id,
      external_id: ed.external_id,
      owner_wallet: owner.wallet_address,
      owner_moment_id: owner.moment_id,
    })
  }
  return out
}

async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  errorMsg: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "ufc-stub-thumbnail-resolver",
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.errorMsg,
      p_collection_slug: "ufc_strike",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

Deno.serve(async (req: Request) => {
  // Bearer or ?token= auth.
  const auth = req.headers.get("authorization") ?? ""
  const url = new URL(req.url)
  const qToken = url.searchParams.get("token") ?? ""
  const tokenOk = auth === `Bearer ${INGEST_SECRET_TOKEN}` || qToken === INGEST_SECRET_TOKEN
  if (!tokenOk) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()

  const counters = {
    targets_found: 0,
    targets_processed: 0,
    resolved: 0,
    skipped_no_owner: 0,
    skipped_cadence_err: 0,
    skipped_no_thumbnail: 0,
    skipped_upsert_err: 0,
    early_exit: false,
  }
  const errorSamples: string[] = []

  let targets: StubTarget[] = []
  try {
    targets = await loadTargets()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logPipelineRun({
      startedAtIso, ok: false, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      errorMsg: msg, extra: { ...counters, elapsed_ms: Date.now() - startedAt },
    })
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    })
  }
  counters.targets_found = targets.length

  if (targets.length === 0) {
    await logPipelineRun({
      startedAtIso, ok: true, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      errorMsg: null,
      extra: { ...counters, elapsed_ms: Date.now() - startedAt, message: "no stub targets" },
    })
    return new Response(JSON.stringify({ ok: true, ...counters }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  }

  for (const t of targets) {
    if (Date.now() - startedAt > MAX_BATCH_DURATION_MS) {
      counters.early_exit = true
      break
    }
    counters.targets_processed++

    const resolved = await resolveThumbnailViaCadence(t.owner_wallet, t.owner_moment_id)
    if ("error" in resolved) {
      if (resolved.error === "no_thumbnail_in_display") {
        counters.skipped_no_thumbnail++
      } else {
        counters.skipped_cadence_err++
      }
      if (errorSamples.length < 5) {
        errorSamples.push(`${t.external_id} @ ${t.owner_wallet}/${t.owner_moment_id}: ${resolved.error}`)
      }
      continue
    }

    // deno-lint-ignore no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from("editions")
      .update({ thumbnail_url: resolved.thumbnail, updated_at: new Date().toISOString() })
      .eq("id", t.edition_id)

    if (upErr) {
      counters.skipped_upsert_err++
      if (errorSamples.length < 5) errorSamples.push(`upsert ${t.external_id}: ${upErr.message}`)
      continue
    }
    counters.resolved++
  }

  await logPipelineRun({
    startedAtIso,
    ok: true,
    rowsFound: counters.targets_found,
    rowsWritten: counters.resolved,
    rowsSkipped:
      counters.skipped_no_owner +
      counters.skipped_cadence_err +
      counters.skipped_no_thumbnail +
      counters.skipped_upsert_err,
    errorMsg: null,
    extra: {
      ...counters,
      elapsed_ms: Date.now() - startedAt,
      function_version: 1,
      error_samples: errorSamples,
    },
  })

  return new Response(JSON.stringify({ ok: true, ...counters }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
