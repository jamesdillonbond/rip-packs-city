// lib/candy/edition-key-aliases.ts
//
// #247 (2026-11-13): one Candy card was stored under several edition keys — the on-chain name is cut at 32
// characters and the cut moves with the serial's digit count, a card hydrated from its off-chain JSON keys from
// the full title, and older paths slugged punctuation differently. `candy_edition_key_aliases` maps each extra
// key to the card's canonical key (refresh_candy_edition_key_aliases, daily), and DB triggers rewrite every
// write that names an alias. The census resolves aliases HERE as well, before it compares a card's computed key
// with the key its holding already has: otherwise every walk would "repoint" each card back to the alias (the
// trigger then rewrites it again) — no data harm, but a repoint + listings/offers RPC per card per walk.
//
// Three answers, never two: a map (possibly empty) · the read failed (error — the caller fails the collection,
// it does not walk without the map). A read at the row cap is a failure (it may be partial).

export type AliasLabels = {
  external_id: string
  tier: string | null
  player_name: string | null
  team_name: string | null
  set_name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  video_url?: string | null
  rarity_label?: string | null
}

export type EditionKeyAliases = {
  /** alias key -> canonical key, only where the canonical edition's labels were read */
  canonOf: Map<string, string>
  /** canonical key -> its edition labels */
  labels: Map<string, AliasLabels>
}

const CANDY_MLB_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
const ROW_CAP = 1000
const LABEL_COLS = "external_id,tier,player_name,team_name,set_name,circulation_count,thumbnail_url,video_url,rarity_label"
const IN_CHUNK = 150

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const NO_ALIASES: EditionKeyAliases = { canonOf: new Map(), labels: new Map() }

export async function loadEditionKeyAliases(db: Db, collectionPrefix: string): Promise<{ aliases: EditionKeyAliases; error: string | null }> {
  const { data, error } = await db.from("candy_edition_key_aliases")
    .select("alias_key,canonical_key")
    .eq("collection_prefix", collectionPrefix)
    .limit(ROW_CAP)
  if (error) return { aliases: NO_ALIASES, error: `edition key aliases read: ${error.message}` }
  const rows = (data ?? []) as Array<{ alias_key: string; canonical_key: string }>
  if (rows.length >= ROW_CAP) return { aliases: NO_ALIASES, error: `edition key aliases read: ${ROW_CAP}-row cap reached` }
  if (!rows.length) return { aliases: NO_ALIASES, error: null }

  const canonKeys = [...new Set(rows.map((r) => r.canonical_key))]
  const labels = new Map<string, AliasLabels>()
  for (let i = 0; i < canonKeys.length; i += IN_CHUNK) {
    const { data: eds, error: eErr } = await db.from("editions")
      .select(LABEL_COLS)
      .eq("collection_id", CANDY_MLB_UUID)
      .in("external_id", canonKeys.slice(i, i + IN_CHUNK))
    if (eErr) return { aliases: NO_ALIASES, error: `canonical editions read: ${eErr.message}` }
    for (const e of (eds ?? []) as AliasLabels[]) labels.set(e.external_id, e)
  }
  const canonOf = new Map<string, string>()
  // an alias whose canonical edition is missing is left alone (the card keeps its computed key)
  for (const r of rows) if (labels.has(r.canonical_key)) canonOf.set(r.alias_key, r.canonical_key)
  return { aliases: { canonOf, labels }, error: null }
}

/**
 * The canonical key for ONE Candy edition key, or null when it is not an alias. For writers that look an edition
 * up by key (the sales indexers): an alias edition row is deleted once its card has moved (#247), so a miss on the
 * key must try its canonical before calling the edition "not ingested". A failed read THROWS — the caller treats
 * it like its own failed editions read, never as "no such edition".
 */
export async function canonicalCandyEditionKey(db: Db, key: string): Promise<string | null> {
  const { data, error } = await db.from("candy_edition_key_aliases")
    .select("canonical_key")
    .eq("alias_key", key)
    .limit(1)
  if (error) throw new Error(`edition key aliases read failed for ${key}: ${error.message}`)
  const canon = (data as Array<{ canonical_key?: unknown }> | null)?.[0]?.canonical_key
  return typeof canon === "string" && canon && canon !== key ? canon : null
}
