// ingest-pinnacle-pack-opens — Disney Pinnacle pack OPENS from Dapper's PackNFT
// index (searchPackNft, status "Opened", newest opening first) into
// pinnacle_pack_opens. New 2026-09-23: RPC held zero Pinnacle pack opens.
//
// The index holds 904,722 Pinnacle PackNFTs: 451,785 Sealed, 88,346 Opened, and
// 364,591 "Revealed" whose `nfts` point at a placeholder contract
// (A.0000000012345abc.PinnacleEmpty) — those are NOT opens and are not read.
// Every opened Pinnacle PackNFT is owned by the Pinnacle contract account, so
// the opener is stored as NULL rather than attributed to the custodian. Pulls
// are priced in SQL (price_pinnacle_pack_opens) from pinnacle_mint_events →
// pinnacle_catalog, so this lane makes no per-NFT lookups.
//
// Gate: ?key= must equal PACK_SALES_GATE_KEY (or _OLD); pg_cron sends
// public.cron_gate_key('ingest-pinnacle-pack-opens'), a Vault copy of that value.
import { createClient } from "@supabase/supabase-js"
import { checkGate, logHeadSweep, runHeadSweepWalk } from "../_shared/head-sweep-walker.ts"
import { makeOpensFetch, openKey, type PackOpenRow } from "../_shared/pack-opens-walker.ts"

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

const CFG = { pipeline: "pinnacle-pack-opens-ingest", collectionSlug: "disney_pinnacle" }
const PACK_TYPE = "A.edf9df96c92f4595.PackNFT.NFT"
const MOMENT_PREFIX = "A.edf9df96c92f4595.Pinnacle"
const CUSTODIAN = "0xedf9df96c92f4595"
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

  const r = await runHeadSweepWalk<PackOpenRow>({
    fetchPage: makeOpensFetch(PACK_TYPE, MOMENT_PREFIX, HEADERS, CUSTODIAN),
    keyOf: openKey,
    timeOf: (o) => o.opened_at,
    existingKeys: async (rows) => {
      const { data, error } = await sb.from("pinnacle_pack_opens").select("pack_nft_id").in("pack_nft_id", rows.map(openKey))
      if (error) return { keys: new Set<string>(), error: error.message }
      return { keys: new Set<string>((data ?? []).map((d: any) => String(d.pack_nft_id))), error: null }
    },
    upsert: async (rows) => {
      const { error } = await sb.from("pinnacle_pack_opens").upsert(rows, { onConflict: "pack_nft_id" })
      return error ? error.message : null
    },
    readCursor: async () => {
      const { data, error } = await sb.from("pinnacle_pack_opens_cursor").select("after_cursor,done").eq("id", 1).maybeSingle()
      if (error) return { after: null, done: false, error: error.message }
      return { after: data?.after_cursor ?? null, done: data?.done === true, error: null }
    },
    writeCursor: async (after, done, totalSeen) => {
      const { error } = await sb.from("pinnacle_pack_opens_cursor").upsert({
        id: 1, after_cursor: after, done, total_seen: totalSeen, updated_at: new Date().toISOString(),
      })
      return error ? error.message : null
    },
  }, { headPages, totalPages, reset })

  const logErr = await logHeadSweep(sb, CFG, startedAt, r)
  return new Response(JSON.stringify({ ...r, log_error: logErr }), {
    status: r.ok ? 200 : 502,
    headers: { "content-type": "application/json" },
  })
})
