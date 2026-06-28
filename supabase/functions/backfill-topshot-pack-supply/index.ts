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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const GATE = "rpc_pls_8x2f9k3m_supply"
const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? ""
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? ""
const GQL_ENDPOINT = TS_PROXY_URL || "https://public-api.nbatopshot.com/marketplace/graphql"
const USING_PROXY = Boolean(TS_PROXY_URL && TS_PROXY_SECRET)
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const GQL_HEADERS: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)", "Origin": "https://nbatopshot.com", "Referer": "https://nbatopshot.com/" }
if (USING_PROXY) GQL_HEADERS["X-Proxy-Secret"] = TS_PROXY_SECRET
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  const { data: targets, error } = await supabase.rpc("get_topshot_supply_backfill_targets", { p_limit: limit })
  if (error) return { error: "targets: " + error.message }
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
  return { processed: rows.length, ok, fail, applyErr, gqlErr }
}

async function backfillPool(limit: number, conc: number) {
  const { data: targets, error } = await supabase.rpc("get_topshot_pool_backfill_targets", { p_limit: limit, p_only_with_rips: false })
  if (error) { console.error("[pool] targets:", error.message); return }
  const rows = (targets ?? []) as Array<{ dist_id: string; uuid: string }>
  let ok = 0, fail = 0, poolRows = 0, lastErr: string | null = null
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
      if (!okPages || eds.length === 0) { fail++; return }
      const exts = [...new Set(eds.map(e => e.ext))]; const idByExt = new Map<string, string>()
      for (let j = 0; j < exts.length; j += 300) { const { data: edRows } = await supabase.from("editions").select("id, external_id").eq("collection_id", TS).in("external_id", exts.slice(j, j + 300)); for (const e of (edRows ?? []) as any[]) idByExt.set(e.external_id, e.id) }
      // pack_drop_pool PK is (collection_id, dist_id, edition_id, slot_name); every
      // existing TS row uses slot_name='default' -> match it so the upsert dedups
      // and never creates a parallel slot. Tier lives on the edition, not the pool.
      const payload = eds.filter(e => idByExt.has(e.ext)).map(e => ({ collection_id: TS, dist_id: row.dist_id, edition_id: idByExt.get(e.ext)!, edition_flow_id: e.ext, drop_weight: e.count, orig_drop_weight: e.count, slot_name: "default", pool_source: "gql_historical", last_refreshed_at: new Date().toISOString() }))
      if (payload.length) { const { error: ue } = await supabase.from("pack_drop_pool").upsert(payload, { onConflict: "collection_id,dist_id,edition_id,slot_name" }); if (ue) { lastErr = lastErr || ue.message; fail++; return } poolRows += payload.length }
      ok++
    }))
    await sleep(300)
  }
  console.log(`[pool] processed=${rows.length} ok=${ok} fail=${fail} poolRows=${poolRows} lastErr=${lastErr ?? ""}`)
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
  if (url.searchParams.get("key") !== GATE) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  if (!USING_PROXY) return new Response(JSON.stringify({ error: "proxy env missing" }), { status: 500, headers: { "content-type": "application/json" } })
  const mode = url.searchParams.get("mode") ?? "supply"
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 400)
  const conc = Math.min(Math.max(parseInt(url.searchParams.get("conc") ?? "3", 10) || 3, 1), 8)
  if (mode === "pool") {
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
