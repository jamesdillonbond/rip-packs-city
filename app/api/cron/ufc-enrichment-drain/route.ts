import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { UFC_COLLECTION_UUID } from "@/lib/chains/flow/wallet-backfill-helpers"

// UFC wmc enrichment drain (UFC-WMC-NULLKEY fix).
//
// Problem: UFC has NO DB nft->edition mapping. The only source of a UFC wmc
// row's `edition_key` / serial / tier / set is the on-chain MetadataViews read.
// That read was driven by `enrich-ufc-wallet` (via triggerUfcEnrichmentChain)
// chained inside `wallet-backfill-ufc`'s after() body — and it has TWO defects
// that left ~84% of UFC rows NULL-keyed (3,837/4,584 on 2026-06-12):
//   (a) it ran after an 83-93s Cadence ID-walk in the SAME lambda, so the
//       combined work exceeded budget / got reclaimed post-response and
//       enrichment died mid-chain with no trace; and
//   (b) the chain ALWAYS restarts the FULL-wallet walk at offset 0. For a big
//       wallet (e.g. 0x60daa8…: 1,571 moments = 16 pages) it can't finish in
//       one 300s lambda, so it perpetually re-enriches the early pages and
//       NEVER reaches the later null rows. A maxDuration bump (b28a22f) could
//       not fix either.
//
// This route fixes both by reading ONLY the NULL-edition_key moment_ids
// directly (no full-wallet re-walk, no nested chain), in its own dedicated
// lambda, and logging its OWN pipeline_runs row so a future silent failure is
// never invisible again. The GET_META Cadence path was verified live against a
// real null-key UFC NFT on 2026-06-13 (returns editionName/serial/max cleanly),
// so the enricher logic was never broken — only the delivery harness was.
//
// edition_key/serial/tier come from on-chain; player_name/set_name/image_url
// are joined from the editions map (external_id == makeEditionKey(...)).
// fmv_usd is intentionally left to the wmc-fmv-populate cron (its owner) — it
// keys on edition_key, so the next FMV tick fills it once the key lands.
//
// Bearer auth on INGEST_SECRET_TOKEN. Operator schedules at cron-job.org off
// the :00 rush (e.g. */30 at :07/:37), www host, expects 202.
// Done-when: UFC null_key trending to <100; fully-null wallets -> 0;
// `ufc-enrichment-drain` visible in pipeline_runs with ok=true.
// Revert: delete this route + the cron-job.org entry. No DB schema changes.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "ufc-enrichment-drain"
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

// Per-tick null-row budget. UFC is tiny (~4.6k rows total); 250 nulls/tick
// drains the whole null population in a handful of ticks while staying well
// inside the 300s lambda (250/5 groups * ~2s ≈ 100s + upserts).
const NULL_BUDGET = 250
const CONC = 5
const GROUP_SLEEP_MS = 200
const PER_CALL_TIMEOUT_MS = 15_000
const SOFT_DEADLINE_MS = 255_000

// GET_META — per-moment on-chain read. Verified live 2026-06-13. Borrows the
// generic NonFungibleToken.CollectionPublic (UFC's documented working pattern;
// Traits FAILS for UFC), resolves Display + Editions.
const GET_META = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import UFC_NFT from 0x329feb3ab062d289

