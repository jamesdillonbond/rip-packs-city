// lib/golazos/storefront-reconcile.ts
//
// Reconciles `cached_listings_v2` (LaLiga Golazos) against the LIVE state of
// each known seller's Dapper NFTStorefrontV2 — the pure half of
// app/api/cron/golazos-storefront-reconcile. The route does the I/O; this file
// decides what to write.
//
// ── WHY (measured 2026-09-25) ─────────────────────────────────────────────
// The event indexer (`golazos-listings-indexer`) only sees listings created
// after it started (2026-07-29) and resolves an edition only when the moment
// sits in `wallet_moments_cache`. Walking the 48 known sellers' storefronts
// found 1,548 Golazos listings — 1,391 live and unexpired across 442 editions —
// against 514 "open" rows in this table covering 200 editions. 244 of those
// rows had no edition (their sellers publish no public Golazos collection, so
// the collection-borrow fallback cannot see them), and 154 on-chain listings
// were GHOSTS (the moment left the seller's wallet; the listing still exists).
// Nothing closed a ghost or a listing whose ListingCompleted the indexer missed,
// so the table only ever grew. Flowty's cache — the other Golazos ask source —
// covered 67 moments and is expected to stop when Flowty's API is switched off.
//
// ── THE READ ──────────────────────────────────────────────────────────────
// `borrowListing(id).borrowNFT()` goes through the listing's OWN provider
// capability, so it resolves the edition for every seller (public collection or
// not). `hasListingBecomeGhosted()` returns TRUE when the NFT is still held —
// the name reads backwards; the deployed source says "If it returns `false` then
// it means listing becomes ghost". `borrowNFT()` force-unwraps the provider, so
// it is only called after that check. Verified against the deployed
// A.4eb8a10cb9f87357.NFTStorefrontV2 source on 2026-09-25.
//
// ── THE RULES ─────────────────────────────────────────────────────────────
// Only a seller whose storefront walk SUCCEEDED this run is reconciled. A failed
// or skipped walk touches none of that seller's rows: an absence we did not
// observe is not a removal.
//   live + unexpired  → upsert open (existing row keeps its source and chain
//                       metadata; a new one is `storefront_v2`)
//   live + expired    → close an open row as `expired`
//   ghost             → close an open row as `ghosted` (never inserted)
//   not in storefront → close an open row as `vanished`
// A row closed as `ghosted`/`vanished`/`expired` is reopened if the listing is
// live again. Writes happen before closes, and the two sets are disjoint.

import { normalizeAddress } from "@/lib/address"

export const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"

// One reconciler, per-collection config. Both contracts expose `editionID` and
// `serialNumber` on their NFT (verified on mainnet 2026-09-25), and both collections
// key `editions.external_id` by that editionID.
export interface StorefrontCollection {
  slug: string
  collectionId: string
  contractAddress: string
  contractName: string
  pipeline: string
  /** Sellers from `sales` within this many days join the walk (listers before the indexer existed). */
  saleSellerDays: number
}

export const STOREFRONT_COLLECTIONS: Readonly<Record<string, StorefrontCollection>> = {
  laliga_golazos: {
    slug: "laliga_golazos",
    collectionId: GOLAZOS_COLLECTION_ID,
    contractAddress: "0x87ca73a41bb50ad5",
    contractName: "Golazos",
    pipeline: "golazos-storefront-reconcile",
    saleSellerDays: 365,
  },
  // Added 2026-09-25: All Day's Dapper V2 book had the same gap (the 25 largest
  // sellers: ~5,850 live listings on-chain vs ~4,700 rows here). 30 days of sale
  // sellers, not 365: 5,404 sellers a year would not fit the walk budget.
  nfl_all_day: {
    slug: "nfl_all_day",
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    contractAddress: "0xe4cf4bdc1751c65d",
    contractName: "AllDay",
    pipeline: "allday-storefront-reconcile",
    saleSellerDays: 30,
  },
}

