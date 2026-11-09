// lib/chains/solana/hydrate.ts
//
// DAS sometimes returns a Candy asset WITHOUT its off-chain JSON: the on-chain name is there,
// but content.metadata.attributes is empty and there is no image link. Normalized as-is, such
// an asset yields an edition keyed from the name alone (no rarity suffix, no player, no tier,
// no image) — a FABRICATED edition. Measured 2026-11-09: 4,844 such editions held by 328,317
// cards in 9,114 wallets; Magic Eden showed every field for the sampled card
// (c:2022-leadoff-icons:phil-bickford -> "Phil Bickford (376/850)", image, team, traits).
//
// The asset's own metadata file (content.json_uri, stored on-chain for a Metaplex Core asset)
// carries the same JSON Magic Eden reads. hydrateFromJsonUri() fetches it and merges it into
// the DAS shape the normalizer reads. A fetch that fails or returns no usable JSON leaves the
// asset UNHYDRATED and reports it — the caller must not write it under a name-only key.

import type { DasAsset } from "@/lib/chains/solana/das"

/** No traits and no image: DAS did not load this asset's off-chain JSON. */
export function isUnhydrated(asset: DasAsset): boolean {
  const attrs = asset.content?.metadata?.attributes
  const hasAttrs = Array.isArray(attrs) && attrs.length > 0
  const hasImage = Boolean(asset.content?.links?.image) || (asset.content?.files?.length ?? 0) > 0
  return !hasAttrs && !hasImage
}

interface OffChainJson {
  name?: unknown
  image?: unknown
  animation_url?: unknown
  external_url?: unknown
  attributes?: unknown
  properties?: { files?: unknown }
}

/** Merge an asset's off-chain JSON into its DAS content. Returns null when the JSON is unusable. */
export function mergeOffChainJson(asset: DasAsset, json: unknown): DasAsset | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const j = json as OffChainJson
  const attributes = Array.isArray(j.attributes)
    ? (j.attributes as Array<Record<string, unknown>>)
        .filter((a) => a && typeof a === "object" && a.trait_type != null)
        .map((a) => ({ trait_type: String(a.trait_type), value: a.value }))
    : []
  const image = typeof j.image === "string" && j.image ? j.image : undefined
  const files = Array.isArray(j.properties?.files)
    ? (j.properties!.files as Array<Record<string, unknown>>)
        .filter((f) => f && typeof f.uri === "string")
        .map((f) => ({ uri: f.uri as string, mime: typeof f.type === "string" ? f.type : undefined }))
    : []
  const merged: DasAsset = {
    ...asset,
    content: {
      ...asset.content,
      metadata: {
        ...asset.content?.metadata,
        name: asset.content?.metadata?.name || (typeof j.name === "string" ? j.name : undefined),
        attributes,
      },
      links: {
        ...asset.content?.links,
        image,
        animation_url: typeof j.animation_url === "string" && j.animation_url ? j.animation_url : asset.content?.links?.animation_url,
        external_url: typeof j.external_url === "string" ? j.external_url : asset.content?.links?.external_url,
      },
      files: files.length ? files : asset.content?.files,
    },
  }
  return isUnhydrated(merged) ? null : merged
}

export interface HydrateResult {
  hydrated: DasAsset[]
  failed: Array<{ id: string; reason: string }>
}

// The same Arweave transaction is served by Candy's gateway and by arweave.net (verified
// 2026-11-09: both answered 20/20 concurrent reads for one card). A failure on one is retried
// on the other.
const GATEWAYS = ["https://permaweb.candy.io/", "https://arweave.net/"]
export function gatewayAlternates(uri: string): string[] {
  for (const g of GATEWAYS) {
    if (uri.startsWith(g)) {
      const tx = uri.slice(g.length)
      return [uri, ...GATEWAYS.filter((o) => o !== g).map((o) => o + tx)]
    }
  }
  return [uri]
}

/** A short, stable class for a failure, so a run can report WHY in a histogram. */
export function failureClass(reason: string): string {
  if (/^HTTP \d+/.test(reason)) return reason.slice(0, 8)
  if (/timeout|aborted/i.test(reason)) return "timeout"
  if (/json carried no/.test(reason)) return "no traits or image"
  if (/no https json_uri/.test(reason)) return "no https json_uri"
  if (/JSON|Unexpected token/i.test(reason)) return "not json"
  return reason.slice(0, 40)
}

