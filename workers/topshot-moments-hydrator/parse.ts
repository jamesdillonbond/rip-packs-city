// Pure parse/resolve helpers for the topshot-moments-hydrator worker, extracted
// so they can be unit-tested (the worker itself needs a Cloudflare runtime +
// Supabase + the topshot-proxy binding). These are the correctness core of the
// hydrator: the aliased GraphQL query builder, the per-alias response parser
// (the "partial gql-field error" handling that is the recurring
// GetMintedMoment-error class), the resolvable-moment filter, the edition-key
// dedupe used to build the batched editions lookup, and the ok-flag policy.
//
// index.ts imports these; keep them pure (no network / no Supabase) so the tests
// in __tests__/worker-moments-hydrator-parse.test.ts can drive them directly.

export interface Candidate {
  nft_id: string
  owner_address: string | null
  source_pack_rip_id: string | null
}

export interface GqlMoment {
  nft_id: string
  flowSerialNumber: number | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  owner_address: string | null
}

/** One aliased getMintedMoment result block. */
type AliasNode =
  | { flowSerialNumber?: unknown; play?: { flowID?: unknown } | null; set?: { flowId?: unknown } | null }
  | null

export interface GqlJson {
  data?: Record<string, { data?: AliasNode } | null | undefined>
  errors?: unknown[]
}

/** Coerce a GraphQL scalar to a non-negative integer, or null. */
export function parseIntOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

// Build one aliased getMintedMoment lookup per id — the fan-in that turns N
// single-id lookups into one POST body. `... on MintedMoment` + the Play/Set
// fragments mirror the production sales-indexer caller.
export function buildAliasedQuery(count: number): string {
  const varDecls: string[] = []
  const aliases: string[] = []
  for (let i = 0; i < count; i++) {
    varDecls.push(`$id${i}: ID!`)
    aliases.push(
      `m${i}: getMintedMoment(momentId: $id${i}) {
        data {
          ... on MintedMoment {
            flowSerialNumber
            play { ... on Play { flowID } }
            set { ... on Set { flowId } }
          }
        }
      }`,
    )
  }
  return `query Hydrate(${varDecls.join(", ")}) {\n${aliases.join("\n")}\n}`
}

// A burned/retired/unknown moment nulls ONLY its own alias in json.data and adds
// one entry to json.errors; the other aliases still return valid data. This
// returns a telemetry string for those partial errors (or null when clean) —
// callers must STILL parse json.data (via parseMoments), never discard the chunk.
export function extractPartialErrorMsg(json: GqlJson): string | null {
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const detail = json.errors
      .map((e) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "?"))
      .join("; ")
      .slice(0, 300)
    return `gql errors: ${detail}`
  }
  return null
}

// Map the aliased GQL response back onto the chunk order. An unresolved alias
// (null node) yields a GqlMoment with null ids that falls through the
// isResolvable filter downstream (counted as a graphql_failure, never lost).
export function parseMoments(chunk: Candidate[], json: GqlJson): GqlMoment[] {
  const moments: GqlMoment[] = []
  for (let i = 0; i < chunk.length; i++) {
    const node = json.data?.[`m${i}`]?.data ?? null
    if (!node) {
      moments.push({
        nft_id: chunk[i].nft_id,
        flowSerialNumber: null,
        set_id_onchain: null,
        play_id_onchain: null,
        owner_address: chunk[i].owner_address,
      })
      continue
    }
    moments.push({
      nft_id: chunk[i].nft_id,
      flowSerialNumber: parseIntOrNull(node.flowSerialNumber),
      set_id_onchain: parseIntOrNull(node.set?.flowId),
      play_id_onchain: parseIntOrNull(node.play?.flowID),
      owner_address: chunk[i].owner_address,
    })
  }
  return moments
}

// A moment is resolvable only with a positive serial AND both on-chain ints —
// the pair the editions lookup keys on. A serial of 0 is a sentinel, never real.
export function isResolvable(m: GqlMoment): boolean {
  return (
    m.flowSerialNumber !== null &&
    m.flowSerialNumber > 0 &&
    m.set_id_onchain !== null &&
    m.play_id_onchain !== null
  )
}

/** Canonical `${set_id_onchain}:${play_id_onchain}` edition key. */
export function editionKey(setIdOnchain: number | string, playIdOnchain: number | string): string {
  return `${setIdOnchain}:${playIdOnchain}`
}

/** Dedupe (set,play) pairs by key — the same edition backs many moments. */
export function dedupePairs(
  pairs: Array<{ set_id_onchain: number; play_id_onchain: number }>,
): Array<{ set_id_onchain: number; play_id_onchain: number }> {
  const uniqByKey = new Map<string, { set_id_onchain: number; play_id_onchain: number }>()
  for (const p of pairs) uniqByKey.set(editionKey(p.set_id_onchain, p.play_id_onchain), p)
  return [...uniqByKey.values()]
}

// PostgREST .or() filter: one and(set.eq.X,play.eq.Y) term per DISTINCT pair.
export function buildEditionOrFilter(
  pairs: Array<{ set_id_onchain: number; play_id_onchain: number }>,
): string {
  return dedupePairs(pairs)
    .map((p) => `and(set_id_onchain.eq.${p.set_id_onchain},play_id_onchain.eq.${p.play_id_onchain})`)
    .join(",")
}

// ok-flag policy: a burned/retired/unknown moment (partial gql-field error) or
// normal catalog drift must NOT flag the pipeline red. Only a HARD chunk failure
// (HTTP/network/JSON parse — no data at all), or a write that produced 0 rows
// when we DID have resolvable rows, flips ok=false. resolvableCount===0 (nothing
// resolvable this run) is honest degraded operation, not a failure.
export function computeOk(hardChunkFailures: number, momentsWritten: number, resolvableCount: number): boolean {
  return hardChunkFailures === 0 && (momentsWritten > 0 || resolvableCount === 0)
}
