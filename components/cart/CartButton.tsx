'use client'

import React, { useState } from 'react'
import { useCart } from '@/lib/cart/CartContext'
import { CartDrawer } from './CartDrawer'

export function CartButton() {
  const { itemCount } = useCart()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg
          text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        aria-label={`Cart — ${itemCount} item${itemCount !== 1 ? 's' : ''}`}
      >
        {/* Cart icon */}
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
        </svg>

        {/* Badge */}
        {itemCount > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center
            min-w-[18px] h-[18px] rounded-full bg-[#e84c4c] text-white text-[10px] font-bold
            tabular-nums px-1 leading-none ring-2 ring-[#0f1117]">
            {itemCount > 99 ? '99+' : itemCount}
          </span>
        )}
      </button>

      <CartDrawer open={open} onClose={() => setOpen(false)} />
    </>
  )
}