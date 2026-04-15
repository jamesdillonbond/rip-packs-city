'use client'

import React from 'react'
import { useFlowUser } from '@/lib/hooks/useFlowUser'
import { useProStatus } from '@/lib/hooks/useProStatus'

export function ProBadge() {
  const { user } = useFlowUser()
  const { isPro, plan } = useProStatus(user.loggedIn ? user.addr : null)

  if (!isPro) return null

  const isFounding = plan === 'founding'
  const label = isFounding ? 'FOUNDING' : 'PRO'

  const baseStyle: React.CSSProperties = {
    fontFamily: "'Share Tech Mono', monospace",
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
          background: 'linear-gradient(90deg, #E03A2F, #B91C1C)',
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
