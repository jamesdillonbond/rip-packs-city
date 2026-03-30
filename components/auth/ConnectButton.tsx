'use client'

import React from 'react'
import { useFlowUser } from '@/lib/hooks/useFlowUser'

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function ConnectButton() {
  const { user, logIn, logOut, isLoading } = useFlowUser()

  if (isLoading) {
    return (
      <div className="h-7 w-24 animate-pulse rounded bg-white/10" />
    )
  }

  if (user.loggedIn && user.addr) {
    return (
      <button
        onClick={logOut}
        className="flex items-center gap-2 rounded-lg border border-emerald-700/50 bg-emerald-950/40
          px-3 py-1.5 text-xs font-medium text-emerald-400 transition
          hover:bg-red-950/40 hover:border-red-700/50 hover:text-red-400"
        title="Click to disconnect"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
        {shortenAddress(user.addr)}
      </button>
    )
  }

  return (
    <button
      onClick={logIn}
      className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/5
        px-3 py-1.5 text-xs font-medium text-slate-300 transition
        hover:bg-white/10 hover:border-white/30 hover:text-white"
    >
      Connect Wallet
    </button>
  )
}