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
import { editionKeyFromAsset } from "@/lib/chains/solana/normalize"

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
// candy.permaweb.services is a third Candy gateway seen in on-chain URIs (2026-11-09); it is
// recognised (so a failure there falls back) but never chosen as an alternate.
const GATEWAYS = ["https://permaweb.candy.io/", "https://arweave.net/"]
const KNOWN_GATEWAYS = [...GATEWAYS, "https://candy.permaweb.services/"]
/**
 * The URI first, then the same transaction on the other gateways. With `rotate` odd, a URI on
 * one of the two main gateways is tried on the OTHER one first, so a batch splits its load
 * across both (2026-11-09: ~1 request per card for comic sets, so throughput is latency-bound).
 */
export function gatewayAlternates(uri: string, rotate = 0): string[] {
  for (const g of KNOWN_GATEWAYS) {
    if (uri.startsWith(g)) {
      const tx = uri.slice(g.length)
      const all = [uri, ...GATEWAYS.filter((o) => o !== g).map((o) => o + tx)]
      return rotate % 2 === 1 && GATEWAYS.includes(g) && all.length > 1 ? [all[1], all[0], ...all.slice(2)] : all
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

// Every card of an edition carries the same off-chain JSON except its name and serial. One
// fetch per edition GROUP is applied to every member with that member's own name and serial.
// Measured 2026-11-09: per-card fetching ran ~7/s (15 pages in 10 min vs ~300).
//
// DAS's name for these assets is the ON-CHAIN name, in two formats (run sample, 10:57 AM PT):
//   MLB  "Phil Bickford (376/850)"            -> base + edition size: the size separates rarities
//   DC   "Justice League vs Suicid 1 2292"    -> 32-char title + card number + trailing SERIAL;
//                                               nothing in the name says the rarity
// So a "(n/m)" group is trusted on the size, while a trailing-serial ("t:") group is VERIFIED:
// two members are fetched and must resolve to the same edition key before the rest share the
// JSON; if they disagree, every member is fetched alone. A name with neither shape is fetched
// alone (never guessed).
const SERIAL_IN_NAME = /^(.*?)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/
const TRAILING_SERIAL = /^(.*\S)\s+(\d+)\s*$/

function collectionOf(asset: DasAsset): string {
  return asset.grouping?.find((g) => g.group_key === "collection")?.group_value ?? ""
}

export function editionGroupKey(asset: DasAsset): string {
  const name = asset.content?.metadata?.name ?? ""
  const m = name.match(SERIAL_IN_NAME)
  if (m) return `${collectionOf(asset)}|${m[1].trim().toLowerCase()}|${m[3]}`
  const t = name.match(TRAILING_SERIAL)
  if (t) return `${collectionOf(asset)}|t:${t[1].trim().toLowerCase()}`
  return `solo|${asset.id}`
}

/** This member's own serial, from its name. */
function memberSerial(asset: DasAsset): number | null {
  const name = asset.content?.metadata?.name ?? ""
  const m = name.match(SERIAL_IN_NAME) ?? name.match(TRAILING_SERIAL)
  return m ? Number(m[2]) : null
}

/** The group's JSON, re-addressed to one member: its own name and serial (size kept from the JSON). */
export function jsonForMember(json: Record<string, unknown>, member: DasAsset): Record<string, unknown> | null {
  const name = member.content?.metadata?.name ?? ""
  const serial = memberSerial(member)
  if (serial == null) return null
  const attrs = Array.isArray(json.attributes) ? (json.attributes as Array<Record<string, unknown>>) : []
  const sizeFromName = name.match(SERIAL_IN_NAME)?.[3]
  const disp = attrs.find((a) => String(a?.trait_type ?? "") === "Serial Number")?.value
  const size = sizeFromName ?? (typeof disp === "string" && disp.includes("/") ? disp.split("/")[1].trim() : null)
  return {
    ...json,
    name,
    serial_number: serial,
    attributes: attrs.map((a) => {
      const k = String(a?.trait_type ?? "")
      if (k === "Serial Number") return { ...a, value: size ? `${serial}/${size}` : String(serial) }
      if (k === "serial_number") return { ...a, value: serial }
      return a
    }),
  }
}

/**
 * Fetch each edition GROUP's content.json_uri (https only; the other Arweave gateway on failure;
 * a second member if the first fails; trailing-serial groups verified on two members) and merge
 * it into every member. Bounded concurrency and a per-request timeout; never throws. `fetches`
 * counts HTTP requests made. Order of `hydrated` is not significant.
 */
export async function hydrateFromJsonUri(
  assets: DasAsset[],
  opts: { concurrency?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HydrateResult & { fetches: number; groups: number; unverified_groups: number }> {
  // 48 (was 16): throughput is latency-bound, not rate-limited — 68 HTTP 429 in 4,761 requests
  // on the 11:57 AM PT run — and the breaker still stops a run whose fetches mostly fail.
  const concurrency = Math.max(1, opts.concurrency ?? 48)
  let rotation = 0
  const timeoutMs = opts.timeoutMs ?? 8000
  const doFetch = opts.fetchImpl ?? fetch
  const out: HydrateResult & { fetches: number; groups: number; unverified_groups: number } = { hydrated: [], failed: [], fetches: 0, groups: 0, unverified_groups: 0 }
  const groups = new Map<string, DasAsset[]>()
  for (const a of assets) {
    const k = editionGroupKey(a)
    const g = groups.get(k)
    if (g) g.push(a)
    else groups.set(k, [a])
  }
  out.groups = groups.size
  const queue = [...groups.entries()]
  const deferred: DasAsset[] = []
  let next = 0

  async function fetchJson(a: DasAsset): Promise<{ json: Record<string, unknown> | null; reason: string }> {
    const uri = a.content?.json_uri
    if (typeof uri !== "string" || !/^https:\/\//i.test(uri)) return { json: null, reason: "no https json_uri" }
    let reason = "no attempt"
    for (const url of gatewayAlternates(uri, rotation++)) {
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

  async function alone(a: DasAsset) {
    const got = await fetchJson(a)
    const merged = got.json ? mergeOffChainJson(a, got.json) : null
    if (merged) out.hydrated.push(merged)
    else out.failed.push({ id: a.id, reason: got.reason || "merge failed" })
  }

  async function worker() {
    while (next < queue.length) {
      const [key, members] = queue[next++]
      if (members.length === 1) { await alone(members[0]); continue }
      // representative: the first member that answers (at most two tried)
      let rep: DasAsset | null = null
      let repJson: Record<string, unknown> | null = null
      let reason = "no attempt"
      for (const c of members.slice(0, 2)) {
        const got = await fetchJson(c)
        if (got.json) { rep = c; repJson = got.json; break }
        reason = got.reason
      }
      if (!rep || !repJson) { for (const a of members) out.failed.push({ id: a.id, reason }); continue }
      const done = new Set<DasAsset>([rep])
      const repMerged = mergeOffChainJson(rep, repJson)!
      out.hydrated.push(repMerged)
      if (key.includes("|t:")) {
        // VERIFY: a second member's own JSON must give the same edition key
        const check = members.find((m) => m !== rep)!
        done.add(check)
        const got = await fetchJson(check)
        const checkMerged = got.json ? mergeOffChainJson(check, got.json) : null
        if (checkMerged) out.hydrated.push(checkMerged)
        else out.failed.push({ id: check.id, reason: got.reason || "merge failed" })
        const reAddressed = checkMerged ? jsonForMember(repJson, check) : null
        const agree = checkMerged && reAddressed && editionKeyFromAsset(mergeOffChainJson(check, reAddressed)!) === editionKeyFromAsset(checkMerged)
          && editionKeyFromAsset(repMerged) === editionKeyFromAsset(checkMerged)
        if (!agree) {
          out.unverified_groups++
          // fetched alone in the PARALLEL second pass — not serially in this worker (2026-11-09
          // 12:57 PM PT: a few unverified comic groups of hundreds of cards each ran one-by-one in
          // one worker while 47 idled: 2 pages / 781 cards in 10 min)
          for (const a of members) if (!done.has(a)) deferred.push(a)
          continue
        }
      }
      for (const a of members) {
        if (done.has(a)) continue
        const j = jsonForMember(repJson, a)
        const merged = j ? mergeOffChainJson(a, j) : null
        if (merged) out.hydrated.push(merged)
        else out.failed.push({ id: a.id, reason: "could not re-address group json" })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  // second pass: members of unverified groups, each fetched alone, across the full pool
  let d = 0
  async function soloWorker() {
    while (d < deferred.length) await alone(deferred[d++])
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, deferred.length) }, soloWorker))
  return out
}
