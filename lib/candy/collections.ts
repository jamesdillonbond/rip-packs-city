// lib/candy/collections.ts
//
// Every Candy Metaplex Core collection RPC catalogues, read from `candy_collections`
// (filled daily from chain by candy_collections_discover_*; 401 collections on
// 2026-11-08). The registry sets in lib/chains/solana/candy-sets.ts stay authoritative
// for their own five; every other non-test collection is registered with the normalizer
// so a wallet read can catalogue and show its cards (unpriced until its market is indexed).
//
// A failed read registers nothing and is reported — the wallet read then counts those
// cards as "other Candy collectibles" instead of showing them, never as "holds nothing".

import { registerCandySets, type CandySet } from "@/lib/chains/solana/candy-sets"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const TTL_MS = 10 * 60_000
let cache: { at: number; sets: CandySet[] } | null = null

export interface CandyCollectionsLoad {
  sets: CandySet[]
  error: string | null
}

/** Load (cached 10 min) and register every non-test, non-registry Candy collection. */
export async function loadCandyCollections(db: Db, now = Date.now()): Promise<CandyCollectionsLoad> {
  if (cache && now - cache.at < TTL_MS) return { sets: cache.sets, error: null }
  try {
    const { data, error } = await db
      .from("candy_collections")
      .select("address,name,set_id,edition_prefix")
      .neq("kind", "test")
      .is("registry_key", null)
      .not("set_id", "is", null)
      .not("edition_prefix", "is", null)
      .order("address", { ascending: true })
      .limit(1000)
    if (error) return { sets: cache?.sets ?? [], error: error.message ?? String(error) }
    const sets: CandySet[] = ((data ?? []) as Array<{ address: string; name: string; set_id: string; edition_prefix: string }>).map((r) => ({
      key: r.edition_prefix,
      name: r.name,
      setId: r.set_id,
      collectionAddress: r.address,
      meSymbol: "",
      editionKeyPrefix: r.edition_prefix,
      writesPacks: false,
    }))
    registerCandySets(sets)
    cache = { at: now, sets }
    return { sets, error: null }
  } catch (e) {
    return { sets: cache?.sets ?? [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** Test hook. */
export function resetCandyCollectionsCache(): void {
  cache = null
}
