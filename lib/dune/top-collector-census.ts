// lib/dune/top-collector-census.ts
//
// The FULL holder census behind the Top Collector Leaderboard (Trevor, 2026-11-27: "We need to have
// this for every possible wallet, not just the ones we've captured. I don't think I should be the top
// collector for blazers").
//
// RPC's own owner sources only see the wallets it walks (Top Shot: 12,063 owners of ~50.5M minted
// Moments on 11-27). Dune's flow.cadence_events holds every Flow event since 2020, so the census is:
//
//   current owner of every NFT = the latest Deposit (contract `<C>.Deposit` or the Cadence 1.0
//   standard `NonFungibleToken.Deposited` for `<C>.NFT`), unless a later Withdraw / burn / destroy
//   leaves it in nobody's collection.
//
// Everything is ranked INSIDE Dune, so only the leaderboard rows come back (export is billed per MB):
//   1. The route uploads RPC's edition map as a public Dune table, `dataset_rpc_census_map_<key>`:
//      (ek, kind, key, fmv, circ, jersey) — the edition key as the mint event spells it, each entity it
//      belongs to (player = players.id or 'name:'<name>, team = slug of team_name; Pinnacle: character
//      and franchise), its current FMV, mint count and jersey number. Rows with kind='exclude' carry
//      the system accounts (flowty_excluded_addresses) — not collectors.
//   2. The saved per-collection Dune query (SQL below, built by censusSql) joins current owners to that
//      map and returns, per entity, the top TOP_N owners by count, by FMV and by special serials
//      (#1, perfect = serial equals the mint count, jersey match — each NFT counted once), with the
//      entity's holder / item totals on every row.
//   3. The route pages the result into entity_top_fans_census_stage and finalize_top_collector_census
//      swaps it in (source 'dune_census'), which is what flips the page from "waiting" to a ranking.
//
// ⛔ The SQL here and the query saved on Dune must stay identical — the saved query id is what runs.
// After editing censusSql, update the Dune query (scripts/print-top-collector-census-sql.mjs prints it).

export type CensusKey = "topshot" | "allday" | "golazos" | "pinnacle"

export interface CensusConfig {
  key: CensusKey
  urlSlug: string
  collectionId: string
  /** Contract address (no 0x) + name, e.g. 0b2a3299cc857e29 / TopShot. */
  address: string
  contract: string
  /** First block_date worth scanning (contract launch). */
  startDate: string
  mintEvent: string
  /** Field in the mint event that is the NFT id. */
  mintIdField: string
  /** Contract-specific events after which the NFT is in nobody's collection. */
  burnEvents: string[]
  /** Saved Dune query id (env override TOP_COLLECTOR_CENSUS_QUERY_<KEY>). */
  queryId: string | null
}

export const TOP_N = 15
export const DUNE_NAMESPACE = "rip_packs_city"
const NFT_STANDARD = "A.1d7e57aa55817448.NonFungibleToken"

export const CENSUS_CONFIGS: Record<CensusKey, CensusConfig> = {
  topshot: {
    key: "topshot",
    urlSlug: "nba-top-shot",
    collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    address: "0b2a3299cc857e29",
    contract: "TopShot",
    startDate: "2020-10-01",
    mintEvent: "MomentMinted",
    mintIdField: "momentID",
    burnEvents: ["MomentDestroyed"],
    queryId: "9205180",
  },
  allday: {
    key: "allday",
    urlSlug: "nfl-all-day",
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    address: "e4cf4bdc1751c65d",
    contract: "AllDay",
    startDate: "2021-09-01",
    mintEvent: "MomentNFTMinted",
    mintIdField: "id",
    burnEvents: ["MomentNFTBurned"],
    queryId: "9205183",
  },
  golazos: {
    key: "golazos",
    urlSlug: "laliga-golazos",
    collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
    address: "87ca73a41bb50ad5",
    contract: "Golazos",
    startDate: "2022-01-01",
    mintEvent: "MomentNFTMinted",
    mintIdField: "id",
    burnEvents: ["MomentNFTBurned"],
    queryId: "9205184",
  },
  pinnacle: {
    key: "pinnacle",
    urlSlug: "disney-pinnacle",
    collectionId: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
    address: "edf9df96c92f4595",
    contract: "Pinnacle",
    startDate: "2024-01-01",
    mintEvent: "PinNFTMinted",
    mintIdField: "id",
    burnEvents: ["OpenEditionNFTBurned"],
    queryId: "9205185",
  },
}

