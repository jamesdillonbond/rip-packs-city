'use client'

import React from 'react'
import { useSessionOwner } from '@/lib/hooks/useSessionOwner'
import { useProStatus } from '@/lib/hooks/useProStatus'

// Keyed on the SESSION's wallet, not on fcl.currentUser. RPC removed every
// wallet-connect surface on 2026-08-08, so fcl.currentUser is permanently
// signed-out — keeping this on useFlowUser would have made the badge render
// `null` for every Pro and Founding member site-wide (GlobalSiteHeader,
// /my-teams, /analytics) with `tsc` still perfectly green.
export function ProBadge() {
  const { walletAddr } = useSessionOwner()
  const { isPro, plan } = useProStatus(walletAddr)

  if (!isPro) return null

  const isFounding = plan === 'founding'
  const label = isFounding ? 'FOUNDING' : 'PRO'

  const baseStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    padding: '2px 8px',
    borderRadius: 4,
    flexShrink: 0,
    fontWeight: 700,
  }

  if (isFounding) {
    return (
      <span
        title="Founding Member"
        style={{
          ...baseStyle,
          background: 'linear-gradient(90deg, var(--rpc-red), #B91C1C)',
          color: '#FFF7ED',
          border: '1px solid rgba(224,58,47,0.6)',
        }}
      >
        {label}
      </span>
    )
  }

  return (
    <span
      title="RPC Pro"
      style={{
        ...baseStyle,
        background: 'rgba(245,158,11,0.15)',
        color: '#F59E0B',
        border: '1px solid rgba(245,158,11,0.35)',
      }}
    >
      {label}
    </span>
  )
}
