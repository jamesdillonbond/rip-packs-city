// resolve-allday-pull-editions v3 — resolve AllDay pulled moment_nft_id -> editionID by borrowing
// at each pull's OPEN BLOCK (the moment is always in the opener's collection right after the open,
// so this recovers moments the opener has since moved — strictly better than current-block borrow).
// Verified: moment 4203516 @ block 156367718 -> editionID 1309 even though moved since.
// Flow REST script execution at block_height; maps editionID -> editions.id + FMV; fills
// allday_pack_pull.edition_id/fmv_usd. pack_rips.pull_value_usd rollup is a separate cron.
// mode=test (owner+id+block) | resolve (open-block batch). Called by pg_cron jobid 22.
//
// ── v35 (2026-10-14, register R21) ─────────────────────────────────────────
// Source RECOVERED from deployed v34 through a redacted subagent: this function had no
// committed source, and its gate was a HARDCODED LITERAL (`const GATE="…"`), so it sat
// outside every credential guard and could not be rotated. Changes from v34, and only these:
//   * Gate: ../_shared/cron-gate.ts — the key (x-rpc-gate-key header, or ?key=) is checked
//     against the SAME Vault secret pg_cron sends, cron_gate_key('resolve-allday-pull-editions').
//   * Bare specifier through supabase/functions/deno.json, like the rest of the fleet.
//   * HONESTY: every read's and write's returned `error` was ignored, so a failed editions or
//     FMV read silently resolved nothing (or wrote `fmv_usd: null` over a priceable pull), a
//     rejected update still counted as `resolved`, and a failed candidate read answered
//     "none unresolved". Now: a failed candidate read is a 500; a failed editions/FMV read
//     skips that batch and is counted in `readFails` (nothing is written from a partial
//     read); `resolved` counts rows WRITTEN, and rejected writes are counted in `writeFails`.
//     A failed test-mode probe, or a resolve run where batches failed and nothing resolved,
//     answers 502 (this lane writes no pipeline_runs row; the status is its only trace).
import { createClient } from "@supabase/supabase-js"
import { cronGate } from "../_shared/cron-gate.ts"
const REST="https://rest-mainnet.onflow.org"
const ALLDAY="dee28451-5d62-409e-a1ad-a83f763ac070"
const sb=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"")
const b64=(s:string)=>btoa(s)
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})

const SCRIPT=`import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(owners: [Address], ids: [UInt64]): {UInt64: UInt64} {
    let out: {UInt64: UInt64} = {}
    var i = 0
    while i < ids.length {
        let capRef = getAccount(owners[i]).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
        if capRef != nil {
            let nft = capRef!.borrowMomentNFT(id: ids[i])
            if nft != nil { out[ids[i]] = nft!.editionID }
        }
        i = i + 1
    }
    return out
}`

