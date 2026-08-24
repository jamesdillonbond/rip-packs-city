// backfill-topshot-pack-supply
// Backfills TRUE per-dist pack supply for ALL TS distributions (incl. sold-out)
// via Top Shot's getPackListing GQL through topshot-proxy, writing
// pack_distributions.total_minted/total_opened (total_sealed + depletion_pct are
// GENERATED). Optional `pool` mode writes pack_drop_pool rows (pool_source='gql_historical').
// Deployed live from Cowork 2026-06-28 (verify_jwt=false; gated by ?key=).
// pg_cron `rpc-backfill-pack-supply` (7 */3 * * *, conc 2) drains the supply tail.
//
// 2026-06-28 (CC): made mode=pool actually work + self-draining.
//  (1) EDITIONS_QUERY / EDITIONS_QUERY_LEGACY minification dropped the final
//      closing brace -> every call 422'd (GRAPHQL_PARSE_FAILED). Fixed.
//  (2) pack_drop_pool upsert used a 3-col onConflict; the PK is 4-col incl.
//      slot_name. Now writes slot_name='default' (table convention) + 4-col onConflict.
//  (3) pool mode paginates per dist, so a synchronous response 504'd at the
//      ~150s gateway cap. mode=pool now runs in the background (EdgeRuntime.
//      waitUntil) and returns 202 immediately; pg_cron drives it. Per-dist upsert
//      is all-or-nothing (accumulate pages, one upsert) so a killed worker leaves
//      no partial pool; targets exclude any-pooled dist -> idempotent forward drain.
//  Also: body capture in gql(), V3->legacy auto-fallback, no-write mode=debugpool.
import { createClient } from "@supabase/supabase-js"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set TOPSHOT_PACK_SUPPLY_GATE_KEY=<new-random>
const GATE = Deno.env.get("TOPSHOT_PACK_SUPPLY_GATE_KEY") ?? ""
// Transitional SECOND key, read from its own secret — never a literal (this repo is PUBLIC).
// During a key rotation, set TOPSHOT_PACK_SUPPLY_GATE_KEY_OLD to the OUTGOING key: both are then accepted, so the
// pg_cron ?key= values can be repointed one job at a time instead of atomically. Finish the
// rotation by DELETING the _OLD secret — no redeploy needed. Both unset ⇒ still fails CLOSED.
const GATE_OLD = Deno.env.get("TOPSHOT_PACK_SUPPLY_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
}
const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? ""
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? ""
const GQL_ENDPOINT = TS_PROXY_URL || "https://public-api.nbatopshot.com/marketplace/graphql"
const USING_PROXY = Boolean(TS_PROXY_URL && TS_PROXY_SECRET)
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const GQL_HEADERS: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)", "Origin": "https://nbatopshot.com", "Referer": "https://nbatopshot.com/" }
if (USING_PROXY) GQL_HEADERS["X-Proxy-Secret"] = TS_PROXY_SECRET
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// pipeline_runs telemetry. Until 2026-08-23 this function wrote NO pipeline_runs
// row at all, so its work-per-outcome was unreadable: pg_cron job_run_details
// records DISPATCH of the net.http_get, never the outcome, and a query across
// pipeline_runs_daily for every plausible name returned []. jobid 16
// (rpc-backfill-pack-pool, every 5 min) drives the SYNCHRONOUS path
// (sync=1&limit=3&conc=1), so a terminal row is a complete instrument for it.
// NOTE the residual: the background (waitUntil) path returns 202 before the work
// runs, and a killed worker there writes no row at all — for that path ONLY,
// absence means killed. Nothing schedules it today.
async function logPipelineRun(pipeline: string, args: {
  startedAt: string;
  rowsFound: number | null;
  rowsWritten: number | null;
  rowsSkipped: number | null;
  ok: boolean;
  error?: string | null;
  extra: Record<string, unknown>;
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: pipeline,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[pack-supply] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const DYNAMIC_QUERY = `query GetPackListing_DynamicData($input: GetPackListingInput!) { getPackListing(input: $input) { data { id forSale isSoldOut remaining dropType packListingContentRemaining { unopened totalPackCount remainingByTier { common rare legendary ultimate fandom autograph anthology } originalCountsByTier { common rare legendary ultimate fandom autograph anthology } } } } }`
const EDITIONS_QUERY = `query GetPackEditions($input: GetPackListingInput!, $after: ID) { getPackListing(input: $input) { data { packEditionsV3(after: $after) { pageInfo { endCursor hasNextPage } edges { node { count remaining edition { id tier set { id flowId } play { id flowID } } } } } } } }`
const EDITIONS_QUERY_LEGACY = `query GetPackEditions($input: GetPackListingInput!, $after: ID) { getPackListing(input: $input) { data { packEditionsV3(after: $after) { pageInfo { endCursor hasNextPage } edges { node { count remaining edition { id tier set { id } play { id } } } } } } } }`
let editionsExtFieldsOk = true

async function gql(query: string, variables: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    let res: Response
    try { res = await fetch(GQL_ENDPOINT, { method: "POST", headers: GQL_HEADERS, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs) }) }
    catch (err) { if (attempt < 6) { await sleep(800 * attempt); continue } return { ok: false, error: `fetch: ${err instanceof Error ? err.message : String(err)}` } }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(1200 * attempt); continue }
      return { ok: false, error: `HTTP ${res.status}`, body: body.slice(0, 400) }
    }
    let json: any = null; try { json = JSON.parse(await res.text()) } catch { json = null }
    if (!json) return { ok: false, error: "not-json" }
    if (json.errors?.length) return { ok: false, error: json.errors[0].message, body: JSON.stringify(json.errors).slice(0, 400) }
    return { ok: true, data: json.data }
  }
  return { ok: false, error: "retries_exhausted" }
}