// Every card of an edition carries the same off-chain JSON except its name and serial
// ("Phil Bickford (376/850)" vs "(377/850)"). One fetch per edition GROUP — (collection,
// base name, edition size) — is applied to every card in the group with that card's own name
// and serial. Measured 2026-11-09 8:57 AM PT: fetching one file per card ran ~7/s and the
// census read 15 pages in 10 min (vs ~300); grouping cuts the fetches by ~the edition size.
// A card whose name carries no "(n/m)" is its own group (fetched alone, never guessed).
const SERIAL_IN_NAME = /^(.*?)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/

export function editionGroupKey(asset: DasAsset): string {
  const name = asset.content?.metadata?.name ?? ""
  const m = name.match(SERIAL_IN_NAME)
  const coll = asset.grouping?.find((g) => g.group_key === "collection")?.group_value ?? ""
  return m ? `${coll}|${m[1].trim().toLowerCase()}|${m[3]}` : `solo|${asset.id}`
}

/** The group's JSON, re-addressed to one member: its own name and serial. */
export function jsonForMember(json: Record<string, unknown>, member: DasAsset): Record<string, unknown> | null {
  const name = member.content?.metadata?.name ?? ""
  const m = name.match(SERIAL_IN_NAME)
  if (!m) return null
  const serial = Number(m[2])
  const size = m[3]
  const attrs = Array.isArray(json.attributes) ? (json.attributes as Array<Record<string, unknown>>) : []
  return {
    ...json,
    name,
    serial_number: serial,
    attributes: attrs.map((a) => {
      const t = String(a?.trait_type ?? "")
      if (t === "Serial Number") return { ...a, value: `${serial}/${size}` }
      if (t === "serial_number") return { ...a, value: serial }
      return a
    }),
  }
}

/**
 * Fetch each edition GROUP's content.json_uri once (https only; the other Arweave gateway on
 * failure; a second member tried as representative if the first fails) and merge it into every
 * member. Bounded concurrency and a per-request timeout; never throws. `fetches` counts HTTP
 * requests made. Order of `hydrated` is not significant.
 */
export async function hydrateFromJsonUri(
  assets: DasAsset[],
  opts: { concurrency?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HydrateResult & { fetches: number; groups: number }> {
  const concurrency = Math.max(1, opts.concurrency ?? 16)
  const timeoutMs = opts.timeoutMs ?? 8000
  const doFetch = opts.fetchImpl ?? fetch
  const out: HydrateResult & { fetches: number; groups: number } = { hydrated: [], failed: [], fetches: 0, groups: 0 }
  const groups = new Map<string, DasAsset[]>()
  for (const a of assets) {
    const k = editionGroupKey(a)
    const g = groups.get(k)
    if (g) g.push(a)
    else groups.set(k, [a])
  }
  out.groups = groups.size
  const queue = [...groups.values()]
  let next = 0

  async function fetchJson(a: DasAsset): Promise<{ json: Record<string, unknown> | null; reason: string }> {
    const uri = a.content?.json_uri
    if (typeof uri !== "string" || !/^https:\/\//i.test(uri)) return { json: null, reason: "no https json_uri" }
    let reason = "no attempt"
    for (const url of gatewayAlternates(uri)) {
      out.fetches++
      try {
        const resp = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!resp.ok) { reason = `HTTP ${resp.status}`; continue }
        const parsed = JSON.parse(await resp.text())
        if (mergeOffChainJson(a, parsed)) return { json: parsed as Record<string, unknown>, reason: "" }
        reason = "json carried no traits or image"
      } catch (e) {
        reason = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120)
      }
    }
    return { json: null, reason }
  }

  async function worker() {
    while (next < queue.length) {
      const members = queue[next++]
      let got: { json: Record<string, unknown> | null; reason: string } = { json: null, reason: "no attempt" }
      let rep: DasAsset | null = null
      for (const candidate of members.slice(0, 2)) {
        got = await fetchJson(candidate)
        if (got.json) { rep = candidate; break }
      }
      for (const a of members) {
        if (!got.json || !rep) { out.failed.push({ id: a.id, reason: got.reason }); continue }
        const merged = a === rep ? mergeOffChainJson(a, got.json) : (() => {
          const j = jsonForMember(got.json!, a)
          return j ? mergeOffChainJson(a, j) : null
        })()
        if (merged) out.hydrated.push(merged)
        else out.failed.push({ id: a.id, reason: "could not re-address group json" })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return out
}
