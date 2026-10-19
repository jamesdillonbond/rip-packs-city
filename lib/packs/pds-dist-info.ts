// lib/packs/pds-dist-info.ts
//
// Read one pack distribution's facts from Dapper's shared Pack Distribution
// Service contract (PDS at 0xb6f2481eba4df97b) through Flow REST.
//
// WHY (2026-10-19). Studio Platform's searchDistributions stopped listing new
// Disney Pinnacle distributions in August 2026, and the only Pinnacle writer of
// pack_distributions (the compute-pinnacle-pack-ev edge function) seeds from it,
// so the 10-09 "Star Wars Halloween Vol.1" drop (dist 8891, 414 opens) had no row.
// Every Dapper distribution is still registered with PDS. The Top Shot route
// (/api/cron/topshot-pack-dist-names-onchain) reads the same script; this module
// returns the FULL metadata map, because a Pinnacle row also needs the price,
// the uuid and the sale window, and the productID that proves it is a Disney
// distribution at all.
//
// Verified on mainnet 2026-10-19 ~9:00 AM PT through Flow REST (dists 8891, 8871,
// 8873: productID "disney", price "49.95" / "4.99", numberOfPackSlots "1").
// Re-verify against the deployed contract before changing the script.

export const PDS_DIST_INFO_SCRIPT = `
import PDS from 0xb6f2481eba4df97b
access(all) fun main(distId: UInt64): {String: String}? {
  if let info = PDS.getDistInfo(distId: distId) {
    var result: {String: String} = {"title": info.title, "state": info.state.rawValue.toString()}
    for key in info.metadata.keys { result["meta_".concat(key)] = info.metadata[key]! }
    return result
  }
  return nil
}
`

export interface PdsDistFacts {
  title: string
  productId: string | null
  tier: string | null
  numberOfPackSlots: number | null
  priceUsd: number | null
  uuid: string | null
  startTime: string | null
  endTime: string | null
  description: string | null
}

function finiteOrNull(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function textOrNull(raw: string | undefined): string | null {
  const t = (raw ?? "").trim()
  return t ? t : null
}

/**
 * Decode the script's JSON-Cadence `{String: String}?`. null = the chain has no
 * such distribution (or it carries no title). A shape surprise THROWS: a
 * surprise is a failure, not an absence.
 */
export function decodePdsDistFacts(decoded: unknown): PdsDistFacts | null {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Optional") throw new Error("script result is not a JSON-Cadence Optional")
  if (node.value == null) return null
  const dict = node.value as { type?: string; value?: unknown }
  if (dict.type !== "Dictionary" || !Array.isArray(dict.value)) throw new Error("script result is not a Dictionary")
  const map: Record<string, string> = {}
  for (const entry of dict.value as Array<{ key?: { value?: unknown }; value?: { value?: unknown } }>) {
    const k = entry?.key?.value
    const v = entry?.value?.value
    if (typeof k === "string" && typeof v === "string") map[k] = v
  }
  const title = (map.title ?? "").trim()
  if (!title) return null
  const slots = finiteOrNull(map.meta_numberOfPackSlots)
  const price = finiteOrNull(map.meta_price)
  // The chain carries marketing copy as HTML; the column is read as text.
  const description = map.meta_description
    ? map.meta_description.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    : null
  return {
    title,
    productId: textOrNull(map.meta_productID),
    tier: map.meta_tier ? map.meta_tier.trim().toLowerCase() || null : null,
    // 0 slots means "not set" on Dapper's side — stored as unknown, never 0.
    numberOfPackSlots: slots != null && slots > 0 ? slots : null,
    // A price of 0 is a reward/airdrop with no retail price; keep it as stated.
    priceUsd: price != null && price >= 0 ? price : null,
    uuid: textOrNull(map.meta_distributionUUID),
    startTime: textOrNull(map.meta_startTime),
    endTime: textOrNull(map.meta_endTime),
    description: description || null,
  }
}

/** One PDS script call. Throws on any transport or shape failure. */
export async function readPdsDistFacts(
  distId: string,
  opts: { flowRest?: string; timeoutMs?: number } = {},
): Promise<PdsDistFacts | null> {
  const flowRest = opts.flowRest ?? process.env.FLOW_REST_URL ?? "https://rest-mainnet.onflow.org"
  const body = {
    script: Buffer.from(PDS_DIST_INFO_SCRIPT, "utf8").toString("base64"),
    arguments: [Buffer.from(JSON.stringify({ type: "UInt64", value: String(distId) }), "utf8").toString("base64")],
  }
  const res = await fetch(`${flowRest}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200).replace(/\s+/g, " ")).catch(() => "")
    throw new Error(`Flow REST HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`)
  }
  const json = (await res.json()) as { value?: string } | string
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) throw new Error("Flow REST returned an empty script result")
  const decoded = JSON.parse(Buffer.from(raw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8"))
  return decodePdsDistFacts(decoded)
}

/**
 * Merge the chain's facts into a Pinnacle row's metadata, FILL-ONLY: a key
 * another writer set (compute-pinnacle-pack-ev, a hand seed) is never
 * overwritten. Keys follow the Pinnacle row shape (retail_price_usd in dollars).
 */
export function mergePinnacleDistMetadata(existing: Record<string, unknown> | null, f: PdsDistFacts): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) }
  const fill = (key: string, value: unknown) => {
    if (out[key] == null && value != null) out[key] = value
  }
  fill("tier", f.tier)
  fill("number_of_pack_slots", f.numberOfPackSlots)
  fill("retail_price_usd", f.priceUsd)
  fill("uuid", f.uuid)
  fill("start_time", f.startTime)
  fill("end_time", f.endTime)
  fill("description", f.description)
  fill("source", "pds_contract")
  return out
}
