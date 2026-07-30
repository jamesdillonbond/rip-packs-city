// backfill-pack-opens-api
// Complete historical pack-OPEN backfill for Top Shot + NFL All Day, sourced
// from the Dapper studio-platform GraphQL `searchPackNft` registry instead of a
// Flow-REST block scan.
//
// WHY THE API, NOT A BLOCK SCAN: the on-chain opens backfills
// (`ingest-allday-pack-opens`, the `pack-events-ingest` worker) can only reach
// the current-spork access-node retention floor — blocks below it are PRUNED
// from public Flow REST (404), so they physically cannot walk back to PackNFT
// genesis (AllDay 2022 / Top Shot 2023). `searchPackNft` is a full registry of
// every PackNFT ever, reachable from Supabase egress unauthenticated with an
// Origin header, and reaches genesis directly.
//
// EXACT pack_rips RECONSTRUCTION (validated 2026-07-11): for a `status:Opened`
// pack the node gives
//   id                                -> pack_nft_id
//   "0x"+owner_address                -> opener_address (owner is frozen at open)
//   count(split(nfts,","))            -> moments_pulled
//   dist_id                           -> dist_id (also fills TS rips' null dist_id!)
//   metadata_updated_at.transaction_hash/.block_height/.block_time
//                                     -> tx_hash / block_height / sealed_at
// metadata_updated_at (== updated_at for opened packs) is the reveal/open write;
// its transaction_hash was verified equal to the real on-chain open tx of 4
// block-scanned rips, so API rows dedup cleanly against on-chain-scanned rows.
//
// Modes (?mode=): probe (one page, NO writes) | backfill (default) | reset
// (clear cursor -> re-walk from genesis). ?collection=allday|topshot required.
// Idempotent: writes via upsert_pack_rips_from_api (ON CONFLICT pack_nft_id).
// Gated by ?key=; verify_jwt=false. Self-logs to pipeline_runs.
import { createClient } from "@supabase/supabase-js"

const GATE = "rpc_pls_8x2f9k3m_opensapi"
const EP = "https://api.production.studio-platform.dapperlabs.com/graphql"
const H = {
  "Content-Type": "application/json",
  "Origin": "https://nflallday.com",
  "Referer": "https://nflallday.com/",
  "User-Agent": "RipPacksCity/1.0",
}
const COLL: Record<string, { id: string; type_name: string }> = {
  allday:  { id: "dee28451-5d62-409e-a1ad-a83f763ac070", type_name: "A.e4cf4bdc1751c65d.PackNFT.NFT" },
  topshot: { id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", type_name: "A.0b2a3299cc857e29.PackNFT.NFT" },
}

const PAGE_SIZE = 1000          // API returns ~480KB / 1000 nodes in ~1.4s
const TIME_BUDGET_MS = 110_000  // stay under the edge-function wall clock
const MAX_PAGES = 80            // hard cap / invocation

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const NODE_FIELDS =
  "id status dist_id owner_address nfts metadata_updated_at{ block_time block_height transaction_hash }"

async function gql(typeName: string, first: number, after: string | null) {
  const query =
    "query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ edges{ cursor node{ " +
    NODE_FIELDS + " } } } }"
  const variables = {
    i: {
      first,
      ...(after ? { after } : {}),
      sortBy: { id: { priority: 0, direction: "ASC" } },
      filters: [{ type_name: { eq: typeName } }, { status: { eq: "Opened" } }],
    },
  }
  const r = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) })
  if (!r.ok) return { ok: false as const, status: r.status, body: (await r.text()).slice(0, 300) }
  const j = await r.json().catch(() => null)
  if (j?.errors?.length) return { ok: false as const, status: 200, body: JSON.stringify(j.errors).slice(0, 300) }
  return { ok: true as const, edges: (j?.data?.searchPackNft?.edges ?? []) as any[] }
}

type Rip = { collection_id: string; pack_nft_id: string; opener_address: string; moments_pulled: number; tx_hash: string; block_height: number | null; sealed_at: string; dist_id: string | null }

function toRip(collId: string, node: any): Rip | null {
  const mu = node?.metadata_updated_at
  if (!mu?.transaction_hash || !mu?.block_time) return null // no open tx/time — skip
  const owner = node?.owner_address
  if (!owner) return null
  const nfts: string = node?.nfts ?? ""
  return {
    collection_id: collId,
    pack_nft_id: String(node.id),
    opener_address: "0x" + String(owner).toLowerCase().replace(/^0x/, ""),
    moments_pulled: nfts ? nfts.split(",").length : 0,
    tx_hash: String(mu.transaction_hash),
    block_height: mu.block_height != null ? Number(mu.block_height) : null,
    sealed_at: String(mu.block_time),
    dist_id: node?.dist_id != null ? String(node.dist_id) : null,
  }
}

async function getState(collId: string) {
  const { data } = await sb.from("pack_opens_api_state").select("*").eq("collection_id", collId).maybeSingle()
  return data
}
async function setState(collId: string, patch: Record<string, unknown>) {
  await sb.from("pack_opens_api_state").update({ ...patch, updated_at: new Date().toISOString() }).eq("collection_id", collId)
}

