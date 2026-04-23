import { useCallback } from 'react'
import * as fcl from '@onflow/fcl'
import { useCart, CartItem, PurchaseStatus } from './CartContext'
import { PURCHASE_MOMENT_FLOW_WALLET_CADENCE } from '@/lib/cadence/purchase-moment-flow-wallet'
import { MAKE_OFFER_FLOWTY_CADENCE } from '@/lib/cadence/make-offer-flowty'

const TX_DELAY_MS = 300
const DAPPER_NOT_SUPPORTED_MESSAGE =
  'Dapper cart coming soon — currently Flow Wallet only.'

export type WalletProvider = 'flow_wallet' | 'dapper'

export type ErrorClass =
  | 'dapper_not_supported'
  | 'sniped'
  | 'price_changed'
  | 'insufficient_balance'
  | 'user_rejected'
  | 'unknown'

export interface PurchaseResult {
  item: CartItem
  status: PurchaseStatus
  txId?: string
  error?: string
  errorClass?: ErrorClass
  walletProvider: WalletProvider
  batchId: string
}

export interface PurchaseQueueCallbacks {
  onItemStart?: (item: CartItem) => void
  onItemComplete?: (result: PurchaseResult) => void
  onQueueComplete?: (results: PurchaseResult[]) => void
  /** Optional source page label (e.g. "sniper", "wallet", "sets") for logging. */
  sourcePage?: string
}

function classifyStatus(err: unknown): PurchaseStatus {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (
    lower.includes('listing not found') ||
    lower.includes('could not borrow listing') ||
    lower.includes('already been purchased') ||
    lower.includes('no listing with id')
  ) return 'sniped'
  if (lower.includes('price has changed')) return 'price_changed'
  return 'failed'
}

function classifyErrorClass(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (
    lower.includes('listing not found') ||
    lower.includes('could not borrow listing') ||
    lower.includes('already been purchased') ||
    lower.includes('no listing with id')
  ) return 'sniped'
  if (lower.includes('price has changed')) return 'price_changed'
  if (lower.includes('insufficient') || lower.includes('not enough')) return 'insufficient_balance'
  if (lower.includes('rejected') || lower.includes('declined') || lower.includes('cancelled')) {
    return 'user_rejected'
  }
  return 'unknown'
}

/**
 * Inspects fcl.currentUser services to determine which wallet is connected.
 * Dapper publishes a service with provider.name matching /dapper/i. Everything
 * else (Flow Wallet, Blocto configured against Flow Wallet, etc.) is treated
 * as Flow Wallet for cart purposes.
 */
async function detectWalletProvider(): Promise<WalletProvider> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (fcl.currentUser as any).snapshot()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const services: any[] = snapshot?.services ?? []
    for (const svc of services) {
      const name = svc?.provider?.name ?? svc?.provider?.title ?? ''
      if (typeof name === 'string' && /dapper/i.test(name)) return 'dapper'
    }
    return 'flow_wallet'
  } catch {
    return 'flow_wallet'
  }
}

/**
 * Fire-and-forget POST to /api/cart/record. Never throws — purchase-logging
 * errors must not block the UI path. Callers await only for ordering (so the
 * recorder sees the row before the next purchase result overwrites state).
 */
async function recordPurchaseAttempt(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/cart/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    })
  } catch {
    // swallow — logging failures never block purchase UX
  }
}

async function resolveBuyerAddress(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (fcl.currentUser as any).snapshot()
    return snapshot?.addr ?? null
  } catch {
    return null
  }
}

// FCL's published types don't match the actual runtime shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fclAuthz = fcl.authz as any

function newBatchId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function collectionIdForItem(item: CartItem): string | null {
  // best-effort: CartItem.source is 'sniper'|'wallet'|'sets'|'marketplace'.
  // Collection-id defaults to NBA Top Shot for cart-eligible items. Downstream
  // /api/cart/record will normalize this.
  return '95f28a17-224a-4025-96ad-adf8a4c63bfd'
}

