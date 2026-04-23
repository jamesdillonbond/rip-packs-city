'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCart, CartItem, PurchaseStatus } from '@/lib/cart/CartContext'
import { usePurchaseQueue } from '@/lib/cart/usePurchaseQueue'
import { useFlowUser, WalletProvider } from '@/lib/hooks/useFlowUser'
import { useFlowWalletBalances } from '@/lib/hooks/useFlowWalletBalances'

interface ValidationResult {
  exists: boolean
  currentPrice: number | null
  sellerAddress: string | null
  priceChanged: boolean
  sniped: boolean
  error?: string
}

type ValidationMap = Record<string, ValidationResult>

const ValidationContext = React.createContext<{
  results: ValidationMap
  revalidate: (items: CartItem[]) => Promise<void>
  isValidating: boolean
}>({ results: {}, revalidate: async () => {}, isValidating: false })

function useCartValidationProvider(items: CartItem[], open: boolean) {
  const [results, setResults] = useState<ValidationMap>({})
  const [isValidating, setIsValidating] = useState(false)

  const revalidate = useCallback(async (toCheck: CartItem[]) => {
    const filtered = toCheck.filter(
      (i) => i.cartMode !== 'offer' && i.listingResourceID && i.storefrontAddress
    )
    if (filtered.length === 0) {
      setResults({})
      return
    }
    setIsValidating(true)
    try {
      const res = await fetch('/api/cart/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: filtered.map((i) => ({
            listingResourceID: i.listingResourceID,
            storefrontAddress: i.storefrontAddress,
            expectedPrice: i.expectedPrice,
          })),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setResults(data?.results ?? {})
      }
    } catch {
      // network failures leave existing results in place
    } finally {
      setIsValidating(false)
    }
  }, [])

  // revalidate when the drawer opens
  useEffect(() => {
    if (open) void revalidate(items)
    // We intentionally do not include items in deps — we don't want to thrash
    // Flow REST on every cart mutation. revalidate explicitly runs on open and
    // before Buy All.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, revalidate])

  return { results, revalidate, isValidating }
}

function StaleWarningBadge({ result }: { result: ValidationResult | undefined }) {
  if (!result) return null
  if (result.sniped) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30"
        title="This listing is no longer available on-chain."
      >
        ⚡ Sniped on-chain
      </span>
    )
  }
  if (result.priceChanged && result.currentPrice != null) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-orange-500/20 text-orange-300 border border-orange-500/30"
        title="The seller changed the price after you added this to your cart."
      >
        ⚠ Price now ${result.currentPrice.toFixed(2)}
      </span>
    )
  }
  return null
}

function formatPrice(n: number) {
  return `$${n.toFixed(2)}`
}

function fmvDelta(price: number, fmv: number | null): React.ReactNode {
  if (!fmv || fmv === 0) return null
  const pct = ((price - fmv) / fmv) * 100
  const isDiscount = pct < 0
  const label = isDiscount
    ? `${Math.abs(pct).toFixed(0)}% below FMV`
    : `${pct.toFixed(0)}% above FMV`
  return (
    <span className={`text-xs font-medium ${isDiscount ? 'text-emerald-400' : 'text-orange-400'}`}>
      {label}
    </span>
  )
}

// Returns true if an item requires Dapper Wallet to purchase
function isDapperOnly(item: CartItem): boolean {
  return item.paymentToken === 'DUC' || item.paymentToken === 'FUT'
}

// Returns true if an item can be purchased with a Flow Wallet
function isFlowCompatible(item: CartItem): boolean {
  return item.paymentToken === 'FLOW' || item.paymentToken === 'USDC_E'
}

