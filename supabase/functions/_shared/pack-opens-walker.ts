// pack-opens-walker — pack OPENS from Dapper's PackNFT index (searchPackNft,
// status "Opened"), newest opening first. Built 2026-09-23 for LaLiga Golazos,
// which had ZERO pack opens in RPC (pack_rips holds Top Shot and All Day only):
// the index answers 78,825 opened Golazos packs, each with its dist_id, owner
// and the pulled NFT ids.
//
// Why a separate table and not pack_rips: pack_rips carries a UNIQUE index on
// pack_nft_id ALONE, and Golazos pack ids ("1", "2", …) collide with All Day's
// (934,768 All Day rips have ids of six digits or fewer). Widening that index
// changes the conflict target of every existing pack_rips writer; a Golazos
// table changes nothing that exists.
//
// Pulls are named edition-by-edition through searchGolazosNft (edition.id is
// RPC's editions.external_id for Golazos, verified on 3 NFTs 2026-09-23), so a
// pull value can be computed in SQL from fmv_snapshots with the same
// all-or-nothing rule as pack_rips.

import { type Page, type PageFetch, studioGql } from "./head-sweep-walker.ts"

export type PackOpenRow = {
  pack_nft_id: string
  dist_id: string | null
  opener_address: string | null
  opened_at: string | null
  open_tx: string | null
  open_block: number | null
  nft_ids: string[]
  moments_pulled: number
}

export type PullRow = {
  nft_id: string
  pack_nft_id: string
  edition_external_id: string | null
  serial_number: number | null
}

export const openKey = (r: PackOpenRow) => r.pack_nft_id

export const PACK_OPENS_QUERY =
  `query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ id dist_id status owner_address nfts updated_at{ block_time block_height transaction_hash } } } } }`

/** "A.87ca73a41bb50ad5.Golazos.669051632,…" → ["669051632", …] (only the given contract's NFTs). */
export function parseNftList(nfts: string | null | undefined, momentTypePrefix: string): string[] {
  if (!nfts) return []
  return nfts
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(momentTypePrefix + "."))
    .map((s) => s.slice(momentTypePrefix.length + 1))
    .filter((s) => /^[0-9]+$/.test(s))
}

/**
 * `custodian`: an account that holds opened packs on the collector's behalf
 * (Disney Pinnacle's contract account owns every opened Pinnacle PackNFT). Its
 * address is NOT the opener, so it is stored as NULL rather than attributed.
 */
export function mapOpenNode(node: any, momentTypePrefix: string, custodian?: string): PackOpenRow | null {
  if (!node || node.id == null || node.status !== "Opened") return null
  const u = node.updated_at || {}
  const ids = parseNftList(node.nfts, momentTypePrefix)
  // Dapper's index returns Flow addresses as bare lowercase hex; compare them as given.
  const raw = node.owner_address ? String(node.owner_address).replace(/^0x/, "") : null
  const owner = raw && raw !== (custodian ?? "").replace(/^0x/, "") ? "0x" + raw : null
  return {
    pack_nft_id: String(node.id),
    dist_id: node.dist_id != null && node.dist_id !== "" ? String(node.dist_id) : null,
    opener_address: owner,
    opened_at: u.block_time ?? null,
    open_tx: u.transaction_hash ?? null,
    open_block: u.block_height != null ? Number(u.block_height) : null,
    nft_ids: ids,
    moments_pulled: ids.length,
  }
}

export function parseOpensPage(data: any, momentTypePrefix: string, custodian?: string): Page<PackOpenRow> {
  const edges = Array.isArray(data?.edges) ? data.edges : []
  const m = new Map<string, PackOpenRow>()
  for (const e of edges) {
    const r = mapOpenNode(e?.node, momentTypePrefix, custodian)
    if (r) m.set(r.pack_nft_id, r)
  }
  return {
    totalCount: typeof data?.totalCount === "number" ? data.totalCount : null,
    endCursor: data?.pageInfo?.endCursor ?? null,
    hasNextPage: data?.pageInfo?.hasNextPage === true,
    rows: Array.from(m.values()),
  }
}

export function makeOpensFetch(packType: string, momentTypePrefix: string, headers: Record<string, string>, custodian?: string) {
  return async (after: string | null): Promise<PageFetch<PackOpenRow>> => {
    const variables = {
      i: {
        first: 100,
        after,
        sortBy: { updated_at: { block_height: { direction: "DESC", priority: 1 } } },
        filters: [{ type_name: { eq: packType }, status: { eq: "Opened" } }],
      },
    }
    const r = await studioGql(PACK_OPENS_QUERY, variables, headers)
    if (!r.ok) return r
    return { ok: true, page: parseOpensPage(r.data?.searchPackNft, momentTypePrefix, custodian) }
  }
}

export const GOLAZOS_NFT_QUERY =
  `query($i: SearchGolazosNftsInput!){ searchGolazosNft(searchInput:$i){ totalCount edges{ node{ id serial_number edition{ id } } } } }`

/** Name pulled NFTs by edition, 100 ids per request. An id the index does not return stays unnamed (edition NULL). */
export async function nameGolazosPulls(
  rows: PackOpenRow[],
  headers: Record<string, string>,
): Promise<{ pulls: PullRow[]; error: string | null }> {
  const byNft = new Map<string, string>()
  for (const r of rows) for (const id of r.nft_ids) byNft.set(id, r.pack_nft_id)
  const ids = Array.from(byNft.keys())
  const named = new Map<string, { edition: string | null; serial: number | null }>()
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const r = await studioGql(GOLAZOS_NFT_QUERY, { i: { first: 100, filters: [{ id: { in: slice } }] } }, headers)
    if (!r.ok) return { pulls: [], error: r.error }
    for (const e of r.data?.searchGolazosNft?.edges ?? []) {
      const n = e?.node
      if (!n?.id) continue
      named.set(String(n.id), {
        edition: n.edition?.id != null ? String(n.edition.id) : null,
        serial: n.serial_number != null ? Number(n.serial_number) : null,
      })
    }
  }
  const pulls: PullRow[] = ids.map((id) => ({
    nft_id: id,
    pack_nft_id: byNft.get(id)!,
    edition_external_id: named.get(id)?.edition ?? null,
    serial_number: named.get(id)?.serial ?? null,
  }))
  return { pulls, error: null }
}
