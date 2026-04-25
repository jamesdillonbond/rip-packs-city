// lib/cadence/wallet-preflight.ts
//
// Read-only Cadence 1.0 script that diagnoses whether a Dapper-style wallet
// is ready to bulk-list NFTs via Flowty's NFTStorefrontV2 fork without
// hitting a storage capacity panic at execution time.
//
// All checks are performed against a public &Account reference. No mutation,
// no authorization, no fees. Safe to call as often as needed.
//
// Returns a typed `PreflightResult` struct with:
//   - Storage telemetry (used / capacity / headroom / pct used)
//   - Bulk-list sizing (max safe listing count, can-fit flag)
//   - Wallet readiness flags (storefront initialized, collection cap,
//     DUC receiver published)
//   - Triage arrays: warnings (degraded but listable) + blockers (cannot list)
//
// Contract addresses (Flow mainnet):
//   NFTStorefrontV2 (Flowty fork):  0x3cdbb3d569211ff3
//   NonFungibleToken:               0x1d7e57aa55817448
//   FungibleToken:                  0xf233dcee88fe0abe
//
// Calibration notes:
//   - bytesPerListing = 350 is a conservative upper-bound estimate.
//     Real NFTStorefrontV2.Listing resources tend to be ~250-300 bytes
//     depending on the saleCuts array length and customID presence.
//     Tuning upward errs toward warning earlier, which is the safe direction.
//     Once the failure indexer is live, recalibrate from real STORAGE_CAPACITY_EXCEEDED
//     panics by computing (storageUsed_pre - storageUsed_post) / listings_attempted.
//
//   - Storage thresholds: ≥85% = warning, ≥95% = blocker.
//     These are heuristics — adjust based on observed false-positive rate.