access(all) fun main(addr: Address, id: UInt64): {String: String} {
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)!
  let nft = ref.borrowNFT(id)!
  let result: {String: String} = {"nftID": id.toString()}

  if let display = nft.resolveView(Type<MetadataViews.Display>()) {
    let d = display as! MetadataViews.Display
    result["name"] = d.name
    result["thumbnail"] = d.thumbnail.uri()
  }
  if let editions = nft.resolveView(Type<MetadataViews.Editions>()) {
    let e = editions as! MetadataViews.Editions
    if e.infoList.length > 0 {
      result["editionName"] = e.infoList[0].name ?? ""
      result["serial"] = e.infoList[0].number.toString()
      result["max"] = e.infoList[0].max?.toString() ?? ""
    }
  }
  return result
}
`.trim()

// Mirror enrich-ufc-wallet's derivation exactly so keys/tiers stay consistent.
function inferTier(max: number | null): string {
  if (!max || max === 0) return "FANDOM"
  if (max <= 10) return "ULTIMATE"
  if (max <= 99) return "CHAMPION"
  if (max <= 999) return "CHALLENGER"
  if (max <= 25000) return "CONTENDER"
  return "FANDOM"
}
function makeEditionKey(name: string, max: number | null): string {
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + (max ?? 0)
}
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getMeta(wallet: string, momentId: string): Promise<Record<string, string>> {
  const body = {
    script: b64(GET_META),
    arguments: [
      b64(JSON.stringify({ type: "Address", value: wallet })),
      b64(JSON.stringify({ type: "UInt64", value: String(momentId) })),
    ],
  }
  const res = await fetch(FLOW_REST, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Flow ${res.status}: ${(await res.text()).slice(0, 160)}`)
  }
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  const out: Record<string, string> = {}
  for (const e of decoded?.value ?? []) out[e.key.value] = e.value.value
  return out
}

type EditionEnrichment = { player_name: string | null; set_name: string | null; thumbnail_url: string | null }

