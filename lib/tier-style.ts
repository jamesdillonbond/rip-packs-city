// lib/tier-style.ts
//
// Tier chip styling extracted out of components/packs/PackTable.tsx so it can
// be safely imported from server components. PackTable is a 'use client'
// module and React Server Components reject plain function calls from client
// modules at runtime — server components can only RENDER client components,
// not call exported functions from them. Server-side callers (e.g. the
// /pack/dist/[distId] page) import tierChip from here instead.

export type ChipStyle = {
  background: string
  color: string
  border: string
}

export const TIER_STYLE: Record<string, ChipStyle> = {
  ULTIMATE: { background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.4)', color: 'rgb(253,224,71)' },
  LEGENDARY: { background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.4)', color: 'rgb(253,186,116)' },
  RARE: { background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.4)', color: 'rgb(216,180,254)' },
  EPIC: { background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: 'rgb(165,180,252)' },
  UNCOMMON: { background: 'rgba(20,184,166,0.15)', border: '1px solid rgba(20,184,166,0.4)', color: 'rgb(94,234,212)' },
  FANDOM: { background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: 'rgb(147,197,253)' },
  COMMON: { background: 'rgba(100,116,139,0.15)', border: '1px solid rgba(100,116,139,0.4)', color: 'rgb(203,213,225)' },
}

export const TIER_DEFAULT: ChipStyle = {
  background: 'rgba(100,116,139,0.15)',
  border: '1px solid rgba(100,116,139,0.4)',
  color: 'rgb(203,213,225)',
}

export function tierChip(tier: string): ChipStyle {
  const t = tier.toUpperCase().replace('MOMENT_TIER_', '')
  return TIER_STYLE[t] ?? TIER_DEFAULT
}