export const WALLET_PREFLIGHT_CADENCE = `
import NFTStorefrontV2 from 0x3cdbb3d569211ff3
import NonFungibleToken from 0x1d7e57aa55817448
import FungibleToken from 0xf233dcee88fe0abe

access(all) struct PreflightResult {
    // Storage telemetry
    access(all) let storageUsed: UInt64
    access(all) let storageCapacity: UInt64
    access(all) let storageHeadroom: UInt64
    access(all) let storageUsedPct: UFix64

    // Bulk-list sizing
    access(all) let estBytesPerListing: UInt64
    access(all) let requestedCount: UInt32
    access(all) let maxSafeListingCount: UInt32
    access(all) let canFitRequested: Bool

    // Wallet readiness
    access(all) let storefrontInitialized: Bool
    access(all) let existingListingCount: Int
    access(all) let collectionInitialized: Bool
    access(all) let collectionItemCount: Int
    access(all) let ducReceiverPublished: Bool

    // Triage
    access(all) let warnings: [String]
    access(all) let blockers: [String]
    access(all) let readyToList: Bool

    init(
        storageUsed: UInt64,
        storageCapacity: UInt64,
        storageHeadroom: UInt64,
        storageUsedPct: UFix64,
        estBytesPerListing: UInt64,
        requestedCount: UInt32,
        maxSafeListingCount: UInt32,
        canFitRequested: Bool,
        storefrontInitialized: Bool,
        existingListingCount: Int,
        collectionInitialized: Bool,
        collectionItemCount: Int,
        ducReceiverPublished: Bool,
        warnings: [String],
        blockers: [String],
        readyToList: Bool
    ) {
        self.storageUsed = storageUsed
        self.storageCapacity = storageCapacity
        self.storageHeadroom = storageHeadroom
        self.storageUsedPct = storageUsedPct
        self.estBytesPerListing = estBytesPerListing
        self.requestedCount = requestedCount
        self.maxSafeListingCount = maxSafeListingCount
        self.canFitRequested = canFitRequested
        self.storefrontInitialized = storefrontInitialized
        self.existingListingCount = existingListingCount
        self.collectionInitialized = collectionInitialized
        self.collectionItemCount = collectionItemCount
        self.ducReceiverPublished = ducReceiverPublished
        self.warnings = warnings
        self.blockers = blockers
        self.readyToList = readyToList
    }
}

access(all) fun main(
    address: Address,
    collectionPublicPath: PublicPath,
    requestedListingCount: UInt32
): PreflightResult {
    let acct = getAccount(address)

    // ── Storage telemetry ────────────────────────────────────────────────
    let used: UInt64 = acct.storage.used
    let capacity: UInt64 = acct.storage.capacity
    let headroom: UInt64 = capacity > used ? capacity - used : 0

    let usedPct: UFix64 = capacity > 0
        ? UFix64(used) * 100.0 / UFix64(capacity)
        : 0.0

    // Conservative per-Listing byte estimate. Tune from real failure data.
    let bytesPerListing: UInt64 = 350

    let maxSafeRaw: UInt64 = headroom / bytesPerListing
    let maxSafeCount: UInt32 = maxSafeRaw > UInt64(UInt32.max)
        ? UInt32.max
        : UInt32(maxSafeRaw)

    let bytesNeeded: UInt64 = UInt64(requestedListingCount) * bytesPerListing
    let canFit: Bool = bytesNeeded <= headroom

    // ── Storefront (Flowty fork) ─────────────────────────────────────────
    let storefrontCap = acct.capabilities.borrow<&{NFTStorefrontV2.StorefrontPublic}>(
        NFTStorefrontV2.StorefrontPublicPath
    )
    let storefrontInitialized: Bool = storefrontCap != nil
    let existingListings: Int = storefrontCap?.getListingIDs()?.length ?? 0

    // ── Collection (path passed in by caller — collection-agnostic) ──────
    let coll = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(
        collectionPublicPath
    )
    let collectionInitialized: Bool = coll != nil
    let collectionItems: Int = coll?.getIDs()?.length ?? 0

    // ── DUC receiver (for sale proceeds) ─────────────────────────────────
    let ducCap = acct.capabilities.borrow<&{FungibleToken.Receiver}>(
        /public/dapperUtilityCoinReceiver
    )
    let ducReceiverPublished: Bool = ducCap != nil

    // ── Triage ───────────────────────────────────────────────────────────
    var warnings: [String] = []
    var blockers: [String] = []

    if !storefrontInitialized {
        warnings.append(
            "Storefront not initialized; first listing will create it (extra ~200-byte one-time cost)"
        )
    }

    if !collectionInitialized {
        blockers.append(
            "Collection capability not published at the provided public path; wallet cannot list NFTs from this collection"
        )
    } else if collectionItems == 0 {
        warnings.append(
            "Collection capability published but contains no NFTs"
        )
    }

    if !ducReceiverPublished {
        blockers.append(
            "DUC receiver capability missing at /public/dapperUtilityCoinReceiver; sale proceeds cannot be deposited"
        )
    }

    if usedPct >= 95.0 {
        blockers.append(
            "Storage usage at or above 95%; bulk listing will almost certainly fail. Top up FLOW to increase capacity"
        )
    } else if usedPct >= 85.0 {
        warnings.append(
            "Storage usage at or above 85%; large batches may fail"
        )
    }

    if !canFit {
        blockers.append(
            "Cannot fit "
                .concat(requestedListingCount.toString())
                .concat(" listings in remaining headroom; max safe count is ")
                .concat(maxSafeCount.toString())
        )
    }

    let ready: Bool = blockers.length == 0

    return PreflightResult(
        storageUsed: used,
        storageCapacity: capacity,
        storageHeadroom: headroom,
        storageUsedPct: usedPct,
        estBytesPerListing: bytesPerListing,
        requestedCount: requestedListingCount,
        maxSafeListingCount: maxSafeCount,
        canFitRequested: canFit,
        storefrontInitialized: storefrontInitialized,
        existingListingCount: existingListings,
        collectionInitialized: collectionInitialized,
        collectionItemCount: collectionItems,
        ducReceiverPublished: ducReceiverPublished,
        warnings: warnings,
        blockers: blockers,
        readyToList: ready
    )
}
`;
