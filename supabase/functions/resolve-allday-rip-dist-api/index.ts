// resolve-allday-rip-dist-api v6 — attribute opened AllDay packs to dist via Dapper searchPackNft.
// PackNftFilter: pack id filter is `id` (UInt64Filter); dist_id + status also exposed. Writes debug.
//
// v6 (2026-08-18): the gate was a HARDCODED LITERAL (`const GATE="…"`). That made this function
// unrotatable by the documented procedure — there was no secret to copy a new key into, which is
// why repointing cron jobid 26 to a fresh key 403'd with no way to paste a fix. It now reads its
// key from a Supabase edge SECRET like every other gate-keyed function here.
//
// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set ALLDAY_RIP_DIST_GATE_KEY=<new-random>
// Bare specifier through supabase/functions/deno.json (jsr:@supabase/supabase-js@2),
// like the other functions. It was the one raw esm.sh URL in the fleet, which
// left edge-fn-drift unable to classify it, so edge-fn-deploy.yml's read-back
// could never pass for it (2026-10-02).
import { createClient } from "@supabase/supabase-js"
const GATE = Deno.env.get("ALLDAY_RIP_DIST_GATE_KEY") ?? ""
// Transitional SECOND key, read from its own secret — never a literal (this repo is PUBLIC).
// During a key rotation, set ALLDAY_RIP_DIST_GATE_KEY_OLD to the OUTGOING key: both are then accepted, so the
// pg_cron ?key= values can be repointed one job at a time instead of atomically. Finish the
// rotation by DELETING the _OLD secret — no redeploy needed. Both unset ⇒ still fails CLOSED.
const GATE_OLD = Deno.env.get("ALLDAY_RIP_DIST_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
}
const EP="https://api.production.studio-platform.dapperlabs.com/graphql"
const ALLDAY="dee28451-5d62-409e-a1ad-a83f763ac070"
const sb=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"")
const H={"Content-Type":"application/json","Origin":"https://nflallday.com","Referer":"https://nflallday.com/","User-Agent":"RipPacksCity/1.0"}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function raw(query:string,variables?:any){ const r=await fetch(EP,{method:"POST",headers:H,body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(25000)}); return await r.json().catch(()=>null) }
const Q=`query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ edges{ node{ id dist_id status } } } }`
async function lookup(ids:string[]){ return await raw(Q,{ i:{ first: ids.length, filters:[{ id:{ in: ids } }] } }) }

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
  const url=new URL(req.url)
  if(!gateKeyOk(url.searchParams.get("key"))) return new Response(JSON.stringify({error:"forbidden"}),{status:403})
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
  if(url.searchParams.get("mode")==='probe'){ const j=await lookup(ids.slice(0,3)).catch((e)=>({fetch_error:String(e)})); return new Response(JSON.stringify({probe:true,resp:j}),{headers:{"content-type":"application/json"}}) }
  if(ids.length===0){
    await logRun(startedAt,true,0,0,0,null,{note:"none"})
    return new Response(JSON.stringify({note:'none'}),{headers:{"content-type":"application/json"}})
  }
  let resolved=0, matched=0, updErrors=0, err:string|null=null, updErr:string|null=null
  const statuses:Record<string,number>={}
  for(let i=0;i<ids.length;i+=50){
    let j:any
    try{ j=await lookup(ids.slice(i,i+50)) }catch(e){ err=`lookup: ${e instanceof Error?e.message:String(e)}`; break }
    if(!j){ err="lookup: not-json"; break }
    if(j?.errors?.length){ err=String(j.errors[0].message); break }
    for(const e of (j?.data?.searchPackNft?.edges??[])){
      const n=e.node; if(!n?.id) continue
      matched++; statuses[n.status||'?']=(statuses[n.status||'?']||0)+1
      if(n.dist_id){
        const { error:uErr }=await sb.from("pack_rips").update({dist_id:String(n.dist_id)}).eq("collection_id",ALLDAY).eq("pack_nft_id",String(n.id))
        if(uErr){ updErrors++; updErr=updErr??uErr.message.slice(0,200) } else resolved++
      }
    }
    await sleep(120)
  }
  const error=err??(updErr?`pack_rips update: ${updErr}`:null)
  await logRun(startedAt,!error,ids.length,resolved,ids.length-resolved,error,{matched,statuses,update_errors:updErrors})
  return new Response(JSON.stringify({candidates:ids.length,matched,resolved,update_errors:updErrors,err:error}),{headers:{"content-type":"application/json"}})
})
