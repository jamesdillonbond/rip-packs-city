// lib/chains/flow/allday-edition-onchain.ts
//
// On-chain AllDay edition-resolution helpers, factored out of the
// allday-sales-indexer so the dedicated unmapped-sales resolver
// (/api/cron/allday-resolve-unmapped) can reuse the SAME proven path.
//
// Why on-chain (and not AllDay's marketplace GraphQL): nflallday.com's
// Cloudflare WAF now serves a "Blocked" challenge to Cloudflare-Worker and
// Supabase-edge egress (verified 2026-06-16), which silently broke the old
// consumer-GQL `searchMomentNFTsV2(byFlowIDs)` resolver. The chain is the
// canonical, WAF-proof source of truth: a moment's `editionID` is immutable
// and readable by borrowing the NFT from a current holder (the sale's buyer,
// recovered from the tx's AllDay.Deposit.to event). This is exactly how the
// wallet-backfill already populates wallet_moments_cache.edition_key.
//
// These run on Vercel egress (Flow REST is reachable there, unlike the
// AllDay GQL via worker), matching the healthy allday-fmv-populate path.

export const FLOW_REST = "https://rest-mainnet.onflow.org"
export const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
export const COLLECTION_SLUG = "nfl_all_day"
export const ALLDAY_DEPOSIT_EVENT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
export const ALLDAY_WITHDRAW_EVENT = "A.e4cf4bdc1751c65d.AllDay.Withdraw"

const SCRIPT_TIMEOUT_MS = 15_000

// Addresses that appear in every Flowty/Dapper purchase envelope but are never
// the buyer. Normalised to 0x + 16-hex-chars for set lookups.
export const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / seller
  "0x18eb4ee6b3c026d2", // Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
])

export function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex.padStart(16, "0")}`
}

// Cadence JSON-CDC unwrapper (mirrors the indexer / dapper-v1-tx-decode copy).
function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}

// AllDay-typed borrow: the public capability at /public/AllDayNFTCollection is
// published as a `&AllDay.Collection` (the contract's concrete collection
// resource). Borrowing the concrete type lets us call the AllDay-specific
// `borrowMomentNFT(id:)` accessor, which returns `&AllDay.NFT?` directly with
// editionID + serialNumber exposed. Returns nil if the wallet no longer holds
// the moment (re-sold since the sale) — handled as a retryable miss.
export const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(buyer: Address, id: UInt64): {String: String}? {
  let col = getAccount(buyer).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString(),
    "mintingDate": nft!.mintingDate.toString()
  }
}
`

export const GET_EDITION_DATA_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(editionID: UInt64): {String: String}? {
  let edOpt = AllDay.getEditionData(id: editionID)
  if edOpt == nil { return nil }
  let ed = edOpt!
  let result: {String: String} = {
    "playID": ed.playID.toString(),
    "setID": ed.setID.toString(),
    "tier": ed.tier ?? "COMMON",
    "maxMintSize": ed.maxMintSize?.toString() ?? "",
    "numMinted": ed.numMinted.toString()
  }
  let playOpt = AllDay.getPlayData(id: ed.playID)
  if playOpt != nil {
    let meta = playOpt!.metadata
    result["playerName"] = meta["playerFullName"] ?? meta["playerName"] ?? ""
    result["teamName"] = meta["teamName"] ?? ""
    result["playType"] = meta["playType"] ?? ""
    result["dateOfMoment"] = meta["dateOfMoment"] ?? ""
    result["awayTeamName"] = meta["awayTeamName"] ?? ""
    result["homeTeamName"] = meta["homeTeamName"] ?? ""
  }
  let setOpt = AllDay.getSetData(id: ed.setID)
  if setOpt != nil {
    result["setName"] = setOpt!.name
    result["seriesID"] = setOpt!.seriesID.toString()
    let seriesOpt = AllDay.getSeriesData(id: setOpt!.seriesID)
    if seriesOpt != nil {
      result["seriesName"] = seriesOpt!.name
    }
  }
  return result
}
`

export async function runAllDayScript(
  code: string,
  args: Array<{ type: string; value: unknown }>,
): Promise<unknown> {
  const body = {
    script: Buffer.from(code, "utf8").toString("base64"),
    arguments: args.map((a) => Buffer.from(JSON.stringify(a), "utf8").toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`script HTTP ${res.status}`)
  const json = (await res.json()) as { value?: string } | string
  let raw: string
  if (typeof json === "string") raw = json
  else raw = String(json.value ?? "")
  if (!raw) return null
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

// Recover buyer/proposer/payer candidates from a tx envelope, minus the known
// non-buyer escrow/fee addresses. Used when the unmapped row has no
// buyer_address and decodeV1SaleTx couldn't pin AllDay.Deposit.to.
export async function fetchTxBuyers(txId: string): Promise<string[]> {
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      proposal_key?: { address?: string }
      authorizers?: string[]
      payer?: string
    }
    const candidates = new Set<string>()
    if (json.proposal_key?.address) candidates.add(normalizeAddress(json.proposal_key.address))
    for (const a of json.authorizers ?? []) candidates.add(normalizeAddress(a))
    if (json.payer) candidates.add(normalizeAddress(json.payer))
    return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a))
  } catch {
    return []
  }
}

function normalizeTier(raw: string | undefined | null): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

// Build an `editions` upsert row from a GET_EDITION_DATA_SCRIPT result, so a
// just-resolved edition that the catalog never seeded exists before
// promote_unmapped_sales tries to join nft_edition_map → editions.
export function buildOnChainEditionRow(
  editionID: string,
  data: Record<string, string>,
  now: string,
): Record<string, unknown> {
  const playerName = (data.playerName ?? "").trim() || null
  const setName = (data.setName ?? "").trim() || null
  const teamName = (data.teamName ?? "").trim() || null
  const numMinted = Number(data.numMinted)
  const maxMint = Number(data.maxMintSize)
  const circulation = Number.isFinite(maxMint) && maxMint > 0
    ? maxMint
    : Number.isFinite(numMinted) && numMinted > 0
    ? numMinted
    : null
  const seriesID = Number(data.seriesID)
  const setIdOnchain = Number(data.setID)
  const playIdOnchain = Number(data.playID)
  const dateRaw = data.dateOfMoment ? String(data.dateOfMoment).slice(0, 10) : null
  const gameDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null
  const composedName =
    playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName

  return {
    external_id: editionID,
    collection_id: ALLDAY_COLLECTION_ID,
    collection: COLLECTION_SLUG,
    name: composedName,
    player_name: playerName,
    set_name: setName,
    team_name: teamName,
    tier: normalizeTier(data.tier),
    series: Number.isFinite(seriesID) && seriesID > 0 ? seriesID : null,
    circulation_count: circulation,
    set_id_onchain: Number.isFinite(setIdOnchain) ? setIdOnchain : null,
    play_id_onchain: Number.isFinite(playIdOnchain) ? playIdOnchain : null,
    play_type: (data.playType ?? "").trim() || null,
    game_date: gameDate,
    home_team: (data.homeTeamName ?? "").trim() || null,
    away_team: (data.awayTeamName ?? "").trim() || null,
    updated_at: now,
  }
}