export function usePurchaseQueue() {
  const cart = useCart()

  const executePurchase = useCallback(
    async (
      items: CartItem[],
      callbacks: PurchaseQueueCallbacks = {}
    ): Promise<PurchaseResult[]> => {
      if (items.length === 0) return []
      if (cart.isExecuting) return []

      const { onItemStart, onItemComplete, onQueueComplete, sourcePage } = callbacks
      const results: PurchaseResult[] = []
      const batchId = newBatchId()
      const cartSize = items.length

      cart.setExecuting(true)
      cart.resetStatuses()

      const walletProvider = await detectWalletProvider()
      const buyerAddress = await resolveBuyerAddress()

      // Dapper is not supported yet — fail all items up-front with a clear reason.
      if (walletProvider === 'dapper') {
        for (const item of items) {
          cart.setItemStatus(item.listingResourceID, 'failed')
          onItemStart?.(item)
          const result: PurchaseResult = {
            item,
            status: 'failed',
            error: DAPPER_NOT_SUPPORTED_MESSAGE,
            errorClass: 'dapper_not_supported',
            walletProvider: 'dapper',
            batchId,
          }
          results.push(result)
          onItemComplete?.(result)
          void recordPurchaseAttempt({
            buyer_address: buyerAddress,
            wallet_provider: 'dapper',
            collection_id: collectionIdForItem(item),
            moment_id: item.momentId,
            listing_resource_id: item.listingResourceID,
            storefront_address: item.storefrontAddress,
            expected_price: item.expectedPrice,
            fmv_at_purchase: item.fmv ?? null,
            discount_pct:
              item.fmv && item.expectedPrice
                ? ((item.fmv - item.expectedPrice) / item.fmv) * 100
                : null,
            cart_size: cartSize,
            batch_id: batchId,
            status: 'failed',
            tx_hash: null,
            error_message: DAPPER_NOT_SUPPORTED_MESSAGE,
            error_class: 'dapper_not_supported',
            source_page: sourcePage ?? item.source ?? null,
          })
        }

        cart.setExecuting(false)
        onQueueComplete?.(results)
        return results
      }

      for (const item of items) {
        cart.setItemStatus(item.listingResourceID, 'pending')
        onItemStart?.(item)

        let result: PurchaseResult

        try {
          const priceFixed = item.expectedPrice.toFixed(8)

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const txId: string = await (fcl.mutate as any)({
            cadence: PURCHASE_MOMENT_FLOW_WALLET_CADENCE,
            args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
              arg(item.storefrontAddress, t.Address),
              arg(item.listingResourceID, t.UInt64),
              arg(priceFixed, t.UFix64),
            ],
            proposer: fclAuthz,
            payer: fclAuthz,
            authorizations: [fclAuthz],
            limit: 1000,
          })

          await fcl.tx(txId).onceExecuted()

          result = {
            item,
            status: 'success',
            txId,
            walletProvider,
            batchId,
          }
          cart.setItemStatus(item.listingResourceID, 'success')
        } catch (err) {
          const status = classifyStatus(err)
          const errorClass = classifyErrorClass(err)
          const error = err instanceof Error ? err.message : String(err)

          result = { item, status, error, errorClass, walletProvider, batchId }
          cart.setItemStatus(item.listingResourceID, status)
        }

        void recordPurchaseAttempt({
          buyer_address: buyerAddress,
          wallet_provider: walletProvider,
          collection_id: collectionIdForItem(item),
          moment_id: item.momentId,
          listing_resource_id: item.listingResourceID,
          storefront_address: item.storefrontAddress,
          expected_price: item.expectedPrice,
          fmv_at_purchase: item.fmv ?? null,
          discount_pct:
            item.fmv && item.expectedPrice
              ? ((item.fmv - item.expectedPrice) / item.fmv) * 100
              : null,
          cart_size: cartSize,
          batch_id: batchId,
          status: result.status,
          tx_hash: result.txId ?? null,
          error_message: result.error ?? null,
          error_class: result.errorClass ?? null,
          source_page: sourcePage ?? item.source ?? null,
        })

        results.push(result)
        onItemComplete?.(result)

        if (result.errorClass === 'insufficient_balance') break

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

  // Flowty offers run on a separate Cadence template and do not flow through the
  // DUC purchase path. They stay on their existing wiring.
  const executeOffers = useCallback(
    async (
      items: CartItem[],
      callbacks: PurchaseQueueCallbacks = {}
    ): Promise<PurchaseResult[]> => {
      const offerItems = items.filter(
        (i) => i.cartMode === 'offer' && i.offerAmount && i.offerAmount > 0
      )
      if (offerItems.length === 0) return []
      if (cart.isExecuting) return []

      const { onItemStart, onItemComplete, onQueueComplete } = callbacks
      const results: PurchaseResult[] = []
      const batchId = newBatchId()

      cart.setExecuting(true)
      cart.resetStatuses()

      const walletProvider = await detectWalletProvider()

      for (const item of offerItems) {
        cart.setItemStatus(item.listingResourceID, 'pending')
        onItemStart?.(item)

        let result: PurchaseResult

        try {
          const amountFixed = item.offerAmount!.toFixed(8)
          const expiry = String(
            item.offerExpiry ?? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
          )

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const txId: string = await (fcl.mutate as any)({
            cadence: MAKE_OFFER_FLOWTY_CADENCE,
            args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
              arg(String(item.momentId), t.UInt64),
              arg(amountFixed, t.UFix64),
              arg(item.storefrontAddress, t.Address),
              arg(expiry, t.UInt64),
              arg('1', t.UInt64),
            ],
            proposer: fclAuthz,
            payer: fclAuthz,
            authorizations: [fclAuthz],
            limit: 1000,
          })

          await fcl.tx(txId).onceExecuted()

          result = { item, status: 'success', txId, walletProvider, batchId }
          cart.setItemStatus(item.listingResourceID, 'success')
        } catch (err) {
          const status = classifyStatus(err)
          const errorClass = classifyErrorClass(err)
          const error = err instanceof Error ? err.message : String(err)
          result = { item, status, error, errorClass, walletProvider, batchId }
          cart.setItemStatus(item.listingResourceID, status)
          if (errorClass === 'insufficient_balance') {
            results.push(result)
            onItemComplete?.(result)
            break
          }
        }

        results.push(result)
        onItemComplete?.(result)

        if (offerItems.indexOf(item) < offerItems.length - 1) {
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
    executeOffers,
    isExecuting: cart.isExecuting,
    purchaseStatus: cart.purchaseStatus,
  }
}