async function logRun(pipeline: string, startMs: number, ok: boolean, found: number, written: number, cb: string | null, ca: string | null, extra: any, error: string | null) {
  await sb.from("pipeline_runs").insert({
    pipeline, started_at: new Date(startMs).toISOString(),
    rows_found: found, rows_written: written, cursor_before: cb, cursor_after: ca, ok, error, extra,
  })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (url.searchParams.get("key") !== GATE) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  const collKey = (url.searchParams.get("collection") ?? "").toLowerCase()
  const coll = COLL[collKey]
  if (!coll) return new Response(JSON.stringify({ error: "bad_collection", allowed: Object.keys(COLL) }), { status: 400, headers: { "content-type": "application/json" } })
  const mode = url.searchParams.get("mode") ?? "backfill"
  const pageSize = Math.min(Number(url.searchParams.get("size") ?? PAGE_SIZE) || PAGE_SIZE, 2000)
  const maxPages = Math.min(Number(url.searchParams.get("pages") ?? MAX_PAGES) || MAX_PAGES, 200)
  const pipeline = `pack-opens-api-backfill-${collKey}`
  const startMs = Date.now()

  const st = await getState(coll.id)
  if (!st) return new Response(JSON.stringify({ error: "no_state_row", collection: collKey }), { status: 500, headers: { "content-type": "application/json" } })

  try {
    if (mode === "reset") {
      await setState(coll.id, { after_cursor: null, done: false, last_status: "reset" })
      return new Response(JSON.stringify({ mode, collection: collKey, reset: true }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "probe") {
      const res = await gql(coll.type_name, Math.min(pageSize, 5), st.after_cursor)
      if (!res.ok) return new Response(JSON.stringify({ mode, ok: false, status: res.status, body: res.body }), { headers: { "content-type": "application/json" } })
      const sample = res.edges.slice(0, 3).map((e) => toRip(coll.id, e.node))
      return new Response(JSON.stringify({ mode, collection: collKey, after_cursor: st.after_cursor, edges: res.edges.length, sample }), { headers: { "content-type": "application/json" } })
    }

    // backfill
    if (st.done) {
      await logRun(pipeline, startMs, true, 0, 0, st.after_cursor, st.after_cursor, { done: true }, null)
      return new Response(JSON.stringify({ mode, collection: collKey, done: true, rips_written: st.rips_written }), { headers: { "content-type": "application/json" } })
    }

    // Concurrency guard: two overlapping invocations walk the SAME after_cursor and
    // upsert the SAME pack_nft_id rows, contending on pack_rips locks (the source of
    // the "canceling statement due to lock timeout" failures). Claim a per-collection
    // lock so a second concurrent run cleanly no-ops instead of double-walking. Stale
    // window (300s) auto-clears a crashed holder well after the 110s time budget.
    // FAIL-OPEN: if the claim RPC errors, proceed anyway — the RPC-level lock_timeout
    // still bounds contention.
    const lockKey = pipeline // "pack-opens-api-backfill-<coll>"
    const claim = await sb.rpc("claim_pipeline_lock", { p_key: lockKey, p_stale_seconds: 300 })
    if (!claim.error && claim.data === false) {
      await logRun(pipeline, startMs, true, 0, 0, st.after_cursor, st.after_cursor, { skipped: "lock_held" }, null)
      return new Response(JSON.stringify({ mode, collection: collKey, skipped: "lock_held" }), { headers: { "content-type": "application/json" } })
    }

    let cursor: string | null = st.after_cursor
    const cursorBefore = cursor
    let pages = 0, seen = 0, written = 0, done = false, lastErr: string | null = null

    try {
      while (pages < maxPages && Date.now() - startMs < TIME_BUDGET_MS) {
        const res = await gql(coll.type_name, pageSize, cursor)
        if (!res.ok) { lastErr = `gql ${res.status}: ${res.body}`; break }
        const edges = res.edges
        pages++
        if (edges.length === 0) { done = true; break }

        const rips: Rip[] = []
        for (const e of edges) { const r = toRip(coll.id, e.node); if (r) rips.push(r) }
        if (rips.length) {
          const { data: ins, error } = await sb.rpc("upsert_pack_rips_from_api", { p_rows: rips })
          if (error) { lastErr = `rpc: ${error.message}`; break }
          written += Number(ins ?? 0)
        }
        seen += edges.length
        cursor = edges[edges.length - 1].cursor
        // persist cursor after every page so a crash never re-walks from scratch
        await setState(coll.id, { after_cursor: cursor, packs_seen: Number(st.packs_seen) + seen, rips_written: Number(st.rips_written) + written, last_status: `page ${pages}` })
        if (edges.length < pageSize) { done = true; break }
        await sleep(40)
      }
    } finally {
      // release the per-collection lock so the next scheduled tick can proceed.
      // (supabase-js rpc() returns a thenable, not a full Promise, so `.catch()`
      // isn't available until awaited — wrap in try/catch instead.)
      try { await sb.rpc("release_pipeline_lock", { p_key: lockKey }) } catch (_) { /* ignore */ }
    }

    if (done) await setState(coll.id, { done: true, last_status: "done" })
    const ok = !lastErr
    await logRun(pipeline, startMs, ok, seen, written, cursorBefore, cursor, { pages, done, page_size: pageSize, err: lastErr, total_opened: st.total_opened, rips_total_after: Number(st.rips_written) + written }, ok ? null : lastErr)
    return new Response(JSON.stringify({ mode, collection: collKey, pages, packs_seen: seen, rips_written: written, done, cursor_after: cursor, err: lastErr, rips_total: Number(st.rips_written) + written, total_opened: st.total_opened }), { headers: { "content-type": "application/json" } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logRun(pipeline, startMs, false, 0, 0, st.after_cursor, st.after_cursor, { exception: true }, msg)
    return new Response(JSON.stringify({ error: "exception", message: msg }), { status: 200, headers: { "content-type": "application/json" } })
  }
})
