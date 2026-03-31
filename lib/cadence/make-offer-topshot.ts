// make-offer-topshot.ts
// Cadence 1.0 transaction to create a TopShotEdition offer via DapperOffersV2.
//
// Contract addresses (Flow mainnet):
//   DapperOffersV2:      0xb8ea91944fd51c43  (also holds OffersV2, Resolver)
//   DapperUtilityCoin:   0xead892083b3e2c6c
//   FungibleToken:       0xf233dcee88fe0abe
//   NonFungibleToken:    0x1d7e57aa55817448
//   TopShot:             0x0b2a3299cc857e29
//
// Storage paths (from DapperOffersV2 contract init):
//   DapperOffer storage: /storage/DapperOffersV2
//   DapperOffer public:  /public/DapperOffersV2
//   Resolver storage:    /storage/OfferResolver
//   Resolver public:     /public/OfferResolver
//
// offerParamsString for TopShotEdition (resolver="1"):
//   "_type" / "setId" / "playId" / "typeId" / "setUuid" / "playUuid" / "resolver"
//
// Royalties: 5% to 0xfaf0cc52c6e3acaf
//
// Verified from live tx fa3bb8e046f6722e93286f0bd52ee6cc105a358b95353d7f2dd6ad58f49fa6fa
//   Buyer: 0xbd94cade097e50ac  Amount: 1.00 DUC  setId=4 playId=37

export const MAKE_OFFER_TOPSHOT_CADENCE = `
import DapperOffersV2 from 0xb8ea91944fd51c43
import OffersV2 from 0xb8ea91944fd51c43
import Resolver from 0xb8ea91944fd51c43
import FungibleToken from 0xf233dcee88fe0abe
import DapperUtilityCoin from 0xead892083b3e2c6c
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29

transaction(
  merchantAccountAddress: Address,
  offerAmount: UFix64,
  setId: UInt32,
  playId: UInt32,
  setUuid: String,
  playUuid: String,
) {
  let dapperOfferResource: auth(DapperOffersV2.Manager) &DapperOffersV2.DapperOffer
  let vaultRefCapability: Capability<auth(FungibleToken.Withdraw) &{FungibleToken.Vault}>
  let nftReceiverCapability: Capability<&{NonFungibleToken.CollectionPublic}>
  let resolverCapability: Capability<&{Resolver.ResolverPublic}>
  let royaltyReceiverCap: Capability<&{FungibleToken.Receiver}>

  prepare(
    buyer: auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability) &Account,
    dapperAccount: auth(BorrowValue) &Account
  ) {
    assert(dapperAccount.address == merchantAccountAddress, message: "Merchant address mismatch")

    // Ensure DapperOffer resource exists, create if not
    if buyer.storage.borrow<&DapperOffersV2.DapperOffer>(
        from: DapperOffersV2.DapperOffersStoragePath
    ) == nil {
      buyer.storage.save(
        <- DapperOffersV2.createDapperOffer(),
        to: DapperOffersV2.DapperOffersStoragePath
      )
      buyer.capabilities.publish(
        buyer.capabilities.storage.issue<&{DapperOffersV2.DapperOfferPublic}>(
          DapperOffersV2.DapperOffersStoragePath
        ),
        at: DapperOffersV2.DapperOffersPublicPath
      )
    }

    self.dapperOfferResource = buyer.storage.borrow<
      auth(DapperOffersV2.Manager) &DapperOffersV2.DapperOffer
    >(from: DapperOffersV2.DapperOffersStoragePath)
      ?? panic("Cannot borrow DapperOffer resource")

    // Ensure OfferResolver resource exists, create if not
    let resolverStoragePath = StoragePath(identifier: "OfferResolver")!
    let resolverPublicPath  = PublicPath(identifier: "OfferResolver")!

    if buyer.storage.borrow<&Resolver.OfferResolver>(from: resolverStoragePath) == nil {
      buyer.storage.save(<- Resolver.createResolver(), to: resolverStoragePath)
      buyer.capabilities.publish(
        buyer.capabilities.storage.issue<&{Resolver.ResolverPublic}>(resolverStoragePath),
        at: resolverPublicPath
      )
    }

    self.resolverCapability = buyer.capabilities.get<&{Resolver.ResolverPublic}>(resolverPublicPath)

    // DUC vault capability (withdraw-entitled)
    self.vaultRefCapability = buyer.capabilities.get<
      auth(FungibleToken.Withdraw) &{FungibleToken.Vault}
    >(/private/dapperUtilityCoinVault)

    if !self.vaultRefCapability.check() {
      self.vaultRefCapability = buyer.capabilities.storage.issue<
        auth(FungibleToken.Withdraw) &{FungibleToken.Vault}
      >(/storage/dapperUtilityCoinVault)
    }

    assert(self.vaultRefCapability.check(), message: "DUC vault capability not valid")

    // TopShot NFT receiver
    self.nftReceiverCapability = buyer.capabilities.get<&{NonFungibleToken.CollectionPublic}>(
      /public/MomentCollection
    )
    assert(self.nftReceiverCapability.check(), message: "TopShot collection capability not valid")

    // Royalty receiver (Top Shot royalty address)
    self.royaltyReceiverCap = getAccount(0xfaf0cc52c6e3acaf)
      .capabilities.get<&{FungibleToken.Receiver}>(/public/dapperUtilityCoinReceiver)
  }

  execute {
    let offerParams: {String: String} = {
      "_type":    "TopShotEdition",
      "setId":    setId.toString(),
      "playId":   playId.toString(),
      "typeId":   "Type<@TopShot.NFT>()",
      "setUuid":  setUuid,
      "playUuid": playUuid,
      "resolver": "1"
    }

    let royalties: [OffersV2.Royalty] = [
      OffersV2.Royalty(receiver: self.royaltyReceiverCap, amount: offerAmount * 0.05)
    ]

    let offerId = self.dapperOfferResource.createOffer(
      vaultRefCapability:    self.vaultRefCapability,
      nftReceiverCapability: self.nftReceiverCapability,
      nftType:               Type<@TopShot.NFT>(),
      amount:                offerAmount,
      royalties:             royalties,
      offerParamsString:     offerParams,
      offerParamsUFix64:     {},
      offerParamsUInt64:     {},
      resolverCapability:    self.resolverCapability,
    )
    log("Offer created: ".concat(offerId.toString()))
  }
}
`

