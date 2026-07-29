// Shared pure logic for the pack-distribution SEEDERS — the two edge fns that
// walk the Flow PDS / Dapper Studio catalog and file each distribution into
// `pack_distributions`:
//   • seed-allday-pack-distributions  (AllDay + Golazos, via ?collection=)
//   • seed-topshot-pack-distributions (Top Shot, via the Studio GraphQL API)
//
// What these functions decide is load-bearing:
//   • classifyDist chooses WHICH COLLECTION a distribution belongs to — a
//     mis-classification files an NFL pack under Golazos (or vice-versa), which
//     then mis-attributes its pack-EV and pack-history to the wrong collection.
//   • b64ToUtf8 is the mojibake guard: plain `atob` is latin1-only, so an
//     on-chain UTF-8 title double-encodes ("Atlético" → "AtlÃ©tico"). This exact
//     bug corrupted 55 pack titles + 308 metadata rows on 2026-07-25 because the
//     seeder is ONE function serving BOTH AllDay and Golazos.
//   • buildTopshotPackRow maps a Studio GraphQL node into the catalog row,
//     including the retail_price_usd + number_of_pack_slots that drive pack-EV.
//
// Ported VERBATIM from the two edge fns. The deployed Deno functions still carry
// inline copies (they are excluded from the vitest coverage run — no Deno
// toolchain in CI); the source-drift guard in
// __tests__/edge-pack-distribution-parse.test.ts fails CI if an inline copy is
// edited without mirroring it here. btoa/atob/TextDecoder are globals in both
// Deno and Node ≥16, so this module imports cleanly under vitest.

/**
 * base64 → JS string, UTF-8 CORRECT. Plain `atob` returns latin1 (one byte = one
 * char), double-encoding every multi-byte UTF-8 sequence; on this path that would
 * corrupt pack titles + metadata on their way into `pack_distributions`. Pure
 * ASCII decodes identically, so this is a no-op for payloads already correct.
 */
export function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

export type PackTargetKey = "allday" | "golazos"

/**
 * The `?collection=` param resolver core: golazos (and its laliga aliases) map to
 * the golazos bucket, everything else falls back to allday. Verbatim string logic
 * from seed-allday-pack-distributions.resolveTarget().
 */
export function resolveTargetKey(raw: string | null | undefined): PackTargetKey {
  const v = (raw ?? "").toString().trim().toLowerCase()
  if (v === "golazos" || v === "laliga-golazos" || v === "laliga_golazos") return "golazos"
  return "allday"
}

/**
 * Classify a PDS distribution by productID / title / metadata. The order matters:
 * productID wins, then title, then a broad any-value scan. A regression here
 * files a pack under the wrong collection. Ported verbatim from
 * seed-allday-pack-distributions.classifyDist().
 */
export function classifyDist(
  data: Record<string, string>,
): "allday" | "golazos" | "topshot" | "other" {
  const productId = (data.meta_productID ?? data.meta_productId ?? "").toLowerCase()
  const title = (data.title ?? "").toLowerCase()
  const allVals = Object.values(data).join(" ").toLowerCase()

  if (productId === "golazos" || productId.includes("golazos")) return "golazos"
  if (productId === "topshot" || productId.includes("topshot") || productId.includes("top_shot"))
    return "topshot"
  if (productId.includes("all_day") || productId.includes("allday") || productId.includes("nfl"))
    return "allday"

  if (title.includes("golazos") || title.includes("jornada") || allVals.includes("golazos"))
    return "golazos"
  if (title.includes("top shot") || title.includes("topshot")) return "topshot"
  if (
    title.includes("all day") ||
    title.includes("allday") ||
    title.includes(" nfl ") ||
    allVals.includes("nfl_all_day")
  )
    return "allday"

  if (allVals.includes("nbatopshot")) return "topshot"
  if (allVals.includes("nflallday") || allVals.includes("allday")) return "allday"

  return "other"
}

/** A partial mirror of the Studio GraphQL PackNode `distribution` shape. */
export interface TopshotPackNodeDistribution {
  title?: { value: string | null } | null
  image_urls?: { value?: (string | null)[] | null } | null
  uuid?: { value: string | null } | null
  tier?: { value: string | null } | null
  pack_type?: { value: string | null } | null
  price?: { value: number | string | null } | null
  number_of_pack_slots?: { value: string | null } | null
  start_time?: { value: string | null } | null
}

/**
 * Map a Studio GraphQL pack node into the `pack_distributions` catalog row.
 * total_minted/total_opened are deliberately NOT written (the RPC leaves those
 * durable columns untouched on conflict). Ported verbatim from
 * seed-topshot-pack-distributions.buildRow(), with the collection id + nft_type
 * lifted to params so it stays pure.
 */
export function buildTopshotPackRow(
  distId: string,
  collectionId: string,
  node: { distribution?: TopshotPackNodeDistribution | null },
) {
  const d = node.distribution ?? {}
  return {
    collection_id: collectionId,
    dist_id: distId,
    title: d.title?.value ?? null,
    nft_type: "TopShot",
    image_url: d.image_urls?.value?.[0] ?? null,
    metadata: {
      uuid: d.uuid?.value ?? null,
      tier: d.tier?.value ?? null,
      pack_type: d.pack_type?.value ?? null,
      retail_price_usd: d.price?.value ?? null,
      number_of_pack_slots: d.number_of_pack_slots?.value
        ? parseInt(d.number_of_pack_slots.value, 10)
        : null,
      start_time: d.start_time?.value ?? null,
    },
  }
}
