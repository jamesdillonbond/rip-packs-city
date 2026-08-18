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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
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
async function dbg(p:any){ await sb.from("api_probe_debug").upsert({id:1,payload:p,at:new Date().toISOString()}) }
const Q=`query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ edges{ node{ id dist_id status } } } }`
async function lookup(ids:string[]){ return await raw(Q,{ i:{ first: ids.length, filters:[{ id:{ in: ids } }] } }) }

Deno.serve(async(req)=>{
  const url=new URL(req.url)
  if(!gateKeyOk(url.searchParams.get("key"))) return new Response(JSON.stringify({error:"forbidden"}),{status:403})
  const { data:rows }=await sb.from("pack_rips").select("pack_nft_id").eq("collection_id",ALLDAY).is("dist_id",null).limit(3000)
  const ids=(rows??[]).map((r:any)=>String(r.pack_nft_id))
  if(url.searchParams.get("mode")==='probe'){ const j=await lookup(ids.slice(0,3)); await dbg({probe:true,resp:j}); return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}}) }
  if(ids.length===0){ return new Response(JSON.stringify({note:'none'}),{headers:{"content-type":"application/json"}}) }
  let resolved=0, statuses:Record<string,number>={}, err:any=null, matched=0
  for(let i=0;i<ids.length;i+=50){ const j=await lookup(ids.slice(i,i+50)); if(j?.errors?.length){ err=j.errors[0].message; break } for(const e of (j?.data?.searchPackNft?.edges??[])){ const n=e.node; if(!n?.id) continue; matched++; statuses[n.status||'?']=(statuses[n.status||'?']||0)+1; if(n.dist_id){ await sb.from("pack_rips").update({dist_id:String(n.dist_id)}).eq("collection_id",ALLDAY).eq("pack_nft_id",String(n.id)); resolved++ } } await sleep(120) }
  await dbg({candidates:ids.length,matched,resolved,statuses,err})
  return new Response(JSON.stringify({candidates:ids.length,matched,resolved,err}),{headers:{"content-type":"application/json"}})
})