async function backfillSupply(limit: number, conc: number) {
  const startedAt = new Date().toISOString()
  const { data: targets, error } = await supabase.rpc("get_topshot_supply_backfill_targets", { p_limit: limit })
  if (error) {
    // A failed targets read is a FAILURE, not an empty batch. rows_* stay NULL —
    // a 0 here would be indistinguishable from a genuinely empty queue.
    await logPipelineRun("topshot-pack-supply-backfill", { startedAt, rowsFound: null, rowsWritten: null, rowsSkipped: null, ok: false, error: "targets: " + error.message, extra: { mode: "supply", limit, conc, stage: "targets" } })
    return { error: "targets: " + error.message }
  }
  const rows = (targets ?? []) as Array<{ dist_id: string; uuid: string }>
  let ok = 0, fail = 0, applyErr: string | null = null, gqlErr: string | null = null
  for (let i = 0; i < rows.length; i += conc) {
    const chunk = rows.slice(i, i + conc)
    await Promise.all(chunk.map(async (row) => {
      const r = await gql(DYNAMIC_QUERY, { input: { packListingId: row.uuid } })
      if (!r.ok) { gqlErr = gqlErr || String(r.error); await supabase.rpc("apply_topshot_supply", { p_dist_id: row.dist_id, p_ok: false, p_err: String(r.error).slice(0, 120) }); fail++; return }
      const d = r.data?.getPackListing?.data
      const cr = d?.packListingContentRemaining
      const { error: aerr } = await supabase.rpc("apply_topshot_supply", { p_dist_id: row.dist_id, p_ok: true, p_minted: Number(cr?.totalPackCount ?? 0), p_unopened: Number(cr?.unopened ?? 0), p_for_sale: d?.forSale ?? null, p_is_sold_out: d?.isSoldOut ?? null, p_remaining: cr?.remainingByTier ?? null, p_original: cr?.originalCountsByTier ?? null })
      if (aerr) { applyErr = applyErr || aerr.message; fail++; return }
      ok++
    }))
    await sleep(300)
  }
  await logPipelineRun("topshot-pack-supply-backfill", { startedAt, rowsFound: rows.length, rowsWritten: ok, rowsSkipped: fail, ok: !applyErr && !gqlErr, error: applyErr ?? gqlErr, extra: { mode: "supply", limit, conc, processed: rows.length, ok_count: ok, fail_count: fail } })
  return { processed: rows.length, ok, fail, applyErr, gqlErr }
}

