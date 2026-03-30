'use client'

import { useEffect, useState } from 'react'
import * as fcl from '@onflow/fcl'
import { initFcl } from '@/lib/flow'

export interface FlowUser {
  addr: string | null
  loggedIn: boolean
}

export function useFlowUser(): {
  user: FlowUser
  logIn: () => void
  logOut: () => void
  isLoading: boolean
} {
  const [user, setUser] = useState<FlowUser>({ addr: null, loggedIn: false })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    initFcl()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = fcl.currentUser.subscribe((u: any) => {
      setUser({
        addr: u?.addr ?? null,
        loggedIn: u?.loggedIn === true,
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