async function execScript(owners:string[], ids:string[], block?:string){
  const at = block ? String(block) : "sealed"
  const body={ script: b64(SCRIPT), arguments: [
    b64(JSON.stringify({type:"Array",value:owners.map(o=>({type:"Address",value:o}))})),
    b64(JSON.stringify({type:"Array",value:ids.map(i=>({type:"UInt64",value:String(i)}))})),
  ]}
  const r=await fetch(`${REST}/v1/scripts?block_height=${at}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)})
  if(!r.ok) return {ok:false as const,status:r.status,text:(await r.text()).slice(0,200)}
  const raw=await r.text()
  // deno-lint-ignore no-explicit-any
  let decoded:any
  try{ decoded=JSON.parse(atob(raw.trim().replace(/^"|"$/g,""))) }catch{ return {ok:false as const,text:"decode"} }
  const map:Record<string,string>={}
  for(const kv of (decoded?.value??[])){ map[String(kv.key?.value)]=String(kv.value?.value) }
  return {ok:true as const,map}
}

type BatchResult = { ok:true; resolved:number; valued:number; writeFails:number } | { ok:false; error:string }

async function writeBatch(pairs:{moment:string,editionID:string}[]):Promise<BatchResult>{
  const edIds=Array.from(new Set(pairs.map(p=>p.editionID)))
  if(edIds.length===0) return {ok:true,resolved:0,valued:0,writeFails:0}
  const { data:eds, error:edErr }=await sb.from("editions").select("id,external_id").eq("collection_id",ALLDAY).in("external_id",edIds)
  if(edErr) return {ok:false,error:`editions: ${edErr.message}`}
  // deno-lint-ignore no-explicit-any
  const byExt=new Map((eds??[]).map((e:any)=>[String(e.external_id),e.id]))
  const edUuids=Array.from(byExt.values())
  const fmvByEd=new Map<string,number>()
  if(edUuids.length){
    const { data:fr, error:fmvErr }=await sb.rpc("get_fmv_for_editions",{p_collection_id:ALLDAY,p_edition_ids:edUuids})
    // ⛔ A failed FMV read is not "no FMV": writing fmv_usd:null from it would erase a price.
    if(fmvErr) return {ok:false,error:`fmv: ${fmvErr.message}`}
    // deno-lint-ignore no-explicit-any
    for(const f of (fr??[]) as any[]){ if(f.fmv_usd!=null) fmvByEd.set(String(f.edition_id),Number(f.fmv_usd)) }
  }
  let resolved=0, valued=0, writeFails=0
  for(const p of pairs){
    const uuid=byExt.get(p.editionID); if(!uuid) continue
    const fmv=fmvByEd.get(uuid)??null
    const { error:wErr }=await sb.from("allday_pack_pull").update({edition_id:uuid,fmv_usd:fmv}).eq("moment_nft_id",p.moment)
    if(wErr){ writeFails++; continue }
    resolved++; if(fmv!=null) valued++
  }
  return {ok:true,resolved,valued,writeFails}
}

Deno.serve(async(req)=>{
  const gateDenied = await cronGate(req, sb, "resolve-allday-pull-editions")
  if (gateDenied) return gateDenied
  const url=new URL(req.url)
  const mode=url.searchParams.get("mode")||"test"

  if(mode==="test"){
    const owner=url.searchParams.get("owner")||"0xbd94cade097e50ac"
    const id=url.searchParams.get("id")||"9781818"
    const block=url.searchParams.get("block")||undefined
    const res=await execScript([owner],[id],block)
    // A failed script is a failed probe: non-2xx, so no caller reads it as a clean answer.
    return json({mode,owner,id,block,res},res.ok?200:502)
  }

  const limit=Math.min(600,Math.max(1,Number(url.searchParams.get("limit")||"300")))
  const { data:rows, error:rowsErr }=await sb.rpc("get_allday_unresolved_pulls",{p_limit:limit})
  if(rowsErr) return json({mode,error:`candidates: ${rowsErr.message}`},500)
  // deno-lint-ignore no-explicit-any
  const pulls=(rows??[]) as any[]
  if(pulls.length===0) return json({mode,resolved:0,note:"none unresolved"})

  // group by open block_height (pulls from one open share a block)
  // deno-lint-ignore no-explicit-any
  const byBlock=new Map<string,any[]>()
  for(const p of pulls){ const k=String(p.block_height); if(!byBlock.has(k)) byBlock.set(k,[]); byBlock.get(k)!.push(p) }

  let totalResolved=0, valued=0, scriptFails=0, readFails=0, writeFails=0, blocks=0
  let lastError:string|null=null
  for(const [block,group] of byBlock){
    blocks++
    for(let i=0;i<group.length;i+=50){
      const batch=group.slice(i,i+50)
      const res=await execScript(batch.map(p=>p.opener_address), batch.map(p=>p.moment_nft_id), block)
      if(!res.ok){ scriptFails++; continue }
      const pairs=batch.map(p=>({moment:String(p.moment_nft_id),editionID:res.map[String(p.moment_nft_id)]})).filter(x=>x.editionID && x.editionID!=="undefined")
      const w=await writeBatch(pairs)
      if(!w.ok){ readFails++; lastError=w.error; continue }
      totalResolved+=w.resolved; valued+=w.valued; writeFails+=w.writeFails
    }
  }
  // This lane writes no pipeline_runs row, so the HTTP status is its only trace (pg_net keeps it
  // in net._http_response). A run where batches failed and NOTHING resolved is a failure, not a
  // quiet tick: 502. Partial progress stays 200 with the failure counts in the body.
  const failed=scriptFails+readFails+writeFails
  const status=(failed>0 && totalResolved===0) ? 502 : 200
  return json({mode,candidates:pulls.length,blocks,resolved:totalResolved,valued,scriptFails,readFails,writeFails,lastError},status)
})
