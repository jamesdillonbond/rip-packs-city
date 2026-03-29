import { useCallback } from 'react'
import * as fcl from '@onflow/fcl'
import { useCart, CartItem, PurchaseStatus } from './CartContext'

const DAPPER_MERCHANT_ADDRESS = '0xc1e4f4f4c4257510'
const TX_DELAY_MS = 300

const PURCHASE_MOMENT_CADENCE = `
import DapperUtilityCoin from 0xead892083b3e2c6c
import FungibleToken from 0xf233dcee88fe0abe
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import NFTStorefrontV2 from 0x3cdbb3d569211ff3
import TopShot from 0x0b2a3299cc857e29

transaction(
  merchantAccountAddress: Address,
  storefrontAddress: Address,
  listingResourceID: UInt64,
  expectedPrice: UFix64,
  commissionRecipient: Address?
) {
  let paymentVault: @FungibleToken.Vault
  let nftCollection: &TopShot.Collection{NonFungibleToken.Receiver}
  let storefront: &NFTStorefrontV2.Storefront{NFTStorefrontV2.StorefrontPublic}
  let listing: &NFTStorefrontV2.Listing{NFTStorefrontV2.ListingPublic}
  let balanceBeforeTransfer: UFix64
  let mainDUCVault: &DapperUtilityCoin.Vault
  var commissionRecipientCap: Capability<&{FungibleToken.Receiver}>?

  prepare(dapper: &Account, buyer: auth(BorrowValue) &Account) {
    assert(
      dapper.address == merchantAccountAddress,
      message: "Signer is not the declared merchant account"
    )

    self.mainDUCVault = dapper.borrow<&DapperUtilityCoin.Vault>(
      from: /storage/dapperUtilityCoinVault
    ) ?? panic("Cannot borrow DapperUtilityCoin vault from Dapper account")

    self.balanceBeforeTransfer = self.mainDUCVault.balance

    self.storefront = getAccount(storefrontAddress)
      .getCapability<&NFTStorefrontV2.Storefront{NFTStorefrontV2.StorefrontPublic}>(
        NFTStorefrontV2.StorefrontPublicPath
      )
      .borrow()
      ?? panic("Could not borrow storefront from address")

    self.listing = self.storefront.borrowListing(listingResourceID: listingResourceID)
      ?? panic("Listing not found — it may have already been purchased")

    let listingDetails = self.listing.getDetails()
    let salePrice = listingDetails.salePrice

    assert(
      salePrice == expectedPrice,
      message: "Listing price has changed"
    )

    assert(
      listingDetails.salePaymentVaultType == Type<@DapperUtilityCoin.Vault>(),
      message: "Listing does not accept DUC payment"
    )

    self.paymentVault <- self.mainDUCVault.withdraw(amount: salePrice)

    self.nftCollection = buyer.borrow<&TopShot.Collection{NonFungibleToken.Receiver}>(
      from: /storage/MomentCollection
    ) ?? panic("Buyer does not have a Top Shot collection")

    self.commissionRecipientCap = nil
    let commissionAmount = listingDetails.commissionAmount

    if commissionRecipient != nil && commissionAmount != 0.0 {
      let cap = getAccount(commissionRecipient!)
        .getCapability<&{FungibleToken.Receiver}>(/public/dapperUtilityCoinReceiver)
      assert(cap.check(), message: "Commission recipient does not have a valid DUC receiver")
      self.commissionRecipientCap = cap
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

  post {
    self.mainDUCVault.balance == self.balanceBeforeTransfer - expectedPrice:
      "DUC leak detected"
  }
}
`

export interface PurchaseResult {
  item: CartItem
  status: PurchaseStatus
  txId?: string
  error?: string
}

export interface PurchaseQueueCallbacks {
  onItemStart?: (item: CartItem) => void
  onItemComplete?: (result: PurchaseResult) => void
  onQueueComplete?: (results: PurchaseResult[]) => void
}

function classifyError(err: unknown): PurchaseStatus {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (
    lower.includes('listing not found') ||
    lower.includes('could not borrow listing') ||
    lower.includes('already been purchased')
  ) return 'sniped'
  if (lower.includes('price has changed')) return 'price_changed'
  return 'failed'
}

// FCL's published types don't always match the actual runtime shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fclAuthz = fcl.authz as any

export function usePurchaseQueue() {
  const cart = useCart()

  const executePurchase = useCallback(
    async (
      items: CartItem[],
      callbacks: PurchaseQueueCallbacks = {}
    ): Promise<PurchaseResult[]> => {
      if (items.length === 0) return []
      if (cart.isExecuting) return []

      const { onItemStart, onItemComplete, onQueueComplete } = callbacks
      const results: PurchaseResult[] = []

      cart.setExecuting(true)
      cart.resetStatuses()

      for (const item of items) {
        cart.setItemStatus(item.listingResourceID, 'pending')
        onItemStart?.(item)

        let result: PurchaseResult

        try {
          const priceFixed = item.expectedPrice.toFixed(8)

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const txId: string = await (fcl.mutate as any)({
            cadence: PURCHASE_MOMENT_CADENCE,
            args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
              arg(DAPPER_MERCHANT_ADDRESS, t.Address),
              arg(item.storefrontAddress, t.Address),
              arg(item.listingResourceID, t.UInt64),
              arg(priceFixed, t.UFix64),
              arg(item.commissionRecipient, t.Optional(t.Address)),
            ],
            proposer: fclAuthz,
            payer: fclAuthz,
            authorizations: [fclAuthz],
            limit: 1000,
          })

          await fcl.tx(txId).onceExecuted()

          result = { item, status: 'success', txId }
          cart.setItemStatus(item.listingResourceID, 'success')
        } catch (err) {
          const status = classifyError(err)
          const error = err instanceof Error ? err.message : String(err)

          result = { item, status, error }
          cart.setItemStatus(item.listingResourceID, status)

          const lower = error.toLowerCase()
          if (lower.includes('insufficient') || lower.includes('not enough')) {
            results.push(result)
            onItemComplete?.(result)
            break
          }
        }

        results.push(result)
        onItemComplete?.(result)

        if (items.indexOf(item) < items.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, TX_DELAY_MS))
        }
      }

      cart.setExecuting(false)
      onQueueComplete?.(results)
      return results
    },
    [cart]
  )

  const buyAll = useCallback(
    (callbacks?: PurchaseQueueCallbacks) => executePurchase(cart.items, callbacks),
    [cart.items, executePurchase]
  )

  const buyOne = useCallback(
    (item: CartItem, callbacks?: PurchaseQueueCallbacks) => executePurchase([item], callbacks),
    [executePurchase]
  )

  return {
    buyAll,
    buyOne,
    executePurchase,
    isExecuting: cart.isExecuting,
    purchaseStatus: cart.purchaseStatus,
  }
}