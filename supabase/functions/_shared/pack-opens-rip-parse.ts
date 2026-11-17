// Shared pure logic for backfill-pack-opens-api — the edge fn that pages the
// Dapper Studio "Opened" pack index and writes each open into `pack_rips`.
//
// toRip is the load-bearing map: it turns one GraphQL pack node into the rip row
// (or null to skip). What it decides:
//   • skip a node with no open tx / block_time / owner (an un-openable / partial
//     node must never land as a rip),
//   • normalize opener_address to a single leading 0x + lowercase,
//   • derive moments_pulled from the comma-joined `nfts` string — the PULL COUNT
//     that feeds pack-open analytics (an off-by-one here mis-states every open),
//   • keep block_height / dist_id null-safe (never NaN / "undefined").
//
// Ported VERBATIM from backfill-pack-opens-api/index.ts, with collection_id
// lifted to a param so it stays pure. The deployed edge fn carries the inline
// copy (excluded from CI's coverage run — no Deno toolchain); the source-drift
// guard in __tests__/edge-pack-opens-rip-parse.test.ts fails CI if the inline
// copy is edited without mirroring it here.

export type Rip = {
  collection_id: string
  pack_nft_id: string
  opener_address: string
  moments_pulled: number
  tx_hash: string
  block_height: number | null
  sealed_at: string
  dist_id: string | null
}

export function toRip(collId: string, node: any): Rip | null {
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
