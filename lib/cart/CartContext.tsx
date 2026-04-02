'use client'

import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useCallback,
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CartMode = 'buy' | 'offer'

export interface CartItem {
  // Listing identity
  listingResourceID: string   // UInt64 as string (FCL arg)
  storefrontAddress: string   // seller's Flow address
  expectedPrice: number       // in USD (DUC units, e.g. 12.50)
  commissionRecipient: string | null  // marketplace address, null if 0%

  // Display metadata (populated at add-to-cart time, never stale critical)
  momentId: number
  playerName: string
  setName: string
  serialNumber: number
  totalEditions: number
  tier: string
  thumbnailUrl: string | null
  fmv: number | null          // FMV at time of add — informational only
  source: 'sniper' | 'wallet' | 'sets' | 'marketplace'
  paymentToken: 'DUC' | 'FUT' | 'FLOW' | 'USDC_E'

  // Cart mode: "buy" (default) or "offer" (Flowty offer via USDC.e)
  cartMode: CartMode

  // Offer-specific fields (only used when cartMode === 'offer')
  offerAmount?: number        // USDC.e amount to offer
  offerExpiry?: number        // Unix timestamp when the offer expires

  // Cart bookkeeping
  addedAt: number             // Date.now()
}

export type PurchaseStatus =
  | 'idle'
  | 'pending'    // FCL mutate submitted, awaiting execution
  | 'success'
  | 'failed'
  | 'sniped'     // listing no longer exists
  | 'price_changed'

export interface CartState {
  items: CartItem[]
  // Per-item status during an active purchase run (keyed by listingResourceID)
  purchaseStatus: Record<string, PurchaseStatus>
  isExecuting: boolean
}

type CartAction =
  | { type: 'ADD_ITEM'; item: CartItem }
  | { type: 'REMOVE_ITEM'; listingResourceID: string }
  | { type: 'CLEAR_CART' }
  | { type: 'SET_ITEM_STATUS'; listingResourceID: string; status: PurchaseStatus }
  | { type: 'SET_EXECUTING'; value: boolean }
  | { type: 'RESET_STATUSES' }
  | { type: 'HYDRATE'; items: CartItem[] }
  | { type: 'SET_OFFER_MODE'; listingResourceID: string; cartMode: CartMode; offerAmount?: number; offerExpiry?: number }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'rpc_cart_v1'
const MAX_CART_SIZE = 20

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, items: action.items }

    case 'ADD_ITEM': {
      // Deduplicate by listingResourceID
      const alreadyIn = state.items.some(
        (i) => i.listingResourceID === action.item.listingResourceID
      )
      if (alreadyIn) return state
      if (state.items.length >= MAX_CART_SIZE) return state
      return { ...state, items: [...state.items, action.item] }
    }

    case 'REMOVE_ITEM':
      return {
        ...state,
        items: state.items.filter(
          (i) => i.listingResourceID !== action.listingResourceID
        ),
      }

    case 'CLEAR_CART':
      return { ...state, items: [], purchaseStatus: {}, isExecuting: false }

    case 'SET_ITEM_STATUS':
      return {
        ...state,
        purchaseStatus: {
          ...state.purchaseStatus,
          [action.listingResourceID]: action.status,
        },
      }

    case 'SET_EXECUTING':
      return { ...state, isExecuting: action.value }

    case 'RESET_STATUSES':
      return { ...state, purchaseStatus: {}, isExecuting: false }

    case 'SET_OFFER_MODE':
      return {
        ...state,
        items: state.items.map((i) =>
          i.listingResourceID === action.listingResourceID
            ? {
                ...i,
                cartMode: action.cartMode,
                offerAmount: action.offerAmount,
                offerExpiry: action.offerExpiry,
              }
            : i
        ),
      }

    default:
      return state
  }
}

