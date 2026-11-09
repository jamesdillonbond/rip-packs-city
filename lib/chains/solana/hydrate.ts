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

/**
 * Fetch each asset's content.json_uri (https only) and merge it. Bounded concurrency and a
 * per-request timeout; never throws. Order of `hydrated` is not significant.
 */
export async function hydrateFromJsonUri(
  assets: DasAsset[],
  opts: { concurrency?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HydrateResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 16)
  const timeoutMs = opts.timeoutMs ?? 8000
  const doFetch = opts.fetchImpl ?? fetch
  const out: HydrateResult = { hydrated: [], failed: [] }
  let next = 0
  async function worker() {
    while (next < assets.length) {
      const a = assets[next++]
      const uri = a.content?.json_uri
      if (typeof uri !== "string" || !/^https:\/\//i.test(uri)) {
        out.failed.push({ id: a.id, reason: "no https json_uri" })
        continue
      }
      let lastReason = "no attempt"
      let merged: DasAsset | null = null
      for (const url of gatewayAlternates(uri)) {
        try {
          const resp = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
          if (!resp.ok) { lastReason = `HTTP ${resp.status}`; continue }
          merged = mergeOffChainJson(a, JSON.parse(await resp.text()))
          if (merged) break
          lastReason = "json carried no traits or image"
        } catch (e) {
          lastReason = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120)
        }
      }
      if (merged) out.hydrated.push(merged)
      else out.failed.push({ id: a.id, reason: lastReason })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, worker))
  return out
}
