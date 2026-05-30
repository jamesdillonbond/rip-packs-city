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
//   FungibleToken:      0xf233dcee88fe0abe
//   NFTStorefrontV2:    0x4eb8a10cb9f87357  (also at 0x3cdbb3d569211ff3)
//   TopShot:            0x0b2a3299cc857e29
//   NonFungibleToken:   0x1d7e57aa55817448
//   MetadataViews:      0x1d7e57aa55817448
//   Dapper merchant:    0xc1e4f4f4c4257510  (meta-tx co-signer + commission recipient)
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
import FungibleToken from 0xf233dcee88fe0abe
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
  // H1: every Dapper-published Top Shot listing carries a non-zero commissionAmount,
  // so NFTStorefrontV2.purchase() panics on commissionRecipient: nil. Capture the
  // merchant's published DUC receiver capability up front and pass it through.
  let commissionRecipientCap: Capability<&{FungibleToken.Receiver}>
  // H2: the Dapper meta-tx co-signer requires a post-condition asserting the buyer's
  // DUC vault decreased by exactly expectedPrice. Capture pre-state in prepare so
  // the post block can reconcile it.
  let buyerDUCVault: &DapperUtilityCoin.Vault
  let balanceBeforePurchase: UFix64

  prepare(buyer: auth(BorrowValue) &Account, dapperAccount: auth(BorrowValue) &Account) {
    // Validate merchant
    assert(
      dapperAccount.address == merchantAccountAddress,
      message: "Merchant account does not match expected address"
    )

    // Borrow storefront
    self.storefront = getAccount(storefrontAddress)
      .capabilities
      .borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
      ?? panic("Cannot borrow storefront from seller")

    // Borrow listing
    self.listing = self.storefront.borrowListing(listingResourceID: listingResourceID)
      ?? panic("No listing with ID ".concat(listingResourceID.toString()))

    // Validate price
    let price = self.listing.getDetails().salePrice
    assert(
      price == expectedPrice,
      message: "Listing price has changed — expected ".concat(expectedPrice.toString()).concat(" got ").concat(price.toString())
    )

    // Borrow buyer's Top Shot collection
    self.buyerCollection = buyer.capabilities
      .borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection)
      ?? panic("Buyer is missing /public/MomentCollection — run setup_topshot_account first")

    // Borrow buyer's DUC vault and snapshot opening balance for the post-condition leak check
    let ducVault = buyer.storage.borrow<auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault>(
      from: /storage/dapperUtilityCoinVault
    ) ?? panic("Cannot borrow DapperUtilityCoin vault from buyer")
    self.buyerDUCVault = ducVault
    self.balanceBeforePurchase = ducVault.balance

    // Withdraw payment
    self.paymentVault <- ducVault.withdraw(amount: expectedPrice) as! @DapperUtilityCoin.Vault

    // H1: resolve the commission receiver capability published by the merchant at the
    // standard Dapper path. NFTStorefrontV2.purchase only consumes this when
    // self.details.commissionAmount > 0 (contract lines 355-378), so a valid cap is
    // also safe for zero-commission listings.
    self.commissionRecipientCap = getAccount(merchantAccountAddress)
      .capabilities
      .get<&{FungibleToken.Receiver}>(/public/dapperUtilityCoinReceiver)
  }

  execute {
    // Execute the purchase — NFT flows to buyer, DUC flows to seller + fees + commission
    let nft <- self.listing.purchase(
      payment: <-self.paymentVault,
      commissionRecipient: self.commissionRecipientCap
    )

    // Deposit NFT into buyer's collection
    self.buyerCollection.deposit(token: <-nft)
  }

  // H2: Dapper meta-tx co-signer leak check. The only DUC that should leave the
  // buyer's vault is exactly expectedPrice; the storefront draws commission and
  // sale cuts from the payment vault we already moved.
  post {
    self.buyerDUCVault.balance == self.balanceBeforePurchase - expectedPrice:
      "DUC balance leak — buyer DUC vault did not decrease by exactly expectedPrice"
  }
}
`

// ── Dapper confirmed constants ────────────────────────────────────────────────
export const DAPPER_MERCHANT_ADDRESS = "0xc1e4f4f4c4257510"
export const TOPSHOT_CONTRACT_ADDRESS = "0x0b2a3299cc857e29"
export const NFT_STOREFRONT_V2_ADDRESS = "0x4eb8a10cb9f87357"
export const DUC_CONTRACT_ADDRESS = "0xead892083b3e2c6c"