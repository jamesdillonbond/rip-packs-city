// backfill-allday-dist-opened — authoritative per-dist opened count via Dapper searchPackNft
// (filter dist_id + status=Opened, read totalCount). Complete depletion across the whole AllDay catalog.
// Iterates allday_pack_supply dists ascending by dist_id (the "cursor" is `opened_count IS NULL`;
// the allday-dist-opened-expiry leg re-NULLs stale rows so they are counted again).
// Called by pg_cron jobid 27 (rpc-allday-dist-opened-backfill, every 4 min).
//
// ── v33 (2026-10-14, register R21) ─────────────────────────────────────────
// Source RECOVERED from deployed v32 through a redacted subagent: this function had no
// committed source, and its gate was a HARDCODED LITERAL (`const GATE="…"`), so it sat
// outside every credential guard and could not be rotated. Changes from v32, and only these:
//   * Gate: ../_shared/cron-gate.ts — the key (x-rpc-gate-key header, or ?key=) is checked
//     against the SAME Vault secret pg_cron sends, cron_gate_key('backfill-allday-dist-opened').
//   * Bare specifier through supabase/functions/deno.json, like the rest of the fleet (an
//     esm.sh URL leaves edge-fn-drift unable to classify the function).
//   * HONESTY (three fabrications, each found reading v32):
//     - A non-JSON reply (Dapper's Cloudflare challenge page) parsed to null, carried no
//       `errors`, and counted as ok with an undefined total; the write then stored
//       `opened_count = 0` — a fabricated zero this walk does not revisit (it selects only
//       `opened_count IS NULL`) until the separate `allday-dist-opened-expiry` leg re-NULLs
//       the row as stale; until then it publishes as "0 opened". A reply without a numeric
//       totalCount is now a FAILURE, and nothing is written for that dist.
//     - A failed batch READ returned `{done:true}` — a failed read rendered as "finished".
//       It is now a 500 carrying the error.
//     - The update's returned `error` was never read, so `counted` rose on a rejected write.
//       It is read now; a failed write stops the batch and is reported.
//   The unused `after` param is gone (it was read and never used).
import { createClient } from "@supabase/supabase-js"
import { cronGate } from "../_shared/cron-gate.ts"
const EP="https://api.production.studio-platform.dapperlabs.com/graphql"
const sb=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"")
const H={"Content-Type":"application/json","Origin":"https://nflallday.com","Referer":"https://nflallday.com/","User-Agent":"RipPacksCity/1.0"}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const Q=`query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount } }`
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})

type Count = { ok:true; total:number } | { ok:false; error:string }

async function countFor(distId:string, opened:boolean):Promise<Count>{
  // deno-lint-ignore no-explicit-any
  const filt:any={ dist_id:{ eq: distId } }; if(opened) filt.status={ eq:"Opened" }
  let r:Response
  try{
    r=await fetch(EP,{method:"POST",headers:H,body:JSON.stringify({query:Q,variables:{ i:{ first:0, filters:[filt] } }}),signal:AbortSignal.timeout(20000)})
  }catch(e){ return {ok:false,error:`fetch: ${String((e as Error)?.message ?? e).slice(0,120)}`} }
  // deno-lint-ignore no-explicit-any
  const j=await r.json().catch(()=>null) as any
  if(j?.errors?.length) return {ok:false,error:String(j.errors[0].message)}
  const total=j?.data?.searchPackNft?.totalCount
  // ⛔ No number, no count. A Cloudflare page, an HTTP error or a reshaped reply is not "0 opened".
  if(!r.ok || typeof total!=="number" || !Number.isFinite(total)){
    return {ok:false,error:`no totalCount (http ${r.status})`}
  }
  return {ok:true,total}
}

Deno.serve(async(req)=>{
  const gateDenied = await cronGate(req, sb, "backfill-allday-dist-opened")
  if (gateDenied) return gateDenied
  const url=new URL(req.url)
  if(url.searchParams.get("mode")==='probe'){ const d=url.searchParams.get("dist")||"180"; const o=await countFor(d,true); const t=await countFor(d,false); return json({dist:d,opened:o,total:t}) }
  const budget=Math.min(300,Math.max(1,Number(url.searchParams.get("n")||"120")))
  // next batch of dists not yet counted (opened_count NULL), ascending
  const { data:dists, error:readErr }=await sb.from("allday_pack_supply").select("dist_id").is("opened_count",null).order("dist_id").limit(budget)
  if(readErr) return json({error:`batch read: ${readErr.message}`},500)
  // deno-lint-ignore no-explicit-any
  const list=(dists??[]).map((r:any)=>String(r.dist_id))
  if(list.length===0) return json({done:true})
  let done=0, err:string|null=null
  for(const d of list){
    const o=await countFor(d,true); if(!o.ok){ err=o.error; break }
    const t=await countFor(d,false)
    const { error:wErr }=await sb.from("allday_pack_supply").update({ opened_count:o.total, packnft_total: t.ok? t.total:null, opened_updated_at:new Date().toISOString() }).eq("dist_id",d)
    if(wErr){ err=`update ${d}: ${wErr.message}`; break }
    done++; await sleep(60)
  }
  const { count:remaining, error:remErr }=await sb.from("allday_pack_supply").select("*",{count:"exact",head:true}).is("opened_count",null)
  // `remaining` is null (unknown), never 0, when its read failed.
  return json({counted:done,remaining:remErr? null : remaining,remaining_error:remErr?.message ?? null,err})
})