function StatusBadge({ status }: { status: PurchaseStatus }) {
  if (status === 'idle') return null

  const config: Record<
    Exclude<PurchaseStatus, 'idle'>,
    { label: string; classes: string; pulse?: boolean }
  > = {
    pending:       { label: 'Buying…',          classes: 'bg-blue-500/20 text-blue-300 border border-blue-500/30', pulse: true },
    success:       { label: '✓ Purchased',      classes: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' },
    failed:        { label: '✗ Failed',         classes: 'bg-red-500/20 text-red-300 border border-red-500/30' },
    sniped:        { label: '⚡ Sniped',        classes: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
    price_changed: { label: '⚠ Price changed', classes: 'bg-orange-500/20 text-orange-300 border border-orange-500/30' },
  }

  const { label, classes, pulse } = config[status]

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${classes} ${pulse ? 'animate-pulse' : ''}`}>
      {label}
    </span>
  )
}

function WalletIncompatibleBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-slate-500/20 text-slate-400 border border-slate-500/30"
      title="This listing accepts DUC/FUT payment which requires a Dapper Wallet"
    >
      Requires Dapper Wallet
    </span>
  )
}

interface CartRowProps {
  item: CartItem
  walletProvider: WalletProvider
}

function CartRow({ item, walletProvider }: CartRowProps) {
  const { removeFromCart, purchaseStatus, isExecuting } = useCart()
  const { buyOne } = usePurchaseQueue()
  const { results: validationResults } = React.useContext(ValidationContext)
  const validation = validationResults[item.listingResourceID]
  const status = purchaseStatus[item.listingResourceID] ?? 'idle'

  // If connected with Flow Wallet, Dapper-only items are incompatible
  const isNonDapper = walletProvider !== 'dapper' && walletProvider !== 'unknown'
  const incompatible = isNonDapper && isDapperOnly(item)

  const tierColors: Record<string, string> = {
    ULTIMATE: 'text-yellow-400',
    LEGENDARY: 'text-orange-400',
    RARE:      'text-purple-400',
    UNCOMMON:  'text-teal-400',
    FANDOM:    'text-blue-400',
    COMMON:    'text-slate-400',
  }

  const tierColor = tierColors[item.tier?.toUpperCase()] ?? 'text-slate-400'

  return (
    <div
      className={`flex items-start gap-3 rounded-lg p-3 transition-colors ${
        status === 'success'
          ? 'bg-emerald-500/10 border border-emerald-500/20'
          : status === 'failed' || status === 'sniped' || status === 'price_changed'
          ? 'bg-red-500/10 border border-red-500/20'
          : incompatible
          ? 'bg-white/[0.02] border border-white/5 opacity-60'
          : 'bg-white/5 border border-white/10 hover:bg-white/[0.07]'
      }`}
    >
      <div className="flex-shrink-0 w-12 h-12 rounded-md overflow-hidden bg-white/10">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.playerName} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 text-xs">?</div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate leading-tight">{item.playerName}</p>
            <p className="text-xs text-slate-400 truncate leading-tight mt-0.5">{item.setName}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-slate-500">#{item.serialNumber}/{item.totalEditions}</span>
              <span className={`text-xs font-medium ${tierColor}`}>{item.tier}</span>
              {fmvDelta(item.expectedPrice, item.fmv)}
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-sm font-bold text-white tabular-nums">{formatPrice(item.expectedPrice)}</p>
            {item.fmv && (
              <p className="text-xs text-slate-500 tabular-nums">FMV {formatPrice(item.fmv)}</p>
            )}
          </div>
        </div>

        {/* Wallet incompatibility badge */}
        {incompatible && status === 'idle' && (
          <div className="mt-2">
            <WalletIncompatibleBadge />
          </div>
        )}

        {status !== 'idle' && (
          <div className="mt-2">
            <StatusBadge status={status} />
          </div>
        )}

        {status === 'idle' && (validation?.sniped || validation?.priceChanged) && (
          <div className="mt-2">
            <StaleWarningBadge result={validation} />
          </div>
        )}

        {/* Per-item Buy button for Flow Wallet compatible items */}
        {!isExecuting && status === 'idle' && !incompatible && isNonDapper && isFlowCompatible(item) && (
          <button
            onClick={() => buyOne(item)}
            className="mt-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-1 transition"
          >
            Buy — {formatPrice(item.expectedPrice)}
          </button>
        )}
      </div>

      {!isExecuting && status === 'idle' && (
        <button
          onClick={() => removeFromCart(item.listingResourceID)}
          className="flex-shrink-0 text-slate-500 hover:text-red-400 transition-colors p-1 -m-1 mt-0.5"
          aria-label="Remove from cart"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      )}
    </div>
  )
}

function CartSummary() {
  const { items, totalPrice, purchaseStatus } = useCart()
  const { buyAll, executePurchase, executeOffers, isExecuting } = usePurchaseQueue()
  const { user, logIn } = useFlowUser()
  const { flowBalance, usdcBalance, isLoading: balancesLoading, refetch: refetchBalances } = useFlowWalletBalances()
  const { revalidate } = React.useContext(ValidationContext)

  const successCount = Object.values(purchaseStatus).filter((s) => s === 'success').length
  const failedCount = Object.values(purchaseStatus).filter(
    (s) => s === 'failed' || s === 'sniped' || s === 'price_changed'
  ).length
  const hasResults = successCount + failedCount > 0 && !isExecuting

  const pendingItems = items.filter(
    (i) => !purchaseStatus[i.listingResourceID] || purchaseStatus[i.listingResourceID] === 'idle'
  )

  // Split pending items into buy and offer items
  const pendingBuyItems = pendingItems.filter((i) => i.cartMode !== 'offer')
  const pendingOfferItems = pendingItems.filter((i) => i.cartMode === 'offer')

  const isConnected = user.loggedIn === true
  const isNonDapper = user.walletProvider !== 'dapper' && user.walletProvider !== 'unknown'

  // When connected with Flow Wallet, split buy items by compatibility
  const flowCompatibleItems = isNonDapper
    ? pendingBuyItems.filter((i) => isFlowCompatible(i))
    : pendingBuyItems
  const skippedCount = isNonDapper
    ? pendingBuyItems.filter((i) => isDapperOnly(i)).length
    : 0

  const buyableTotal = flowCompatibleItems.reduce((s, i) => s + i.expectedPrice, 0)

  // Calculate totals per token type for Flow Wallet balance checks (buys only)
  const flowItemsTotal = isNonDapper
    ? flowCompatibleItems.filter((i) => i.paymentToken === 'FLOW').reduce((s, i) => s + i.expectedPrice, 0)
    : 0
  const usdcBuyTotal = isNonDapper
    ? flowCompatibleItems.filter((i) => i.paymentToken === 'USDC_E').reduce((s, i) => s + i.expectedPrice, 0)
    : 0

  // Offer totals (always USDC.e)
  const offerTotal = pendingOfferItems.reduce((s, i) => s + (i.offerAmount ?? 0), 0)
  const totalUsdcNeeded = usdcBuyTotal + offerTotal

  const hasFlowItems = flowItemsTotal > 0
  const hasUsdcItems = usdcBuyTotal > 0 || offerTotal > 0
  const showBalances = isConnected && isNonDapper && (hasFlowItems || hasUsdcItems)

  const insufficientFlow = hasFlowItems && flowItemsTotal > flowBalance
  const insufficientUsdc = hasUsdcItems && totalUsdcNeeded > usdcBalance
  const hasInsufficientBalance = showBalances && !balancesLoading && (insufficientFlow || insufficientUsdc)

  // Re-fetch balances after purchases complete
  const prevHasResults = React.useRef(false)
  React.useEffect(() => {
    if (hasResults && !prevHasResults.current && successCount > 0) {
      refetchBalances()
    }
    prevHasResults.current = hasResults
  }, [hasResults, successCount, refetchBalances])

  return (
    <div className="border-t border-white/10 p-4 space-y-3">
      {/* Flow Wallet balance row */}
      {showBalances && (
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 space-y-1">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Wallet Balance</p>
          <div className="flex items-center gap-4 text-sm">
            {hasFlowItems && (
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="12" fill="#00EF8B" />
                  <path d="M17.4 9.6h-3v-3a.6.6 0 0 0-.6-.6h-3a.6.6 0 0 0-.6.6v3h-3a.6.6 0 0 0-.6.6v3a.6.6 0 0 0 .6.6h3v3a.6.6 0 0 0 .6.6h3a.6.6 0 0 0 .6-.6v-3h3a.6.6 0 0 0 .6-.6v-3a.6.6 0 0 0-.6-.6z" fill="#fff" />
                </svg>
                <span className={`font-semibold tabular-nums ${insufficientFlow ? 'text-amber-400' : 'text-white'}`}>
                  {balancesLoading ? '...' : flowBalance.toFixed(2)}
                </span>
                <span className="text-slate-500 text-xs">FLOW</span>
              </div>
            )}
            {hasUsdcItems && (
              <div className="flex items-center gap-1.5">
                <span className="flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-white text-[10px] font-bold flex-shrink-0">$</span>
                <span className={`font-semibold tabular-nums ${insufficientUsdc ? 'text-amber-400' : 'text-white'}`}>
                  {balancesLoading ? '...' : usdcBalance.toFixed(2)}
                </span>
                <span className="text-slate-500 text-xs">USDC.e</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Insufficient balance warning */}
      {hasInsufficientBalance && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-300">
          {insufficientUsdc && offerTotal > 0
            ? `Insufficient USDC.e balance for buys + offers (need ${formatPrice(totalUsdcNeeded)}).`
            : 'Insufficient balance to complete all Flow Wallet items.'}
        </div>
      )}

      {hasResults && (
        <div className="rounded-lg bg-white/5 px-3 py-2 text-sm text-slate-300">
          {successCount > 0 && <span className="text-emerald-400 font-medium">{successCount} completed</span>}
          {successCount > 0 && failedCount > 0 && <span className="text-slate-500 mx-1">·</span>}
          {failedCount > 0 && <span className="text-red-400 font-medium">{failedCount} failed or sniped</span>}
        </div>
      )}

      {/* Buy items section */}
      {pendingBuyItems.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">{pendingBuyItems.length} buy item{pendingBuyItems.length !== 1 ? 's' : ''}</span>
          <span className="font-bold text-white tabular-nums">
            {formatPrice(pendingBuyItems.reduce((s, i) => s + i.expectedPrice, 0))}
          </span>
        </div>
      )}

      {/* Skipped items notice for Flow Wallet users */}
      {skippedCount > 0 && isConnected && !isExecuting && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-300">
          {skippedCount} item{skippedCount !== 1 ? 's' : ''} require{skippedCount === 1 ? 's' : ''} Dapper Wallet and will be skipped.
        </div>
      )}

      {pendingItems.length > 0 && !isExecuting && !isConnected && (
        <button
          onClick={logIn}
          className="w-full rounded-lg border border-white/20 bg-white/5 text-slate-300 font-semibold py-3 px-4 transition hover:bg-white/10 text-sm"
        >
          Connect Wallet to Purchase
        </button>
      )}

      {flowCompatibleItems.length > 0 && !isExecuting && isConnected && (
        <button
          onClick={async () => {
            // Revalidate on-chain state before signing — users have seen the
            // stale warnings; refresh them one last time in case a snipe
            // happened while the drawer was open.
            await revalidate(flowCompatibleItems)
            if (isNonDapper) {
              executePurchase(flowCompatibleItems, {
                onItemComplete: (result) => {
                  console.log('[RPC Cart] item complete', result.status, result.item.momentId)
                },
                onQueueComplete: (results) => {
                  console.log('[RPC Cart] queue complete', results)
                },
              })
            } else {
              buyAll({
                onItemComplete: (result) => {
                  console.log('[RPC Cart] item complete', result.status, result.item.momentId)
                },
                onQueueComplete: (results) => {
                  console.log('[RPC Cart] queue complete', results)
                },
              })
            }
          }}
          className="w-full rounded-lg bg-[#e84c4c] hover:bg-[#d94444] active:bg-[#c93c3c] text-white font-semibold py-3 px-4 transition text-sm"
        >
          Buy {flowCompatibleItems.length > 1 ? `All ${flowCompatibleItems.length}` : ''} — {formatPrice(buyableTotal)}
          {skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}
        </button>
      )}

      {/* All items are Dapper-only and user has Flow Wallet */}
      {flowCompatibleItems.length === 0 && pendingBuyItems.length > 0 && !isExecuting && isConnected && isNonDapper && (
        <div className="w-full rounded-lg bg-white/5 border border-white/10 text-slate-400 font-medium py-3 px-4 text-sm text-center">
          All items require Dapper Wallet
        </div>
      )}

      {/* ── Offers section ── */}
      {pendingOfferItems.length > 0 && (
        <div className="border-t border-white/10 pt-3 space-y-2">
          <p className="text-xs font-medium text-blue-400 uppercase tracking-wide">Offers ({pendingOfferItems.length})</p>
          {pendingOfferItems.map((item) => {
            const status = purchaseStatus[item.listingResourceID] ?? 'idle'
            const expiryDate = item.offerExpiry
              ? new Date(item.offerExpiry * 1000).toLocaleDateString()
              : '—'
            return (
              <div key={item.listingResourceID} className="flex items-center justify-between gap-2 rounded-lg bg-blue-500/5 border border-blue-500/15 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{item.playerName}</p>
                  <p className="text-xs text-slate-500 truncate">{item.setName} #{item.serialNumber}</p>
                  {status !== 'idle' && <StatusBadge status={status} />}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-blue-300 tabular-nums">
                    {formatPrice(item.offerAmount ?? 0)} <span className="text-xs text-slate-500">USDC.e</span>
                  </p>
                  <p className="text-xs text-slate-500">exp {expiryDate}</p>
                </div>
              </div>
            )
          })}
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">Total offers</span>
            <span className="font-bold text-blue-300 tabular-nums">{formatPrice(offerTotal)} USDC.e</span>
          </div>
          {isConnected && isNonDapper && !isExecuting && (
            <button
              onClick={() => {
                executeOffers(pendingOfferItems, {
                  onItemComplete: (result) => {
                    console.log('[RPC Cart] offer complete', result.status, result.item.momentId)
                  },
                  onQueueComplete: (results) => {
                    console.log('[RPC Cart] offers queue complete', results)
                  },
                })
              }}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold py-3 px-4 transition text-sm"
            >
              Submit All {pendingOfferItems.length} Offer{pendingOfferItems.length !== 1 ? 's' : ''} — {formatPrice(offerTotal)}
            </button>
          )}
        </div>
      )}

      {isExecuting && (
        <div className="w-full rounded-lg bg-white/10 text-slate-400 font-semibold py-3 px-4 text-sm text-center">
          <span className="inline-flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
            Processing…
          </span>
        </div>
      )}

      {!isExecuting && items.length > 0 && (
        <p className="text-xs text-slate-500 text-center leading-snug">
          Listings may be purchased by others between now and checkout.
          RPC verifies prices before each transaction.
        </p>
      )}
    </div>
  )
}

interface CartDrawerProps {
  open: boolean
  onClose: () => void
}

export function CartDrawer({ open, onClose }: CartDrawerProps) {
  const { items, clearCart, removeCompleted, purchaseStatus, isExecuting } = useCart()
  const { user } = useFlowUser()
  const drawerRef = useRef<HTMLDivElement>(null)
  const validation = useCartValidationProvider(items, open)

  const hasCompletedItems = Object.values(purchaseStatus).some((s) => s === 'success')

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <ValidationContext.Provider value={validation}>
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={drawerRef}
        role="dialog"
        aria-label="Shopping cart"
        aria-modal="true"
        className={`fixed top-0 right-0 z-50 h-full w-full max-w-sm flex flex-col
          bg-[#0f1117] border-l border-white/10 shadow-2xl
          transition-transform duration-300 ease-in-out
          ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-white">Cart</h2>
            {items.length > 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#e84c4c] text-white text-xs font-bold tabular-nums">
                {items.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasCompletedItems && !isExecuting && (
              <button onClick={removeCompleted} className="text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/10">
                Clear purchased
              </button>
            )}
            {items.length > 0 && !isExecuting && (
              <button onClick={clearCart} className="text-xs text-slate-500 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-white/5">
                Clear all
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1.5 rounded hover:bg-white/10" aria-label="Close cart">
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="text-4xl mb-3">🛒</div>
              <p className="text-slate-400 text-sm font-medium">Your cart is empty</p>
              <p className="text-slate-500 text-xs mt-1">Add moments from the Sniper or your Wallet</p>
            </div>
          ) : (
            <>
              {/* Buy items */}
              {items.filter((i) => i.cartMode !== 'offer').length > 0 && (
                <div className="space-y-2">
                  {items.filter((i) => i.cartMode !== 'offer').map((item) => (
                    <CartRow
                      key={item.listingResourceID}
                      item={item}
                      walletProvider={user.walletProvider}
                    />
                  ))}
                </div>
              )}

              {/* Offer items — shown in a separate section */}
              {items.filter((i) => i.cartMode === 'offer').length > 0 && (
                <div className="space-y-2">
                  {items.filter((i) => i.cartMode !== 'offer').length > 0 && (
                    <div className="flex items-center gap-2 pt-2">
                      <div className="flex-1 h-px bg-blue-500/20" />
                      <span className="text-xs font-medium text-blue-400 uppercase tracking-wide">Offers</span>
                      <div className="flex-1 h-px bg-blue-500/20" />
                    </div>
                  )}
                  {items.filter((i) => i.cartMode === 'offer').map((item) => (
                    <CartRow
                      key={item.listingResourceID}
                      item={item}
                      walletProvider={user.walletProvider}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {items.length > 0 && <CartSummary />}
      </div>
    </ValidationContext.Provider>
  )
}
