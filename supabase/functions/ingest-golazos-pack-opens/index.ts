// ingest-golazos-pack-opens — LaLiga Golazos pack OPENS from Dapper's PackNFT index
// (searchPackNft, status "Opened", newest opening first) into golazos_pack_opens,
// with every pulled NFT named by edition (searchGolazosNft) into
// golazos_pack_open_pulls. New 2026-09-23: RPC held zero Golazos pack opens.
//
// Head-first + history sweep via ../_shared/head-sweep-walker.ts; row shape and
// parsing in ../_shared/pack-opens-walker.ts (unit-tested). Logs itself as
// "golazos-pack-opens-ingest".
//
// Gate: ?key= must equal PACK_SALES_GATE_KEY (or _OLD); pg_cron sends
// public.cron_gate_key('ingest-golazos-pack-opens'), a Vault copy of that value.
// ?reset=1 restarts the sweep; ?pages=N page budget (≤40); ?head=N (≤10).
import { createClient } from "@supabase/supabase-js"
import { checkGate, logHeadSweep, runHeadSweepWalk } from "../_shared/head-sweep-walker.ts"
import { makeOpensFetch, nameGolazosPulls, openKey, type PackOpenRow } from "../_shared/pack-opens-walker.ts"

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

const CFG = { pipeline: "golazos-pack-opens-ingest", collectionSlug: "laliga_golazos" }
const PACK_TYPE = "A.87ca73a41bb50ad5.PackNFT.NFT"
const MOMENT_PREFIX = "A.87ca73a41bb50ad5.Golazos"
const HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://nflallday.com",
  "Referer": "https://nflallday.com/",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const denied = checkGate(url, {
    key: Deno.env.get("PACK_SALES_GATE_KEY") ?? "",
    keyOld: Deno.env.get("PACK_SALES_GATE_KEY_OLD") ?? "",
  })
  if (denied) return denied
  const reset = url.searchParams.get("reset") === "1"
  const totalPages = Math.min(40, Math.max(1, Number(url.searchParams.get("pages") || "20")))
  const headPages = Math.min(10, Math.max(1, Number(url.searchParams.get("head") || "3")))
  const startedAt = new Date().toISOString()
  let pullsWritten = 0
  let pullsUnnamed = 0

  const r = await runHeadSweepWalk<PackOpenRow>({
    fetchPage: makeOpensFetch(PACK_TYPE, MOMENT_PREFIX, HEADERS),
    keyOf: openKey,
    timeOf: (o) => o.opened_at,
    existingKeys: async (rows) => {
      const { data, error } = await sb.from("golazos_pack_opens").select("pack_nft_id").in("pack_nft_id", rows.map(openKey))
      if (error) return { keys: new Set<string>(), error: error.message }
      return { keys: new Set<string>((data ?? []).map((d: any) => String(d.pack_nft_id))), error: null }
    },
    upsert: async (rows) => {
      const { error } = await sb.from("golazos_pack_opens").upsert(rows, { onConflict: "pack_nft_id" })
      if (error) return error.message
      // Name pulls only for packs that do not have them yet (a re-seen page costs no lookups).
      const { data: have, error: hErr } = await sb.from("golazos_pack_open_pulls").select("pack_nft_id").in("pack_nft_id", rows.map(openKey))
      if (hErr) return "pulls probe: " + hErr.message
      const done = new Set((have ?? []).map((d: any) => String(d.pack_nft_id)))
      const todo = rows.filter((o) => !done.has(o.pack_nft_id) && o.nft_ids.length > 0)
      if (todo.length === 0) return null
      const named = await nameGolazosPulls(todo, HEADERS)
      if (named.error) return "name pulls: " + named.error
      const { error: pErr } = await sb.from("golazos_pack_open_pulls").upsert(named.pulls, { onConflict: "nft_id" })
      if (pErr) return "pulls upsert: " + pErr.message
      pullsWritten += named.pulls.length
      pullsUnnamed += named.pulls.filter((p) => p.edition_external_id == null).length
      return null
    },
    readCursor: async () => {
      const { data, error } = await sb.from("golazos_pack_opens_cursor").select("after_cursor,done").eq("id", 1).maybeSingle()
      if (error) return { after: null, done: false, error: error.message }
      return { after: data?.after_cursor ?? null, done: data?.done === true, error: null }
    },
    writeCursor: async (after, done, totalSeen) => {
      const { error } = await sb.from("golazos_pack_opens_cursor").upsert({
        id: 1, after_cursor: after, done, total_seen: totalSeen, updated_at: new Date().toISOString(),
      })
      return error ? error.message : null
    },
  }, { headPages, totalPages, reset })

  const logErr = await logHeadSweep(sb, CFG, startedAt, r, { pulls_written: pullsWritten, pulls_unnamed: pullsUnnamed })
  return new Response(JSON.stringify({ ...r, pulls_written: pullsWritten, pulls_unnamed: pullsUnnamed, log_error: logErr }), {
    status: r.ok ? 200 : 502,
    headers: { "content-type": "application/json" },
  })
})
