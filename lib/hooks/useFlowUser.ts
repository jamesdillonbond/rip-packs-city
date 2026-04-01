'use client'

import { useEffect, useState } from 'react'
import * as fcl from '@onflow/fcl'
import { initFcl } from '@/lib/flow'

export type WalletProvider = 'dapper' | 'flow' | 'unknown'

export interface FlowUser {
  addr: string | null
  loggedIn: boolean
  walletProvider: WalletProvider
}

// Detect wallet provider from FCL currentUser services
function detectWalletProvider(user: Record<string, unknown>): WalletProvider {
  const services = user?.services as Array<{ uid?: string; f_type?: string; endpoint?: string }> | undefined
  if (!services?.length) return 'unknown'

  for (const svc of services) {
    const uid = (svc.uid ?? '').toLowerCase()
    const endpoint = (svc.endpoint ?? '').toLowerCase()
    if (uid.includes('dapper') || endpoint.includes('dapper')) return 'dapper'
    if (uid.includes('lilico') || uid.includes('blocto') || uid.includes('flow-wallet') || endpoint.includes('flow-wallet')) return 'flow'
  }

  return 'unknown'
}

export function useFlowUser(): {
  user: FlowUser
  logIn: () => void
  logOut: () => void
  isLoading: boolean
} {
  const [user, setUser] = useState<FlowUser>({ addr: null, loggedIn: false, walletProvider: 'unknown' })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    initFcl()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = fcl.currentUser.subscribe((u: any) => {
      setUser({
        addr: u?.addr ?? null,
        loggedIn: u?.loggedIn === true,
        walletProvider: u?.loggedIn ? detectWalletProvider(u) : 'unknown',
      })
      setIsLoading(false)
    })
    return unsub
  }, [])

  const logIn = () => {
    initFcl()
    fcl.authenticate()
  }

  const logOut = () => {
    fcl.unauthenticate()
  }

  return { user, logIn, logOut, isLoading }
}