export function storefrontScriptFor(c: Pick<StorefrontCollection, "contractAddress" | "contractName">): string {
  if (!/^0x[0-9a-f]{16}$/.test(c.contractAddress) || !/^[A-Za-z][A-Za-z0-9]*$/.test(c.contractName)) {
    throw new Error("invalid storefront collection contract")
  }
  const N = c.contractName
  return `
import NFTStorefrontV2 from 0x4eb8a10cb9f87357
import ${N} from ${c.contractAddress}
access(all) fun main(seller: Address): [{String: String}] {
  var out: [{String: String}] = []
  let t = Type<@${N}.NFT>()
  let sf = getAccount(seller).capabilities.borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
  if sf == nil { return out }
  for id in sf!.getListingIDs() {
    if let l = sf!.borrowListing(listingResourceID: id) {
      let d = l.getDetails()
      if d.nftType == t && !d.purchased {
        var row: {String: String} = {
          "listingId": id.toString(),
          "nftId": d.nftID.toString(),
          "expiry": d.expiry.toString(),
          "salePrice": d.salePrice.toString(),
          "vault": d.salePaymentVaultType.identifier,
          "live": "0"
        }
        if l.hasListingBecomeGhosted() {
          if let n = l.borrowNFT() {
            let g = n as! &${N}.NFT
            row["live"] = "1"
            row["editionId"] = g.editionID.toString()
            row["serial"] = g.serialNumber.toString()
          }
        }
        out.append(row)
      }
    }
  }
  return out
}
`
}

export const GOLAZOS_STOREFRONT_SCRIPT = storefrontScriptFor(STOREFRONT_COLLECTIONS.laliga_golazos)

export interface StorefrontListing {
  listingId: string
  nftId: string
  editionExternalId: string | null
  live: boolean
  expiryEpoch: number
  salePrice: number
  vaultType: string
}

/** Parses the script's decoded result: an array of {String: String} maps. */
export function parseStorefrontListings(rows: unknown): StorefrontListing[] {
  if (!Array.isArray(rows)) throw new Error("storefront script returned a non-array")
  return rows.map((r) => {
    const m = r as Record<string, string | undefined>
    if (!m.listingId || !m.nftId) throw new Error("storefront row missing listingId/nftId")
    return {
      listingId: m.listingId,
      nftId: m.nftId,
      editionExternalId: m.editionId ?? null,
      live: m.live === "1",
      expiryEpoch: Number(m.expiry),
      salePrice: Number(m.salePrice),
      vaultType: m.vault ?? "",
    }
  })
}

export function deriveCurrency(vaultTypeId: string): string {
  if (!vaultTypeId) return "UNKNOWN"
  if (vaultTypeId.includes("DapperUtilityCoin")) return "DUC"
  if (vaultTypeId.includes("FlowUtilityToken")) return "FUT"
  if (vaultTypeId.includes("FlowToken")) return "FLOW"
  if (vaultTypeId.includes("FUSD")) return "FUSD"
  return vaultTypeId
}

// Same rule as the event indexer: only Dapper's dollar-pegged tokens carry a USD price.
function priceUsdFor(currency: string, salePrice: number): number | null {
  return (currency === "DUC" || currency === "FUT") && Number.isFinite(salePrice) ? salePrice : null
}

export interface ListingRow {
  listing_resource_id: string
  source: string
  flow_id: string
  edition_id: string | null
  collection_id: string
  seller_address: string
  price_usd: number | null
  currency: string | null
  custom_id: string | null
  listed_at: string | null
  expiry_at: string | null
  completed_at: string | null
  completed_status: string | null
  block_height: number | null
  tx_hash: string | null
  event_index: number | null
  /** When a storefront walk last confirmed the listing live (migration 20260925224605). */
  verified_at?: string | null
}

export type CloseStatus = "ghosted" | "vanished" | "expired"

// Statuses this reconciler set — the only closed rows it may reopen. A row
// closed by a ListingCompleted event (`purchased` / `cancelled`) belongs to the
// indexer and is never touched.
export const V2_SOURCES: ReadonlySet<string> = new Set(["direct_v2", "storefront_v2"])

const RECONCILER_STATUSES: ReadonlySet<string> = new Set(["ghosted", "vanished", "expired"])

export interface ReconcilePlan {
  upserts: ListingRow[]
  closes: Array<{ listing_resource_id: string; source: string; status: CloseStatus }>
  counts: {
    live: number
    inserted: number
    updated: number
    reopened: number
    ghosted: number
    vanished: number
    expired: number
    live_without_edition: number
  }
}

function sourcePriority(source: string): number {
  // Prefer the event-backed row when one listing exists under several sources.
  return source === "direct_v2" ? 0 : source === "storefront_v2" ? 1 : 2
}

