'use client'

import { useEffect, useState, useCallback } from 'react'
import * as fcl from '@onflow/fcl'
import { useFlowUser } from './useFlowUser'

// Cadence script to read FlowToken balance from the connected account.
// Returns 0.0 if the vault doesn't exist on the account.
const FLOW_BALANCE_SCRIPT = `
import FlowToken from 0x1654653399040a61
import FungibleToken from 0xf233dcee88fe0abe

access(all) fun main(address: Address): UFix64 {
  let account = getAccount(address)
  let vaultRef = account.capabilities.borrow<&{FungibleToken.Balance}>(
    /public/flowTokenBalance
  )
  if vaultRef == nil {
    return 0.0
  }
  return vaultRef!.balance
}
`

// Cadence script to read USDCFlow balance from the connected account.
// Returns 0.0 if the vault doesn't exist on the account.
const USDC_BALANCE_SCRIPT = `
import USDCFlow from 0xf1ab99c82dee3526
import FungibleToken from 0xf233dcee88fe0abe

access(all) fun main(address: Address): UFix64 {
  let account = getAccount(address)
  let vaultRef = account.capabilities.borrow<&{FungibleToken.Balance}>(
    /public/usdcFlowBalance
  )
  if vaultRef == nil {
    return 0.0
  }
  return vaultRef!.balance
}
`

export interface FlowWalletBalances {
  flowBalance: number
  usdcBalance: number
  isLoading: boolean
  refetch: () => void
}

/**
 * Queries FLOW and USDCFlow balances for the connected Flow Wallet user.
 * Only runs when a non-Dapper wallet is connected. Returns 0 for both
 * balances when disconnected or using Dapper.
 */
export function useFlowWalletBalances(): FlowWalletBalances {
  const { user } = useFlowUser()
  const [flowBalance, setFlowBalance] = useState(0)
  const [usdcBalance, setUsdcBalance] = useState(0)
  const [isLoading, setIsLoading] = useState(false)

  const isFlowWallet =
    user.loggedIn === true &&
    user.addr != null &&
    user.walletProvider !== 'dapper' &&
    user.walletProvider !== 'unknown'

  const fetchBalances = useCallback(async () => {
    if (!isFlowWallet || !user.addr) return

    setIsLoading(true)

    try {
      // Query both balances in parallel
      const [flowRaw, usdcRaw] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fcl.query as any)({
          cadence: FLOW_BALANCE_SCRIPT,
          args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
            arg(user.addr, t.Address),
          ],
        }).catch(() => '0.0'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fcl.query as any)({
          cadence: USDC_BALANCE_SCRIPT,
          args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
            arg(user.addr, t.Address),
          ],
        }).catch(() => '0.0'),
      ])

      setFlowBalance(parseFloat(parseFloat(flowRaw).toFixed(2)))
      setUsdcBalance(parseFloat(parseFloat(usdcRaw).toFixed(2)))
    } catch {
      // If both queries fail, default to 0
      setFlowBalance(0)
      setUsdcBalance(0)
    } finally {
      setIsLoading(false)
    }
  }, [isFlowWallet, user.addr])

  // Fetch on mount and when wallet changes
  useEffect(() => {
    if (isFlowWallet) {
      fetchBalances()
    } else {
      setFlowBalance(0)
      setUsdcBalance(0)
    }
  }, [isFlowWallet, fetchBalances])

  return { flowBalance, usdcBalance, isLoading, refetch: fetchBalances }
}
