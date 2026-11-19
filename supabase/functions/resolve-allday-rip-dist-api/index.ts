// resolve-allday-rip-dist-api v7 — hand unattributed All Day rips to the pack-nft-identity lane (Atlas, 2026-11-18).
// (v6: attributed them itself via Dapper searchPackNft, on Studio GraphQL, HTTP 530 since 2026-11-17.)
// PackNftFilter: pack id filter is `id` (UInt64Filter); dist_id + status also exposed. Writes debug.
//
// v6 (2026-08-18): the gate was a HARDCODED LITERAL (`const GATE="…"`). That made this function
// unrotatable by the documented procedure — there was no secret to copy a new key into, which is
// why repointing cron jobid 26 to a fresh key 403'd with no way to paste a fix. It now reads its
// key from a Supabase edge SECRET like every other gate-keyed function here.
//
// Gate (2026-10-13): ../_shared/cron-gate.ts — the key (x-rpc-gate-key header or ?key=) is
// checked against the SAME Vault secret pg_cron sends, cron_gate_key('resolve-allday-rip-dist-api'). No env
// secret is read; a rotation is one vault.update_secret (rpc-edge-fn-deploy §0).
// Bare specifier through supabase/functions/deno.json (jsr:@supabase/supabase-js@2),
// like the other functions. It was the one raw esm.sh URL in the fleet, which
// left edge-fn-drift unable to classify it, so edge-fn-deploy.yml's read-back
// could never pass for it (2026-10-02).
import { createClient } from "@supabase/supabase-js"
import { cronGate } from "../_shared/cron-gate.ts"
const ALLDAY="dee28451-5d62-409e-a1ad-a83f763ac070"
const sb=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"")

// One pipeline_runs row per run (2026-10-03). Until now this hourly lane (pg_cron
// jobid 26, :17) left no trace on success: its only record was an upsert into
// `api_probe_debug`, a table that does not exist, so that write failed silently on
// every run and the sentinel's edge-lane registry could not say what this lane
// writes. It writes `pack_rips.dist_id` for All Day rips Dapper's index can name.
// `rows_written` counts updates that LANDED (the update result was never read, so
// `resolved` counted attempts).
const PIPELINE="allday-rip-dist-resolve"
async function logRun(startedAt:number, ok:boolean, found:number|null, written:number|null, skipped:number|null, error:string|null, extra:Record<string,unknown>){
  try{
    const { error:logErr }=await (sb as any).rpc("log_pipeline_run",{
      p_pipeline:PIPELINE, p_started_at:new Date(startedAt).toISOString(),
      p_rows_found:found, p_rows_written:written, p_rows_skipped:skipped,
      p_ok:ok, p_error:error, p_collection_slug:"nfl_all_day",
      p_cursor_before:null, p_cursor_after:null,
      p_extra:{ ...extra, elapsed_ms:Date.now()-startedAt },
    })
    if(logErr) console.error(`[${PIPELINE}] log_pipeline_run failed: ${logErr.message}`)
  }catch(e){ console.error(`[${PIPELINE}] log_pipeline_run threw: ${e instanceof Error?e.message:String(e)}`) }
}

Deno.serve(async(req)=>{
  const gateDenied = await cronGate(req, sb, "resolve-allday-rip-dist-api")
  if (gateDenied) return gateDenied
  const startedAt=Date.now()
  // Bounded at PostgREST's 1,000-row cap (was .limit(3000), a bound PostgREST
  // clamps to 1,000 anyway; folded down on 2026-10-02 with the read-error fix,
  // as the old comment's EXIT asked). The queue is tens of rows an hour; a
  // backlog past 1,000 drains over successive ticks.
  const { data:rows, error:rowsErr }=await sb.from("pack_rips").select("pack_nft_id").eq("collection_id",ALLDAY).is("dist_id",null).limit(1000)
  // A failed read is not "none". It answered {note:'none'} with HTTP 200 and
  // wrote nothing anywhere, so an hourly lane with a dead read looked exactly
  // like one with an empty queue. The 500 lands in net._http_response.
  // (supabase/functions/_tests/failed_run_honesty_test.ts)
  if(rowsErr){
    const error=`pack_rips read: ${rowsErr.message.slice(0,200)}`
    await logRun(startedAt,false,null,null,null,error,{stage:"targets"})
    return new Response(JSON.stringify({ok:false,error}),{status:500,headers:{"content-type":"application/json"}})
  }
  const ids=(rows??[]).map((r:any)=>String(r.pack_nft_id))
  if(ids.length===0){
    await logRun(startedAt,true,0,0,0,null,{note:"none"})
    return new Response(JSON.stringify({note:'none'}),{headers:{"content-type":"application/json"}})
  }
  // 2026-11-18 (#218): Studio GraphQL (searchPackNft) is HTTP 530 since 11-17. Atlas answers
  // ResolvePackDistribution, but only per pack and only reliably from the database's egress, so
  // this lane no longer looks anything up itself: it hands the rips to the pack-nft-identity lane
  // (dispatch_pack_nft_identity enqueues them and sends at most 30 a call), whose collector writes
  // pack_rips.dist_id. rows_written is therefore 0 here by construction; the names land there.
  const { data:res, error:rpcErr }=await sb.rpc("dispatch_pack_nft_identity",{p_batches:1,p_batch_size:30,p_pack_nft_ids:ids})
  const error=rpcErr?`dispatch_pack_nft_identity: ${rpcErr.message.slice(0,200)}`:null
  const r=(res??{}) as Record<string,unknown>
  await logRun(startedAt,!error,ids.length,0,null,error,{handed_to:"pack-nft-identity",enqueued:r.enqueued??null,skipped_no_collection:r.skipped_no_collection??null,dispatched:r.dispatched??null,queue_depth:r.queue_depth??null})
  return new Response(JSON.stringify({candidates:ids.length,handed_to:"pack-nft-identity",dispatch:res??null,err:error}),{status:error?500:200,headers:{"content-type":"application/json"}})
})
