// make-offer-flowty.ts
// Cadence 1.0 transaction to submit a USDC.e offer via FlowtyOffers contract.
// Single-signer only (Flow Wallet) — no Dapper co-signer required.
//
// Contract addresses (Flow mainnet):
//   FungibleToken:          0xf233dcee88fe0abe
//   USDCFlow:               0xf1ab99c82dee3526
//   NonFungibleToken:       0x1d7e57aa55817448
//   TopShot:                0x0b2a3299cc857e29
//   FlowtyOffers:           0x322d96c958eb8c46
//   FlowtyOffersResolver:   0x322d96c958eb8c46
//
// Royalty: 0.025% to 0x6590f8918060ef13
//
// Arguments:
//   nftId:             UInt64   — the Top Shot moment NFT ID
//   offeredAmount:     UFix64   — USDC.e amount to offer
//   storefrontAddress: Address  — seller / current owner address
//   expiry:            UInt64   — Unix timestamp when offer expires
//   numAcceptable:     UInt64   — number of times offer can be accepted (default 1)

export const MAKE_OFFER_FLOWTY_CADENCE = `
import FungibleToken from 0xf233dcee88fe0abe
import USDCFlow from 0xf1ab99c82dee3526
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29
import FlowtyOffers from 0x322d96c958eb8c46
import FlowtyOffersResolver from 0x322d96c958eb8c46

transaction(
  nftId: UInt64,
  offeredAmount: UFix64,
  storefrontAddress: Address,
  expiry: UInt64,
  numAcceptable: UInt64
) {
  let paymentVault: @{FungibleToken.Vault}
  let resolverCap: Capability<&{FlowtyOffersResolver.Resolver}>

  prepare(buyer: auth(BorrowValue) &Account) {
    // Borrow the buyer's USDCFlow vault and withdraw the offered amount
    let vaultRef = buyer.storage.borrow<auth(FungibleToken.Withdraw) &USDCFlow.Vault>(
      from: /storage/usdcFlowVault
    ) ?? panic("Cannot borrow USDCFlow vault from buyer account")

    self.paymentVault <- vaultRef.withdraw(amount: offeredAmount)

    // Borrow the FlowtyOffersResolver capability
    self.resolverCap = buyer.capabilities.get<&{FlowtyOffersResolver.Resolver}>(
      /public/FlowtyOffersResolver
    )
  }

  execute {
    // Royalty cut to 0x6590f8918060ef13 at 0.025%
    let royaltyCut = FlowtyOffers.RoyaltyCut(
      receiver: getAccount(0x6590f8918060ef13)
        .capabilities.get<&{FungibleToken.Receiver}>(/public/usdcFlowReceiver),
      amount: offeredAmount * 0.00025
    )

    FlowtyOffers.createOffer(
      nftType: Type<@TopShot.NFT>(),
      paymentVault: <-self.paymentVault,
      storefrontAddress: storefrontAddress,
      nftId: nftId,
      expiry: expiry,
      numAcceptable: numAcceptable,
      royaltyCuts: [royaltyCut],
      resolver: self.resolverCap
    )
  }
}
`

export const FLOWTY_OFFERS_ADDRESS = "0x322d96c958eb8c46"
export const FLOWTY_ROYALTY_ADDRESS = "0x6590f8918060ef13"
export const FLOWTY_ROYALTY_RATE = 0.00025
