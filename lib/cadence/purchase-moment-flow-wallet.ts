// lib/cadence/purchase-moment-flow-wallet.ts
//
// Cadence 1.0 single-signer transaction for purchasing Top Shot moments on
// NFTStorefrontV2 using a Flow Wallet (non-Dapper) buyer. Works for any
// DUC-denominated listing — the buyer pays out of their own DUC vault at
// /storage/dapperUtilityCoinVault and the NFT is deposited into their
// TopShot.Collection at /storage/MomentCollection. No Dapper co-signer and
// therefore no DUC-leak post{} check.
//
// For dual-signer Dapper purchases (pending Dapper merchant registration)
// see lib/cadence/purchase-moment.ts.

export const PURCHASE_MOMENT_FLOW_WALLET_CADENCE = `
import DapperUtilityCoin from 0xead892083b3e2c6c
import FungibleToken from 0xf233dcee88fe0abe
import NonFungibleToken from 0x1d7e57aa55817448
import NFTStorefrontV2 from 0x4eb8a10cb9f87357
import TopShot from 0x0b2a3299cc857e29

transaction(
  storefrontAddress: Address,
  listingResourceID: UInt64,
  expectedPrice: UFix64
) {
  let paymentVault: @{FungibleToken.Vault}
  let buyerCollection: &TopShot.Collection
  let storefront: &{NFTStorefrontV2.StorefrontPublic}
  let listing: &{NFTStorefrontV2.ListingPublic}

  prepare(buyer: auth(BorrowValue) &Account) {
    self.storefront = getAccount(storefrontAddress)
      .capabilities
      .borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
      ?? panic("Cannot borrow storefront from seller")

    self.listing = self.storefront.borrowListing(listingResourceID: listingResourceID)
      ?? panic("No listing with ID ".concat(listingResourceID.toString()))

    let details = self.listing.getDetails()

    assert(
      details.salePrice == expectedPrice,
      message: "Listing price has changed — expected ".concat(expectedPrice.toString()).concat(" got ").concat(details.salePrice.toString())
    )

    assert(
      details.salePaymentVaultType == Type<@DapperUtilityCoin.Vault>(),
      message: "Listing is not DUC-denominated — this template only handles DUC listings on NFTStorefrontV2"
    )

    let ducVault = buyer.storage.borrow<auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault>(
      from: /storage/dapperUtilityCoinVault
    ) ?? panic("Buyer does not hold a DapperUtilityCoin vault at /storage/dapperUtilityCoinVault")

    self.paymentVault <- ducVault.withdraw(amount: expectedPrice)

    self.buyerCollection = buyer.storage.borrow<&TopShot.Collection>(
      from: /storage/MomentCollection
    ) ?? panic("Buyer does not have a TopShot.Collection at /storage/MomentCollection")
  }

  execute {
    let nft <- self.listing.purchase(
      payment: <-self.paymentVault,
      commissionRecipient: nil
    )
    self.buyerCollection.deposit(token: <-nft)
  }
}
`

export const DUC_CONTRACT_ADDRESS = "0xead892083b3e2c6c"
export const NFT_STOREFRONT_V2_ADDRESS = "0x4eb8a10cb9f87357"
export const TOPSHOT_CONTRACT_ADDRESS = "0x0b2a3299cc857e29"
