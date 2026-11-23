#!/usr/bin/env node
// Read-only research probe: what Courtyard pack openers actually got back in
// cash when they sold the pull to Courtyard's instant buyback.
// Public Polygon chain data only (receipts + eth_getLogs). No Courtyard
// metadata, no Courtyard API.
//
//   node scripts/physical/courtyard-pack-returns.mjs [rpc=https://polygon.drpc.org]
//
// Method: for 300-block windows at 26/20/14/8 h ago, take pack purchases on the
// pack contract, read each receipt for the USDC paid and the single token
// minted, then scan the trade settler for the next 3,600 blocks (~2 h) for a
// buyback of that token by the house wallet. Return = buyback USDC / pack USDC.
// Pulls the opener KEPT are not in the return figure (they may skew higher).
//
// 2026-11-22: 421 single-card packs; 82 % sold back within ~2 h (median well
// under a minute); median 0.70, dollar-weighted 0.82, 14 % returned >= $1.
const RPC=process.argv[2]??"https://polygon.drpc.org";let id=1;
async function rpc(m,p){for(let i=0;i<5;i++){try{const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:id++,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result;}catch(e){if(i==4)throw e;await new Promise(r=>setTimeout(r,1500));}}}
const PACK="0x07d79f0f6879f4d555431573320236628d16083e",T_PACK="0xcaa9325838005b5b7578713a64b079f8be640ba4bffcd8c45085b387f9d5fe48";
const REG="0x251be3a17af4892035c37ebf5890f4a4d889dcad",TR="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",USDC="0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SET="0x7c57a44474ddd74c055ae5ad08b3c9d22d64e50e",T="0x279d1d0274c98fe823227d8ca6e26bc93a760c8277c64309f8ac9132aa0e706c",HOUSE="0x66dbff2ce099d19b4e8c5dc8b254ec7aeaf5e642";
const head=parseInt(await rpc("eth_blockNumber",[]),16);
const rows=[];
for(const hoursAgo of [26,20,14,8]){
 const s=head-hoursAgo*1800;const txs=new Set();
 for(let f=s;f<s+300;f+=100){(await rpc("eth_getLogs",[{address:PACK,topics:[T_PACK],fromBlock:"0x"+f.toString(16),toBlock:"0x"+(f+99).toString(16)}])).forEach(l=>txs.add(l.transactionHash));}
 const packs=[];
 for(const t of [...txs].slice(0,150)){const rc=await rpc("eth_getTransactionReceipt",[t]);
  const mints=rc.logs.filter(l=>l.address===REG&&l.topics[0]===TR&&l.topics[1]==="0x"+"0".repeat(64)).map(l=>l.topics[3]);
  const pay=rc.logs.filter(l=>l.address===USDC&&l.topics[0]===TR);const paid=pay.length?Math.max(...pay.map(l=>Number(BigInt(l.data))/1e6)):null;
  if(paid&&mints.length===1)packs.push({block:parseInt(rc.blockNumber,16),paid,token:mints[0]});}
 const want=new Map(packs.map(p=>[p.token,p]));const hits={};
 for(let f=s;f<s+300+3600;f+=100){const logs=await rpc("eth_getLogs",[{address:SET,topics:[T],fromBlock:"0x"+f.toString(16),toBlock:"0x"+(f+99).toString(16)}]);
  for(const l of logs){const d=l.data.slice(2),w=i=>d.slice(i*64,i*64+64);const off=parseInt(w(0),16)/32;if(parseInt(w(off),16)!==1)continue;const tok="0x"+w(off+1);if(!want.has(tok)||hits[tok])continue;
   if("0x"+l.topics[1].slice(26)===HOUSE)hits[tok]=Number(BigInt("0x"+w(3)))/1e6;}}
 for(const p of packs)rows.push({hoursAgo,paid:p.paid,buyback:hits[p.token]??null});
 console.log("window",hoursAgo,"h ago: packs",packs.length,"sold back",packs.filter(p=>hits[p.token]).length);
}

const q=(a,p)=>{a=[...a].sort((x,y)=>x-y);return a.length?+a[Math.floor(p*(a.length-1))].toFixed(3):null};
const sb=rows.filter(r=>r.buyback!=null);const ret=sb.map(r=>r.buyback/r.paid);
console.log(JSON.stringify({packs:rows.length,soldBackShare:+(sb.length/rows.length).toFixed(3),
 returnP25:q(ret,.25),returnMedian:q(ret,.5),returnP75:q(ret,.75),
 dollarWeighted:+(sb.reduce((s,r)=>s+r.buyback,0)/sb.reduce((s,r)=>s+r.paid,0)).toFixed(3),
 shareAtOrAbovePrice:+(ret.filter(x=>x>=1).length/ret.length).toFixed(3)},null,2));