export const CANCEL_OFFER_TOPSHOT_CADENCE = `
import DapperOffersV2 from 0xb8ea91944fd51c43

transaction(offerId: UInt64) {
  prepare(buyer: auth(BorrowValue) &Account) {
    let dapperOffer = buyer.storage.borrow<
      auth(DapperOffersV2.Manager) &DapperOffersV2.DapperOffer
    >(from: DapperOffersV2.DapperOffersStoragePath)
      ?? panic("Cannot borrow DapperOffer resource")
    dapperOffer.removeOffer(offerId: offerId)
  }
}
`

export const OFFERS_V2_ADDRESS       = "0xb8ea91944fd51c43"
export const TOPSHOT_ROYALTY_ADDRESS = "0xfaf0cc52c6e3acaf"
export const TOPSHOT_ROYALTY_RATE    = 0.05
export const DAPPER_MERCHANT_ADDRESS = "0xc1e4f4f4c4257510"

// FCL usage:
// const txId = await fcl.mutate({
//   cadence: MAKE_OFFER_TOPSHOT_CADENCE,
//   args: (arg, t) => [
//     arg(DAPPER_MERCHANT_ADDRESS, t.Address),  // MUST be first
//     arg("1.00000000",            t.UFix64),   // offerAmount
//     arg("4",                     t.UInt32),   // setId (on-chain integer)
//     arg("37",                    t.UInt32),   // playId (on-chain integer)
//     arg("814c5183-...",          t.String),   // setUuid
//     arg("092685e0-...",          t.String),   // playUuid
//   ],
//   proposer: fcl.authz, payer: fcl.authz, authorizations: [fcl.authz],
//   limit: 9999,
// })
