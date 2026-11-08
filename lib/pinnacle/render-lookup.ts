// lib/pinnacle/render-lookup.ts
//
// One lookup for "which pin (render_id) is this Pinnacle NFT?" (2026-11-08,
// handoff pinnacle-wmc-render-gap). Two readers needed it and each asked only
// Dapper's studio-platform search, which answers nothing for some pins: the
// wmc render-id lane found 972 unresolved pins every hour, resolved 0, and
// logged ok:true; sales rows sat render-less until that same search answered.
//
// Order:
//   1. RPC's own mint records — public.pinnacle_mint_events (nft_id → render_id),
//      written from the chain's PinNFTMinted events by ingest-pinnacle-mints.
//      Authoritative for every pin whose mint we indexed.
//   2. Dapper's search (searchPinnacleNft by id) — for pins our mint index has
//      not got (it has holes: 28 of 32 unresolved sales on 11-08 were absent).
// A failed mint-record read is reported, never read as "no match"; the search
// still runs for every id, so a read failure costs coverage, not correctness.

export type RenderHit = { render_id: string; serial: number | null; source: "mint_records" | "gql" }

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
const GQL_CHUNK = 250
const READ_CHUNK = 500

const QUERY = `
query RemapByIds($ids: [UInt64!]!) {
  searchPinnacleNft(searchInput: { first: 250, filters: [{ id: { in: $ids } }] }) {
    edges { node { id serial_number edition { render_id } } }
  }
}`

/** nft_id → render_id from pinnacle_mint_events. `error` set on a failed read (map then partial). */
export async function renderIdsFromMintRecords(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  nftIds: string[],
): Promise<{ map: Map<string, string>; error: string | null }> {
  const map = new Map<string, string>()
  const ids = [...new Set(nftIds.filter(Boolean).map(String))]
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await db
      .from("pinnacle_mint_events")
      .select("nft_id, render_id")
      .in("nft_id", ids.slice(i, i + READ_CHUNK))
      .not("render_id", "is", null)
    if (error) return { map, error: error.message ?? String(error) }
    for (const r of (data ?? []) as Array<{ nft_id: unknown; render_id: unknown }>) {
      if (typeof r.render_id === "string" && r.render_id) map.set(String(r.nft_id), r.render_id)
    }
  }
  return { map, error: null }
}

/** One Dapper search call for ≤ 250 ids. Throws on a transport / GraphQL error. */
export async function renderIdsFromGql(
  ids: string[],
  userAgent = "rip-packs-city/pinnacle-render-lookup",
): Promise<Array<{ id: string; serial: number | null; render_id: string | null }>> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://disneypinnacle.com", "User-Agent": userAgent },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}`)
  const json = (await res.json()) as {
    data?: { searchPinnacleNft?: { edges?: Array<{ node?: { id: string; serial_number: string | null; edition?: { render_id: string | null } } }> } }
    errors?: unknown[]
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error("GQL errors")
  return (json.data?.searchPinnacleNft?.edges ?? []).map((e) => ({
    id: e.node!.id,
    serial: e.node?.serial_number != null && Number(e.node.serial_number) > 0 ? Number(e.node.serial_number) : null,
    render_id: e.node?.edition?.render_id ?? null,
  }))
}

export type ResolveResult = {
  hits: Map<string, RenderHit>
  fromMintRecords: number
  fromGql: number
  /** ids neither source could name */
  unresolvable: string[]
  mintReadError: string | null
  gqlErrors: number
}

/** Mint records first, Dapper's search for the rest. Never throws. */
export async function resolvePinnacleRenderIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  nftIds: string[],
  opts: { gql?: typeof renderIdsFromGql; userAgent?: string } = {},
): Promise<ResolveResult> {
  const gql = opts.gql ?? renderIdsFromGql
  const ids = [...new Set(nftIds.filter(Boolean).map(String))]
  const hits = new Map<string, RenderHit>()
  let mintReadError: string | null = null
  try {
    const m = await renderIdsFromMintRecords(db, ids)
    mintReadError = m.error
    for (const [id, rid] of m.map) hits.set(id, { render_id: rid, serial: null, source: "mint_records" })
  } catch (e) {
    mintReadError = e instanceof Error ? e.message : String(e)
  }
  const fromMintRecords = hits.size

  let gqlErrors = 0
  const rest = ids.filter((id) => !hits.has(id))
  for (let i = 0; i < rest.length; i += GQL_CHUNK) {
    try {
      const nodes = await gql(rest.slice(i, i + GQL_CHUNK), opts.userAgent)
      for (const n of nodes) {
        if (n.render_id && !hits.has(String(n.id))) hits.set(String(n.id), { render_id: n.render_id, serial: n.serial, source: "gql" })
      }
    } catch {
      gqlErrors++
    }
  }
  return {
    hits,
    fromMintRecords,
    fromGql: hits.size - fromMintRecords,
    unresolvable: ids.filter((id) => !hits.has(id)),
    mintReadError,
    gqlErrors,
  }
}