async function backfillPool(limit: number, conc: number) {
  const startedAt = new Date().toISOString()
  const { data: targets, error } = await supabase.rpc("get_topshot_pool_backfill_targets", { p_limit: limit, p_only_with_rips: false })
  if (error) {
    // Was a BARE `return` — undefined spread into the sync response, so a failed
    // targets read rendered as a 200 carrying no counts. Now it reports.
    console.error("[pool] targets:", error.message)
    await logPipelineRun("topshot-pack-pool-backfill", { startedAt, rowsFound: null, rowsWritten: null, rowsSkipped: null, ok: false, error: "targets: " + error.message, extra: { mode: "pool", limit, conc, stage: "targets" } })
    return { error: "targets: " + error.message }
  }
  const rows = (targets ?? []) as Array<{ dist_id: string; uuid: string }>
  let ok = 0, fail = 0, poolRows = 0, lastErr: string | null = null, emptyEds = 0
  for (let i = 0; i < rows.length; i += conc) {
    const chunk = rows.slice(i, i + conc)
    await Promise.all(chunk.map(async (row) => {
      const eds: Array<{ ext: string; count: number }> = []
      let cursor: string | null = null, okPages = true
      for (let page = 0; page < 40; page++) {
        const r: any = await gql(editionsExtFieldsOk ? EDITIONS_QUERY : EDITIONS_QUERY_LEGACY, { input: { packListingId: row.uuid }, after: cursor ?? undefined })
        if (!r.ok) {
          const blob = `${r.error} ${r.body ?? ""}`
          if (editionsExtFieldsOk && /cannot query field|unknown field|undefined field|validation/i.test(blob)) { editionsExtFieldsOk = false; continue }
          okPages = false; lastErr = lastErr || blob.slice(0, 200); break
        }
        const conn = r.data?.getPackListing?.data?.packEditionsV3
        for (const e of (conn?.edges ?? [])) { const setF = e?.node?.edition?.set?.flowId, playF = e?.node?.edition?.play?.flowID; if (setF != null && playF != null) eds.push({ ext: `${setF}:${playF}`, count: Number(e.node.count ?? 0) }) }
        if (!conn?.pageInfo?.hasNextPage) break
        cursor = conn.pageInfo.endCursor
        await sleep(150)
      }
      // eds.length === 0 with okPages means the GQL walk SUCCEEDED and returned no
      // editions. That path set no lastErr, so a tick converting nothing returned
      // {"done":true,...,"ok":0,"fail":3,"lastErr":null} — a clean success. Count it.
      if (!okPages || eds.length === 0) { if (okPages) emptyEds++; fail++; return }
      const exts = [...new Set(eds.map(e => e.ext))]; const idByExt = new Map<string, string>()
      for (let j = 0; j < exts.length; j += 300) { const { data: edRows } = await supabase.from("editions").select("id, external_id").eq("collection_id", TS).in("external_id", exts.slice(j, j + 300)); for (const e of (edRows ?? []) as any[]) idByExt.set(e.external_id, e.id) }
      // pack_drop_pool PK is (collection_id, dist_id, edition_id, slot_name); every
      // existing TS row uses slot_name='default' -> match it so the upsert dedups
      // and never creates a parallel slot. Tier lives on the edition, not the pool.
      // drop_weight is numeric(8,6) (max ~100) and is interpreted as a FRACTIONAL
      // share of the pool (the 'gql' path stores remaining/totalUnopened, and
      // get_pack_detail_bundle computes hit_probability = drop_weight/sum(drop_weight)).
      // Writing the raw mint count here overflows for any pack whose editions mint
      // >=100 (that's why the backfill silently stalled at 39/1385). Normalize the
      // count to a per-edition share (<=1); keep the raw count in orig_drop_weight
      // (bigger column) which is what compute_pack_ev_per_edition_weighted uses.
      // Aggregate counts per ext first: the same set:play can appear on multiple
      // pages (parallels / repeats), and a payload with two rows sharing the 4-col
      // PK makes the upsert throw "ON CONFLICT ... cannot affect row a second time".
      const countByExt = new Map<string, number>()
      for (const e of eds) countByExt.set(e.ext, (countByExt.get(e.ext) ?? 0) + (e.count || 0))
      const totalCount = [...countByExt.values()].reduce((s, c) => s + c, 0) || 1
      const payload = [...countByExt.entries()].filter(([ext]) => idByExt.has(ext)).map(([ext, count]) => ({ collection_id: TS, dist_id: row.dist_id, edition_id: idByExt.get(ext)!, edition_flow_id: ext, drop_weight: Number((count / totalCount).toFixed(6)), orig_drop_weight: count, slot_name: "default", pool_source: "gql_historical", last_refreshed_at: new Date().toISOString() }))
      if (payload.length) { const { error: ue } = await supabase.from("pack_drop_pool").upsert(payload, { onConflict: "collection_id,dist_id,edition_id,slot_name" }); if (ue) { lastErr = lastErr || ue.message; fail++; return } poolRows += payload.length }
      ok++
    }))
    await sleep(300)
  }
  console.log(`[pool] processed=${rows.length} ok=${ok} fail=${fail} emptyEds=${emptyEds} poolRows=${poolRows} lastErr=${lastErr ?? ""}`)
  // A tick that found targets and converted NONE of them is a failure, even when no
  // upstream error was raised — that is the shape a green-but-idle pipeline hides in.
  // Only a tick with nothing to do, or one that converted at least one dist, is ok.
  const convertedNothing = rows.length > 0 && ok === 0
  const poolError = lastErr ?? (convertedNothing
    ? `0/${rows.length} dists converted${emptyEds > 0 ? `; ${emptyEds} returned no editions` : ""}`
    : null)
  await logPipelineRun("topshot-pack-pool-backfill", { startedAt, rowsFound: rows.length, rowsWritten: poolRows, rowsSkipped: fail, ok: !lastErr && !convertedNothing, error: poolError, extra: { mode: "pool", limit, conc, processed: rows.length, dists_ok: ok, dists_fail: fail, empty_eds: emptyEds, pool_rows: poolRows } })
  return { processed: rows.length, ok, fail, emptyEds, poolRows, lastErr }
}