interface NullRow {
  wallet_address: string
  moment_id: string
  image_url: string | null
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // CRON-30S: enrichment work far exceeds cron-job.org's 30s client cap, so
  // auth stays sync, the drain moves into after(), and we return 202 now. The
  // end-of-run log_pipeline_run is the real signal; the fatal-catch surfaces a
  // crash before it. (precedent lock-check-batch 36eee2f)
  const startedAtIso = new Date().toISOString()
  after(async () => {
    try {
      await runDrain(startedAtIso)
    } catch (e) {
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAtIso,
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `drain crashed: ${e instanceof Error ? e.message : String(e)}`,
          p_collection_slug: "ufc_strike",
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: { fatal: true },
        })
      } catch {
        // best-effort
      }
    }
  })
  return NextResponse.json({ accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

async function runDrain(startedAtIso: string): Promise<void> {
  const started = Date.parse(startedAtIso)

  // 1. Pull a bounded batch of NULL-edition_key UFC rows (the rows to fix),
  //    carrying their existing image_url so the "existing wins" rule holds.
  const { data: nullRowsRaw, error: scanErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("wallet_address, moment_id, image_url")
    .eq("collection_id", UFC_COLLECTION_UUID)
    .is("edition_key", null)
    .order("wallet_address", { ascending: true })
    .limit(NULL_BUDGET)

  if (scanErr) {
    await logRun(startedAtIso, started, {
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: false,
      error: `candidate scan: ${scanErr.message}`, extra: { stage: "candidate_scan" },
    })
    return
  }

  const nullRows = (nullRowsRaw ?? []) as NullRow[]
  if (nullRows.length === 0) {
    await logRun(startedAtIso, started, {
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: true,
      error: null, extra: { note: "no null-edition_key UFC rows" },
    })
    return
  }

  // 2. Load the (small) UFC editions map for player_name/set_name/image join.
  const editionMap = new Map<string, EditionEnrichment>()
  const { data: edRows, error: edErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("external_id, player_name, set_name, thumbnail_url")
    .eq("collection_id", UFC_COLLECTION_UUID)
  if (edErr) {
    await logRun(startedAtIso, started, {
      rowsFound: nullRows.length, rowsWritten: 0, rowsSkipped: nullRows.length, ok: false,
      error: `editions load: ${edErr.message}`, extra: { stage: "editions_load" },
    })
    return
  }
  for (const r of (edRows ?? []) as Array<Record<string, unknown>>) {
    const ext = r.external_id as string | null
    if (!ext) continue
    editionMap.set(ext, {
      player_name: (r.player_name as string | null) ?? null,
      set_name: (r.set_name as string | null) ?? null,
      thumbnail_url: (r.thumbnail_url as string | null) ?? null,
    })
  }

  // 3. Read each null moment on-chain (concurrency CONC), derive its fields.
  const updates: Array<Record<string, unknown>> = []
  let enriched = 0
  let cadenceErrors = 0
  let noEditionName = 0
  let deadlineHit = false
  const sampleErrors: string[] = []

  for (let i = 0; i < nullRows.length; i += CONC) {
    if (Date.now() - started > SOFT_DEADLINE_MS) {
      deadlineHit = true
      break
    }
    const group = nullRows.slice(i, i + CONC)
    const results = await Promise.allSettled(
      group.map(async (row) => ({ row, fields: await getMeta(row.wallet_address, row.moment_id) }))
    )
    for (const res of results) {
      if (res.status !== "fulfilled") {
        cadenceErrors++
        if (sampleErrors.length < 5) sampleErrors.push(res.reason?.message?.slice(0, 120) ?? "unknown")
        continue
      }
      const { row, fields } = res.value
      const edName = fields.editionName || fields.name || ""
      if (!edName) {
        noEditionName++
        continue
      }
      const serial = parseInt(fields.serial || "0") || null
      const max = parseInt(fields.max || "0") || null
      const walletFighter = edName.includes("|") ? edName.split("|")[0].trim() : edName
      const editionKey = makeEditionKey(edName, max)
      const ed = editionMap.get(editionKey)
      // editions wins for player_name unless it looks like a catchphrase
      // (length < 3 or contains "!"); then titleCase the on-chain value.
      const editionsPlayerOk = !!ed?.player_name && ed.player_name.length >= 3 && !ed.player_name.includes("!")
      const player_name = editionsPlayerOk ? ed!.player_name! : titleCase(walletFighter)
      const set_name = ed?.set_name ?? null
      const image_url = row.image_url ?? ed?.thumbnail_url ?? null
      updates.push({
        wallet_address: row.wallet_address,
        collection_id: UFC_COLLECTION_UUID,
        moment_id: row.moment_id,
        edition_key: editionKey,
        serial_number: serial,
        player_name,
        set_name,
        image_url,
        tier: inferTier(max),
        last_seen_at: new Date().toISOString(),
      })
      enriched++
    }
    if (i + CONC < nullRows.length) await sleep(GROUP_SLEEP_MS)
  }

  // 4. Upsert (3-col conflict target — the 2-col target silently no-ops; see
  //    [[wmc-onconflict-2col-broken]]).
  let upserted = 0
  let writeError: string | null = null
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50)
    const { error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
    if (error) {
      writeError = error.message
      break
    }
    upserted += chunk.length
  }

  await logRun(startedAtIso, started, {
    rowsFound: nullRows.length,
    rowsWritten: upserted,
    rowsSkipped: nullRows.length - upserted,
    ok: !writeError,
    error: writeError ? `upsert: ${writeError}` : null,
    extra: {
      enriched,
      upserted,
      cadence_errors: cadenceErrors,
      no_edition_name: noEditionName,
      deadline_hit: deadlineHit,
      distinct_wallets: new Set(nullRows.map((r) => r.wallet_address)).size,
      sample_errors: sampleErrors,
    },
  })

  console.log(
    `[ufc-enrichment-drain] done found=${nullRows.length} enriched=${enriched} upserted=${upserted} cadenceErr=${cadenceErrors} noName=${noEditionName} ms=${Date.now() - started}`
  )
}

async function logRun(
  startedAtIso: string,
  started: number,
  args: {
    rowsFound: number
    rowsWritten: number
    rowsSkipped: number
    ok: boolean
    error: string | null
    extra: Record<string, unknown>
  }
): Promise<void> {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "ufc_strike",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { duration_ms: Date.now() - started, ...args.extra },
    })
  } catch {
    // best-effort — never let logging failure crash the drain
  }
}
