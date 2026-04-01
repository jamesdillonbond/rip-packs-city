// Single-signer Cadence 1.0 transaction for purchasing Top Shot moments
// using a Flow Wallet (FLOW or USDCFlow). No Dapper co-signer required.

export const FLOW_TOKEN_VAULT_TYPE = "A.7e60df042a9c0868.FlowToken.Vault"
export const USDC_FLOW_VAULT_TYPE = "A.f1ab99c82dee3526.USDCFlow.Vault"

// Maps the short paymentToken enum to full vault type identifiers
export const PAYMENT_TOKEN_TO_VAULT: Record<string, string> = {
  FLOW: FLOW_TOKEN_VAULT_TYPE,
  USDC_E: USDC_FLOW_VAULT_TYPE,
}

export const PURCHASE_MOMENT_FLOW_WALLET_CADENCE = `
import FungibleToken from 0xf233dcee88fe0abe
import FlowToken from 0x1654653399040a61
import USDCFlow from 0xf1ab99c82dee3526
import NonFungibleToken from 0x1d7e57aa55817448
import NFTStorefrontV2 from 0x4eb8a10cb9f87357
import TopShot from 0x0b2a3299cc857e29

transaction(
  storefrontAddress: Address,
  listingResourceID: UInt64,
  expectedPrice: UFix64,
  paymentVaultType: String,
  commissionRecipient: Address?
) {
  let paymentVault: @{FungibleToken.Vault}
  let nftCollection: &TopShot.Collection
  let storefront: &{NFTStorefrontV2.StorefrontPublic}
  let listing: &{NFTStorefrontV2.ListingPublic}
  var commissionRecipientCap: Capability<&{FungibleToken.Receiver}>?

  prepare(buyer: auth(BorrowValue) &Account) {
    // Borrow the appropriate vault based on paymentVaultType
    if paymentVaultType == "${FLOW_TOKEN_VAULT_TYPE}" {
      let vaultRef = buyer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
        from: /storage/flowTokenVault
      ) ?? panic("Cannot borrow FlowToken vault from buyer account")
      self.paymentVault <- vaultRef.withdraw(amount: expectedPrice)
    } else if paymentVaultType == "${USDC_FLOW_VAULT_TYPE}" {
      let vaultRef = buyer.storage.borrow<auth(FungibleToken.Withdraw) &USDCFlow.Vault>(
        from: /storage/usdcFlowVault
      ) ?? panic("Cannot borrow USDCFlow vault from buyer account")
      self.paymentVault <- vaultRef.withdraw(amount: expectedPrice)
    } else {
      panic("Unsupported payment vault type: ".concat(paymentVaultType))
    }

    // Borrow buyer's TopShot collection
    self.nftCollection = buyer.storage.borrow<&TopShot.Collection>(
      from: /storage/MomentCollection
    ) ?? panic("Buyer does not have a Top Shot collection")

    // Borrow the storefront from the seller
    self.storefront = getAccount(storefrontAddress)
      .capabilities.borrow<&{NFTStorefrontV2.StorefrontPublic}>(
        NFTStorefrontV2.StorefrontPublicPath
      )
      ?? panic("Could not borrow storefront from address")

    // Borrow the listing
    self.listing = self.storefront.borrowListing(listingResourceID: listingResourceID)
      ?? panic("Listing not found — it may have already been purchased")

    // Verify the price hasn't changed
    let listingDetails = self.listing.getDetails()
    assert(
      listingDetails.salePrice == expectedPrice,
      message: "Listing price has changed"
    )

    // Set up commission recipient if applicable
    self.commissionRecipientCap = nil
    let commissionAmount = listingDetails.commissionAmount

    if commissionRecipient != nil && commissionAmount != 0.0 {
      // For Flow/USDC payments, commission goes through the matching token receiver
      if paymentVaultType == "${FLOW_TOKEN_VAULT_TYPE}" {
        let cap = getAccount(commissionRecipient!)
          .capabilities.get<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
        assert(cap.check(), message: "Commission recipient does not have a valid FlowToken receiver")
        self.commissionRecipientCap = cap
      } else {
        let cap = getAccount(commissionRecipient!)
          .capabilities.get<&{FungibleToken.Receiver}>(/public/usdcFlowReceiver)
        assert(cap.check(), message: "Commission recipient does not have a valid USDCFlow receiver")
        self.commissionRecipientCap = cap
      }
    } else if commissionAmount != 0.0 {
      panic("Commission recipient required when commission amount is non-zero")
    }
  }

  execute {
    let nft <- self.listing.purchase(
      payment: <-self.paymentVault,
      commissionRecipient: self.commissionRecipientCap
    )
    self.nftCollection.deposit(token: <-nft)
  }
}
`
