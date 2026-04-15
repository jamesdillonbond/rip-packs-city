'use client'

import { useState } from 'react'

const monoFont = "'Share Tech Mono', monospace"
const condensedFont = "'Barlow Condensed', sans-serif"

export default function EmailDigestSubscribe({ walletAddress }: { walletAddress: string | null }) {
  const [email, setEmail] = useState('')
  const [digestWeekly, setDigestWeekly] = useState(true)
  const [dealAlerts, setDealAlerts] = useState(false)
  const [badgeAlerts, setBadgeAlerts] = useState(false)
  const [portfolioAlerts, setPortfolioAlerts] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!email.trim() || !email.includes('@')) { setError('Enter a valid email'); return }
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), walletAddress, digestWeekly, dealAlerts, badgeAlerts, portfolioAlerts }),
      })
      const json = await r.json()
      if (!r.ok || !json.success) throw new Error(json.error ?? 'Subscription failed')
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <section style={{ marginBottom: 18, padding: 16, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 10 }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: '#10B981', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>
          ✓ Subscribed
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
          Check your email for a verification link.
        </div>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 18, padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 }}>
      <div style={{ fontSize: 9, fontFamily: monoFont, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 12 }}>
        ◇ Email Digest
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={{ flex: 1, minWidth: 220, background: 'rgba(13,13,13,0.85)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '8px 12px', color: '#fff', fontFamily: monoFont, fontSize: 12, outline: 'none' }}
        />
        <button
          onClick={submit}
          disabled={submitting}
          style={{ background: '#E03A2F', border: 'none', borderRadius: 6, padding: '8px 18px', color: '#fff', fontFamily: condensedFont, fontWeight: 800, fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? 'Sending…' : 'Subscribe'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
        <Toggle label="Weekly market digest" checked={digestWeekly} onChange={setDigestWeekly} />
        <Toggle label="Deal alerts" checked={dealAlerts} onChange={setDealAlerts} />
        <Toggle label="Badge alerts" checked={badgeAlerts} onChange={setBadgeAlerts} />
        <Toggle label="Portfolio P&L alerts" checked={portfolioAlerts} onChange={setPortfolioAlerts} />
      </div>

      {error && (
        <div style={{ marginTop: 10, fontSize: 11, fontFamily: monoFont, color: '#EF4444' }}>{error}</div>
      )}
    </section>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(13,13,13,0.6)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#E03A2F' }} />
      <span style={{ fontFamily: monoFont, fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>{label}</span>
    </label>
  )
}