const initialState: CartState = {
  items: [],
  purchaseStatus: {},
  isExecuting: false,
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CartContextValue extends CartState {
  addToCart: (item: Omit<CartItem, 'addedAt'>) => void
  addOffer: (item: Omit<CartItem, 'addedAt' | 'cartMode'> & { offerAmount: number; offerExpiry: number }) => void
  removeFromCart: (listingResourceID: string) => void
  clearCart: () => void
  isInCart: (listingResourceID: string) => boolean
  totalPrice: number
  itemCount: number
  setItemStatus: (listingResourceID: string, status: PurchaseStatus) => void
  setOfferMode: (listingResourceID: string, cartMode: CartMode, offerAmount?: number, offerExpiry?: number) => void
  setExecuting: (value: boolean) => void
  resetStatuses: () => void
  /** Remove successfully purchased items from cart after a run completes */
  removeCompleted: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, initialState)

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as CartItem[]
        if (Array.isArray(parsed)) {
          // Drop items older than 24h — listings expire
          const cutoff = Date.now() - 24 * 60 * 60 * 1000
          const fresh = parsed.filter((i) => i.addedAt > cutoff)
          dispatch({ type: 'HYDRATE', items: fresh })
        }
      }
    } catch {
      // Corrupted storage — start fresh
      localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  // Persist to localStorage whenever items change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items))
    } catch {
      // Storage full or unavailable — silently skip
    }
  }, [state.items])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addToCart = useCallback((item: Omit<CartItem, 'addedAt'>) => {
    dispatch({ type: 'ADD_ITEM', item: { ...item, cartMode: item.cartMode ?? 'buy', addedAt: Date.now() } })
  }, [])

  const addOffer = useCallback(
    (item: Omit<CartItem, 'addedAt' | 'cartMode'> & { offerAmount: number; offerExpiry: number }) => {
      dispatch({
        type: 'ADD_ITEM',
        item: { ...item, cartMode: 'offer', addedAt: Date.now() },
      })
    },
    []
  )

  const removeFromCart = useCallback((listingResourceID: string) => {
    dispatch({ type: 'REMOVE_ITEM', listingResourceID })
  }, [])

  const clearCart = useCallback(() => {
    dispatch({ type: 'CLEAR_CART' })
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  const isInCart = useCallback(
    (listingResourceID: string) =>
      state.items.some((i) => i.listingResourceID === listingResourceID),
    [state.items]
  )

  const setItemStatus = useCallback(
    (listingResourceID: string, status: PurchaseStatus) => {
      dispatch({ type: 'SET_ITEM_STATUS', listingResourceID, status })
    },
    []
  )

  const setOfferMode = useCallback(
    (listingResourceID: string, cartMode: CartMode, offerAmount?: number, offerExpiry?: number) => {
      dispatch({ type: 'SET_OFFER_MODE', listingResourceID, cartMode, offerAmount, offerExpiry })
    },
    []
  )

  const setExecuting = useCallback((value: boolean) => {
    dispatch({ type: 'SET_EXECUTING', value })
  }, [])

  const resetStatuses = useCallback(() => {
    dispatch({ type: 'RESET_STATUSES' })
  }, [])

  const removeCompleted = useCallback(() => {
    const successIds = Object.entries(state.purchaseStatus)
      .filter(([, status]) => status === 'success')
      .map(([id]) => id)

    for (const id of successIds) {
      dispatch({ type: 'REMOVE_ITEM', listingResourceID: id })
    }
  }, [state.purchaseStatus])

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const totalPrice = state.items.reduce((sum, i) => sum + i.expectedPrice, 0)
  const itemCount = state.items.length

  return (
    <CartContext.Provider
      value={{
        ...state,
        addToCart,
        addOffer,
        removeFromCart,
        clearCart,
        isInCart,
        totalPrice,
        itemCount,
        setItemStatus,
        setOfferMode,
        setExecuting,
        resetStatuses,
        removeCompleted,
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>')
  return ctx
}