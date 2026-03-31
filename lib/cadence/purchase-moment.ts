// lib/cadence/purchase-moment.cdc
//
// Cadence 1.0 compatible purchase transaction for NBA Top Shot moments
// via Dapper Wallet (DapperUtilityCoin / DapperBalance).
//
// Usage in FCL:
//   import PURCHASE_MOMENT_CADENCE from "@/lib/cadence/purchase-moment.cdc"
//
//   const txId = await fcl.mutate({
//     cadence: PURCHASE_MOMENT_CADENCE,
//     args: (arg, t) => [
//       arg(DAPPER_MERCHANT_ADDRESS, t.Address),   // "0xc1e4f4f4c4257510"
//       arg(storefrontAddress,       t.Address),   // seller's address
//       arg(listingResourceID,       t.UInt64),    // listing resource ID
//       arg(expectedPrice,           t.UFix64),    // e.g. "2.75"
//     ],
//     proposer:       fcl.authz,
//     payer:          fcl.authz,
//     authorizations: [fcl.authz],
//     limit: 1000,
//   })
//
// Contract addresses (Flow mainnet):
//   DapperUtilityCoin:  0xead892083b3e2c6c
//   NFTStorefrontV2:    0x4eb8a10cb9f87357  (also at 0x3cdbb3d569211ff3)
//   TopShot:            0x0b2a3299cc857e29
//   NonFungibleToken:   0x1d7e57aa55817448
//   MetadataViews:      0x1d7e57aa55817448
//   TopShotMarketV3:    0xc1e4f4f4c4257510  ← merchant address
//
// Verified from live Flowty transaction:
//   0x269373489e1c9dba9fde110515826f1b2ca7be4fd1168c10e0081041e28f1912
//   Buyer:  0xbd94cade097e50ac
//   Seller: 0x72e59fcaa92ffa7f
//   Price:  2.75 DUC
//   NFT ID: 44203219
// ─────────────────────────────────────────────────────────────────────────────

export const PURCHASE_MOMENT_CADENCE = `
import DapperUtilityCoin from 0xead892083b3e2c6c
import NFTStorefrontV2 from 0x4eb8a10cb9f87357
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29
import MetadataViews from 0x1d7e57aa55817448

transaction(
  merchantAccountAddress: Address,
  storefrontAddress: Address,
  listingResourceID: UInt64,
  expectedPrice: UFix64
) {
  let paymentVault: @DapperUtilityCoin.Vault
  let buyerCollection: &{NonFungibleToken.CollectionPublic}
  let storefront: &{NFTStorefrontV2.StorefrontPublic}
  let listing: &{NFTStorefrontV2.ListingPublic}

  prepare(buyer: auth(BorrowValue) &Account, dapperAccount: auth(BorrowValue) &Account) {
    // Validate merchant
    assert(
      dapperAccount.address == merchantAccountAddress,
      message: "Merchant account does not match expected address"
    )

    // Validate price
    let price = self.listing.getDetails().salePrice
    assert(
      price == expectedPrice,
      message: "Listing price has changed — expected ".concat(expectedPrice.toString()).concat(" got ").concat(price.toString())
    )

    // Withdraw DUC from buyer's vault
    let ducVault = buyer.storage.borrow<auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault>(
      from: /storage/dapperUtilityCoinVault
    ) ?? panic("Cannot borrow DapperUtilityCoin vault from buyer")

    self.paymentVault <- ducVault.withdraw(amount: expectedPrice) as! @DapperUtilityCoin.Vault

    // Borrow buyer's Top Shot collection
    self.buyerCollection = buyer.capabilities
      .borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection)
      ?? panic("Cannot borrow buyer TopShot collection")

    // Borrow storefront
    self.storefront = getAccount(storefrontAddress)
      .capabilities
      .borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
      ?? panic("Cannot borrow storefront from seller")

    // Borrow listing
    self.listing = self.storefront.borrowListing(listingResourceID: listingResourceID)
      ?? panic("No listing with ID ".concat(listingResourceID.toString()))
  }

  execute {
    // Execute the purchase — NFT flows to buyer, DUC flows to seller + fees
    let nft <- self.listing.purchase(
      payment: <-self.paymentVault,
      commissionRecipient: nil
    )

    // Deposit NFT into buyer's collection
    self.buyerCollection.deposit(token: <-nft)
  }
}
`

// ── Dapper confirmed constants ────────────────────────────────────────────────
export const DAPPER_MERCHANT_ADDRESS = "0xc1e4f4f4c4257510"
export const TOPSHOT_CONTRACT_ADDRESS = "0x0b2a3299cc857e29"
export const NFT_STOREFRONT_V2_ADDRESS = "0x4eb8a10cb9f87357"
export const DUC_CONTRACT_ADDRESS = "0xead892083b3e2c6c"