export function censusConfigBySlug(urlSlug: string): CensusConfig | null {
  return Object.values(CENSUS_CONFIGS).find((c) => c.urlSlug === urlSlug) ?? null
}

export function censusQueryId(cfg: CensusConfig, env: Record<string, string | undefined> = process.env): string | null {
  const v = env[`TOP_COLLECTOR_CENSUS_QUERY_${cfg.key.toUpperCase()}`] ?? cfg.queryId
  return v && /^\d+$/.test(v) ? v : null
}

export function mapTableName(cfg: CensusConfig): string {
  return `rpc_census_map_${cfg.key}`
}

/** The edition key as the mint event spells it — must equal top_collector_census_map's ek. */
function ekExpr(cfg: CensusConfig): string {
  switch (cfg.key) {
    case "topshot":
      // set:play:subedition (0 = Standard). Older mints carry no subeditionID; a later
      // SubeditionAddedToMoment assigns one (joined in `held`).
      return "concat(json_extract_scalar(data, '$.setID'), ':', json_extract_scalar(data, '$.playID'))"
    case "pinnacle":
      return "json_extract_scalar(data, '$.renderID')"
    default:
      return "json_extract_scalar(data, '$.editionID')"
  }
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function censusSql(cfg: CensusConfig): string {
  const A = `A.${cfg.address}.${cfg.contract}`
  const nftType = `${A}.NFT`
  const mint = `${A}.${cfg.mintEvent}`
  const deposit = `${A}.Deposit`
  const withdraw = `${A}.Withdraw`
  const burns = [...cfg.burnEvents.map((e) => `${A}.${e}`), `${nftType}.ResourceDestroyed`]
  const subadd = `${A}.SubeditionAddedToMoment`
  const topics = [mint, deposit, withdraw, ...burns, `${NFT_STANDARD}.Deposited`, `${NFT_STANDARD}.Withdrawn`]
  if (cfg.key === "topshot") topics.push(subadd)
  const isTs = cfg.key === "topshot"
  const table = `dune.${DUNE_NAMESPACE}.dataset_${mapTableName(cfg)}`

  return `-- RPC Top Collector census — ${cfg.contract} (generated by lib/dune/top-collector-census.ts; keep identical)
-- Current owner of every ${cfg.contract} NFT from the full event history, joined to RPC's uploaded edition
-- map, ranked per entity (player / team) by count, FMV and special serials. Top ${TOP_N} per metric.
WITH map AS (
  SELECT CAST(ek AS varchar) AS ek, CAST(kind AS varchar) AS kind, CAST(key AS varchar) AS key,
         TRY_CAST(fmv AS double) AS fmv, TRY_CAST(circ AS bigint) AS circ, TRY_CAST(jersey AS bigint) AS jersey
    FROM ${table}
),
ents AS (SELECT ek, kind, key FROM map WHERE kind IN ('player', 'team')),
ek_info AS (SELECT ek, max(fmv) AS fmv, max(circ) AS circ, max(jersey) AS jersey FROM map WHERE kind IN ('player', 'team') GROUP BY ek),
excl AS (SELECT DISTINCT lower(key) AS addr FROM map WHERE kind = 'exclude'),
raw AS (
  SELECT topics[1] AS topic, data, block_height, log_index
    FROM flow.cadence_events
   WHERE block_date >= DATE ${lit(cfg.startDate)}
     AND cardinality(topics) > 0
     AND topics[1] IN (${topics.map(lit).join(", ")})
),
mint AS (
  SELECT CAST(json_extract_scalar(data, '$.${cfg.mintIdField}') AS bigint) AS id,
         ${ekExpr(cfg)} AS ek,
         TRY_CAST(json_extract_scalar(data, '$.serialNumber') AS bigint) AS serial${isTs ? `,
         TRY_CAST(json_extract_scalar(data, '$.subeditionID') AS bigint) AS sub` : ""}
    FROM raw WHERE topic = ${lit(mint)}
),${isTs ? `
subadd AS (
  SELECT CAST(json_extract_scalar(data, '$.momentID') AS bigint) AS id,
         max(TRY_CAST(json_extract_scalar(data, '$.subeditionID') AS bigint)) AS sub
    FROM raw WHERE topic = ${lit(subadd)} GROUP BY 1
),` : ""}
moves AS (
  SELECT CAST(json_extract_scalar(data, '$.id') AS bigint) AS id, lower(json_extract_scalar(data, '$.to')) AS owner, block_height, log_index
    FROM raw WHERE topic = ${lit(deposit)}
  UNION ALL
  SELECT CAST(json_extract_scalar(data, '$.id') AS bigint), lower(json_extract_scalar(data, '$.to')), block_height, log_index
    FROM raw WHERE topic = ${lit(`${NFT_STANDARD}.Deposited`)} AND json_extract_scalar(data, '$.type') = ${lit(nftType)}
  UNION ALL
  SELECT CAST(json_extract_scalar(data, '$.id') AS bigint), CAST(NULL AS varchar), block_height, log_index
    FROM raw WHERE topic IN (${[withdraw, ...burns].map(lit).join(", ")})
  UNION ALL
  SELECT CAST(json_extract_scalar(data, '$.id') AS bigint), CAST(NULL AS varchar), block_height, log_index
    FROM raw WHERE topic = ${lit(`${NFT_STANDARD}.Withdrawn`)} AND json_extract_scalar(data, '$.type') = ${lit(nftType)}
),
cur AS (
  SELECT id, owner FROM (
    SELECT id, owner, row_number() OVER (PARTITION BY id ORDER BY block_height DESC, log_index DESC, owner NULLS LAST) AS rn FROM moves
  ) t WHERE rn = 1 AND owner IS NOT NULL
),
held AS (
  SELECT c.owner, ${isTs ? "concat(m.ek, ':', CAST(coalesce(m.sub, s.sub, 0) AS varchar))" : "m.ek"} AS ek, m.serial
    FROM cur c
    JOIN mint m ON m.id = c.id${isTs ? `
    LEFT JOIN subadd s ON s.id = c.id` : ""}
   WHERE c.owner NOT IN (SELECT addr FROM excl)
),
per AS (
  SELECT e.kind, e.key, h.owner,
         count(*) AS items,
         count_if(h.serial = 1 OR h.serial = i.circ OR h.serial = i.jersey) AS special_items,
         sum(i.fmv) AS fmv_usd,
         count_if(i.fmv > 0) AS fmv_items
    FROM held h
    JOIN ents e ON e.ek = h.ek
    JOIN ek_info i ON i.ek = h.ek
   GROUP BY 1, 2, 3
),
ranked AS (
  SELECT p.*,
         row_number() OVER (PARTITION BY kind, key ORDER BY items DESC, fmv_usd DESC NULLS LAST, owner) AS r_i,
         row_number() OVER (PARTITION BY kind, key ORDER BY fmv_usd DESC NULLS LAST, items DESC, owner) AS r_f,
         row_number() OVER (PARTITION BY kind, key ORDER BY special_items DESC, fmv_usd DESC NULLS LAST, owner) AS r_s,
         count(*) OVER (PARTITION BY kind, key) AS holders,
         sum(items) OVER (PARTITION BY kind, key) AS entity_items,
         sum(special_items) OVER (PARTITION BY kind, key) AS entity_special
    FROM per p
)
SELECT kind AS entity_kind, key AS entity_key, owner, items, special_items, round(fmv_usd, 2) AS fmv_usd, fmv_items,
       holders, entity_items, entity_special
  FROM ranked
 WHERE r_i <= ${TOP_N} OR r_f <= ${TOP_N} OR (r_s <= ${TOP_N} AND special_items > 0)
 ORDER BY entity_kind, entity_key, owner
`
}

export interface CensusRow {
  entity_kind: string
  entity_key: string
  owner: string
  items: number
  special_items: number
  fmv_usd: number | null
  fmv_items: number
  holders: number
  entity_items: number
  entity_special: number
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** A Dune result row → stage row, or null when it cannot be keyed (counted as skipped, never written). */
export function normalizeCensusRow(raw: Record<string, unknown>): CensusRow | null {
  const kind = typeof raw.entity_kind === "string" ? raw.entity_kind : null
  const key = raw.entity_key == null ? null : String(raw.entity_key)
  const owner = typeof raw.owner === "string" ? raw.owner.toLowerCase() : null
  const items = n(raw.items)
  if (!kind || !["player", "team"].includes(kind) || !key || !owner || !/^0x[0-9a-f]{16}$/.test(owner) || items == null) return null
  return {
    entity_kind: kind,
    entity_key: key,
    owner,
    items,
    special_items: n(raw.special_items) ?? 0,
    fmv_usd: n(raw.fmv_usd),
    fmv_items: n(raw.fmv_items) ?? 0,
    holders: n(raw.holders) ?? 0,
    entity_items: n(raw.entity_items) ?? 0,
    entity_special: n(raw.entity_special) ?? 0,
  }
}