// DIAGNOSTIC (no writes): probe one pool target with both query shapes, returning
// the raw first-edge node + error body. Kept for future query-shape debugging.
async function debugPool() {
  const { data: targets, error } = await supabase.rpc("get_topshot_pool_backfill_targets", { p_limit: 1, p_only_with_rips: false })
  if (error) return { error: "targets: " + error.message }
  const row = ((targets ?? []) as Array<{ dist_id: string; uuid: string }>)[0]
  if (!row) return { error: "no targets" }
  const v3 = await gql(EDITIONS_QUERY, { input: { packListingId: row.uuid } })
  const legacy = await gql(EDITIONS_QUERY_LEGACY, { input: { packListingId: row.uuid } })
  const firstNode = (r: any) => r?.data?.getPackListing?.data?.packEditionsV3?.edges?.[0]?.node ?? null
  return {
    dist_id: row.dist_id, uuid: row.uuid,
    v3: { ok: v3.ok, error: v3.error ?? null, body: v3.body ?? null, firstNode: firstNode(v3) },
    legacy: { ok: legacy.ok, error: legacy.error ?? null, body: legacy.body ?? null, firstNode: firstNode(legacy) },
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (!gateKeyOk(url.searchParams.get("key"))) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  if (!USING_PROXY) return new Response(JSON.stringify({ error: "proxy env missing" }), { status: 500, headers: { "content-type": "application/json" } })
  const mode = url.searchParams.get("mode") ?? "supply"
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 400)
  const conc = Math.min(Math.max(parseInt(url.searchParams.get("conc") ?? "3", 10) || 3, 1), 8)
  const sync = url.searchParams.get("sync") === "1"
  if (mode === "pool") {
    // sync=1 -> run inline and return real counts (deterministic driver / small
    // batches sized to the ~150s gateway). This exists because the background
    // (waitUntil) path is silently terminated before completing the paginated
    // per-dist walk once the queue head is large sold-out packs (2026-07-06 CC:
    // pool backfill stalled at 39/1385 dists for 7 days despite the 10-min cron).
    if (sync) {
      const result = await backfillPool(limit, conc)
      // A failed targets read must not render as a completed batch.
      const failed = Boolean(result && (result as { error?: string }).error)
      return new Response(JSON.stringify({ done: !failed, mode, sync: true, ...result }), { status: failed ? 500 : 200, headers: { "content-type": "application/json" } })
    }
    // Heavy (paginated per dist) -> run in background, ack immediately so neither
    // the 150s gateway nor the cron's net.http_get times out.
    const work = backfillPool(limit, conc)
    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime
    if (er && typeof er.waitUntil === "function") er.waitUntil(work)
    else work.catch((e) => console.error("[pool] bg work failed:", e))
    return new Response(JSON.stringify({ accepted: true, mode, limit, conc }), { status: 202, headers: { "content-type": "application/json" } })
  }
  const result = mode === "debugpool" ? await debugPool() : await backfillSupply(limit, conc)
  return new Response(JSON.stringify({ done: true, mode, ...result }), { status: 200, headers: { "content-type": "application/json" } })
})
