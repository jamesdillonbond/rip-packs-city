'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { publishedCollections } from '@/lib/collections'

const STORAGE_KEY = 'rpc_onboarding_complete'
const monoFont = "'Share Tech Mono', monospace"
const condensedFont = "'Barlow Condensed', sans-serif"

export default function OnboardingModal() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(1)
  const [walletInput, setWalletInput] = useState('')

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!localStorage.getItem(STORAGE_KEY)) {
      const t = setTimeout(() => setOpen(true), 600)
      return () => clearTimeout(t)
    }
  }, [])

  function complete() {
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, '1')
    setOpen(false)
  }

  function pickCollection(slug: string) {
    complete()
    router.push(`/${slug}/overview`)
  }

  function searchWallet() {
    if (!walletInput.trim()) return
    complete()
    router.push(`/nba-top-shot/collection?q=${encodeURIComponent(walletInput.trim())}`)
  }

  if (!open) return null
  const collections = publishedCollections().slice(0, 5)

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, animation: 'rpc-onb-fade 220ms ease-out',
      }}
      onClick={complete}
    >
      <style>{`
        @keyframes rpc-onb-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes rpc-onb-slide { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480, background: '#0d0d0d',
          border: '1px solid rgba(224,58,47,0.35)', borderRadius: 14,
          padding: 24, color: '#fff', animation: 'rpc-onb-slide 260ms ease-out',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontSize: 9, fontFamily: monoFont, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
            Step {step} of 3
          </span>
          <button onClick={complete} aria-label="Skip" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11, fontFamily: monoFont, letterSpacing: '0.1em' }}>SKIP</button>
        </div>

        {step === 1 && (
          <>
            <h2 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 26, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>
              Welcome to Rip Packs <span style={{ color: '#E03A2F' }}>City</span>
            </h2>
            <p style={{ fontFamily: monoFont, fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.65, marginBottom: 20 }}>
              The smartest analytics platform for digital collectibles on Flow blockchain.
            </p>
            <div style={{ display: 'flex', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
              {collections.map(c => (
                <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 60 }}>
                  <span style={{ fontSize: 26 }}>{c.icon}</span>
                  <span style={{ fontSize: 8, fontFamily: monoFont, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{c.shortLabel}</span>
                </div>
              ))}
            </div>
            <button onClick={() => setStep(2)} style={primaryBtn}>Get Started →</button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={titleStyle}>Pick Your Collection</h2>
            <p style={subStyle}>Jump into the analytics for any collection.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10, marginBottom: 18 }}>
              {collections.map(c => (
                <button
                  key={c.id}
                  onClick={() => pickCollection(c.id)}
                  style={{
                    background: 'rgba(13,13,13,0.85)', border: `1px solid ${c.accent}44`,
                    borderRadius: 10, padding: 14, color: '#fff', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    transition: 'border-color 120ms',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = c.accent }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${c.accent}44` }}
                >
                  <span style={{ fontSize: 22 }}>{c.icon}</span>
                  <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{c.shortLabel}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={() => setStep(3)} style={linkBtn}>Or browse all →</button>
              <button onClick={() => setStep(3)} style={primaryBtn}>Next →</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 style={titleStyle}>Connect Your Wallet</h2>
            <p style={subStyle}>Search any wallet or username to see full analytics — no signup required.</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                type="text"
                value={walletInput}
                onChange={e => setWalletInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchWallet()}
                placeholder="0x… or @username"
                style={{
                  flex: 1, background: 'rgba(13,13,13,0.85)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 6, padding: '10px 12px', color: '#fff', fontFamily: monoFont, fontSize: 12, outline: 'none',
                }}
              />
              <button onClick={searchWallet} style={primaryBtn}>Search</button>
            </div>
            <button onClick={complete} style={{ ...linkBtn, width: '100%', textAlign: 'center' }}>I&apos;ll do this later</button>
          </>
        )}
      </div>
    </div>
  )
}

const titleStyle: React.CSSProperties = {
  fontFamily: condensedFont, fontWeight: 900, fontSize: 22,
  letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8, color: '#fff',
}
const subStyle: React.CSSProperties = {
  fontFamily: monoFont, fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6, marginBottom: 18,
}
const primaryBtn: React.CSSProperties = {
  background: 'linear-gradient(135deg, #E03A2F, #B91C1C)', color: '#fff', border: 'none',
  borderRadius: 6, padding: '10px 18px', fontFamily: condensedFont, fontWeight: 800,
  fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
}
const linkBtn: React.CSSProperties = {
  background: 'transparent', color: 'rgba(255,255,255,0.6)', border: 'none',
  fontFamily: monoFont, fontSize: 11, letterSpacing: '0.08em', cursor: 'pointer',
}
