#!/usr/bin/env node
// Read-only research probe: samples Courtyard secondary trades on Polygon and
// reports volume, the house-buyback share and peer price quantiles.
// Uses only public chain data (eth_getLogs). Fetches NO Courtyard metadata.
//
//   node scripts/physical/courtyard-trade-sample.mjs [windows=48] [rpc=https://polygon.drpc.org]
//
// 2026-11-22 result: ~25k settler trades/day est., ~94 % bought by the house
// wallet 0x66db…e642, peer-trade median ≈ $16, ~16.8k pack purchases/day est.

const WINDOWS = process.argv[2] === undefined ? 48 : Number(process.argv[2])
if (!Number.isInteger(WINDOWS) || WINDOWS < 1) throw new Error("windows must be a positive integer")
const RPC = process.argv[3] ?? "https://polygon.drpc.org"
const SETTLER = "0x7c57a44474ddd74c055ae5ad08b3c9d22d64e50e"
const T_TRADE = "0x279d1d0274c98fe823227d8ca6e26bc93a760c8277c64309f8ac9132aa0e706c"
const HOUSE = "0x66dbff2ce099d19b4e8c5dc8b254ec7aeaf5e642"
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"
const BLOCKS_PER_DAY = 43_200 // ~2 s blocks
const SPAN = 99 // free-tier eth_getLogs cap

let id = 1
async function rpc(method, params) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      })
      const j = await r.json()
      if (j.error) throw new Error(JSON.stringify(j.error))
      return j.result
    } catch (e) {
      if (i === 2) throw e
      await new Promise((r) => setTimeout(r, 800))
    }
  }
}

const head = parseInt(await rpc("eth_blockNumber", []), 16)
let blocks = 0
const peer = []
let house = 0
let multi = 0
for (let k = 0; k < WINDOWS; k++) {
  const to = head - Math.floor((k * BLOCKS_PER_DAY) / WINDOWS)
  const from = to - (SPAN - 1)
  blocks += SPAN
  const logs = await rpc("eth_getLogs", [
    { address: SETTLER, topics: [T_TRADE], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
  ])
  for (const l of logs) {
    const buyer = "0x" + l.topics[1].slice(26)
    const seller = "0x" + l.topics[2].slice(26)
    const d = l.data.slice(2)
    const w = (i) => d.slice(i * 64, i * 64 + 64)
    if ("0x" + w(2).slice(24) !== USDC) continue
    if (buyer === HOUSE || seller === HOUSE) { house++; continue }
    const n = parseInt(w(parseInt(w(0), 16) / 32), 16)
    if (n !== 1) { multi++; continue }
    peer.push(Number(BigInt("0x" + w(3))) / 1e6)
  }
}
peer.sort((a, b) => a - b)
const q = (p) => (peer.length ? peer[Math.floor(p * (peer.length - 1))] : null)
const scale = BLOCKS_PER_DAY / blocks
const total = house + peer.length + multi
console.log(JSON.stringify({
  head,
  blocksSampled: blocks,
  estTradesPerDay: Math.round(total * scale),
  houseShare: total ? +(house / total).toFixed(3) : null,
  estPeerSingleTradesPerDay: Math.round(peer.length * scale),
  peerUsd: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: peer.at(-1) ?? null },
}, null, 2))