export function planReconcile(input: {
  walkedSellers: ReadonlyMap<string, StorefrontListing[]>
  existing: ListingRow[]
  editionUuidByExternalId: ReadonlyMap<string, string>
  nowEpoch: number
  /** The collection being reconciled; defaults to Golazos (the first user). */
  collectionId?: string
}): ReconcilePlan {
  const { walkedSellers, editionUuidByExternalId, nowEpoch } = input
  // Stamped on every listing this walk confirmed live. Golazos ask pricing
  // (refresh_golazos_ask_fmv_from_listings) counts a listing only while this — or
  // the event's listed_at — is within 6 h, so a stalled reconciler stops pricing.
  const verifiedAt = new Date(nowEpoch * 1000).toISOString()
  // Only rows this storefront backs. A walk of the Dapper NFTStorefrontV2 says
  // nothing about a V1 (`direct_v1`) or Flowty-fork (`direct`) listing, so those
  // must never be closed as "vanished" for being absent from it.
  const existing = input.existing.filter((r) => V2_SOURCES.has(r.source))

  // ⚠ KEY ON String(id). PostgREST serialises a bigint column as a JSON NUMBER,
  // while the storefront script returns every id as a STRING — a Map keyed on the
  // raw value never matches, and the first production run (2026-09-25 2:48 PM PT)
  // inserted all 3,338 live listings as new and closed all 514 existing rows as
  // "vanished" because of exactly that. The route also selects the ids as text.
  const bestByListing = new Map<string, ListingRow>()
  for (const row of existing) {
    const key = String(row.listing_resource_id)
    const cur = bestByListing.get(key)
    if (!cur || sourcePriority(row.source) < sourcePriority(cur.source)) {
      bestByListing.set(key, row)
    }
  }

  const plan: ReconcilePlan = {
    upserts: [],
    closes: [],
    counts: { live: 0, inserted: 0, updated: 0, reopened: 0, ghosted: 0, vanished: 0, expired: 0, live_without_edition: 0 },
  }
  const seenOnChain = new Set<string>()

  for (const [seller, listings] of walkedSellers) {
    for (const l of listings) {
      seenOnChain.add(l.listingId)
      const row = bestByListing.get(l.listingId)
      const isOpen = row != null && row.completed_at == null

      if (!l.live) {
        if (row && isOpen) {
          plan.closes.push({ listing_resource_id: row.listing_resource_id, source: row.source, status: "ghosted" })
          plan.counts.ghosted++
        }
        continue
      }
      if (!(l.expiryEpoch > nowEpoch)) {
        if (row && isOpen) {
          plan.closes.push({ listing_resource_id: row.listing_resource_id, source: row.source, status: "expired" })
          plan.counts.expired++
        }
        continue
      }

      plan.counts.live++
      const editionUuid = l.editionExternalId ? editionUuidByExternalId.get(l.editionExternalId) ?? null : null
      const currency = deriveCurrency(l.vaultType)
      const fields = {
        flow_id: l.nftId,
        collection_id: input.collectionId ?? GOLAZOS_COLLECTION_ID,
        seller_address: normalizeAddress(seller),
        price_usd: priceUsdFor(currency, l.salePrice),
        currency,
        expiry_at: new Date(l.expiryEpoch * 1000).toISOString(),
        verified_at: verifiedAt,
      }

      if (row) {
        // A closed row is reopened only if THIS reconciler closed it.
        if (!isOpen && !RECONCILER_STATUSES.has(row.completed_status ?? "")) continue
        const next: ListingRow = {
          ...row,
          ...fields,
          edition_id: editionUuid ?? row.edition_id,
          completed_at: null,
          completed_status: null,
        }
        if (next.edition_id == null) plan.counts.live_without_edition++
        plan.upserts.push(next)
        if (!isOpen) plan.counts.reopened++
        else plan.counts.updated++
      } else {
        if (editionUuid == null) plan.counts.live_without_edition++
        plan.upserts.push({
          listing_resource_id: l.listingId,
          source: "storefront_v2",
          ...fields,
          edition_id: editionUuid,
          custom_id: null,
          listed_at: null,
          completed_at: null,
          completed_status: null,
          block_height: null,
          tx_hash: null,
          event_index: null,
        })
        plan.counts.inserted++
      }
    }
  }

  // Open rows of a WALKED seller that the storefront no longer holds at all.
  const walked = new Set([...walkedSellers.keys()].map(normalizeAddress))
  for (const row of existing) {
    if (row.completed_at != null) continue
    if (!walked.has(normalizeAddress(row.seller_address))) continue
    if (seenOnChain.has(String(row.listing_resource_id))) continue
    plan.closes.push({ listing_resource_id: row.listing_resource_id, source: row.source, status: "vanished" })
    plan.counts.vanished++
  }

  return plan
}
