"use client"

// app/dashboard/notifications/page.tsx
//
// Email subscription preferences. Hits /api/email/subscribe (GET to hydrate,
// POST to save). After the first POST the route fires a Resend confirmation
// email; the user clicks the link, which redirects back here with
// ?confirm=ok|missing|unknown_token|error.

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"

interface Subscriber {
  id: string
  email: string
  verified: boolean
  wallet_address: string | null
  digest_weekly: boolean
  deal_alerts: boolean
  badge_alerts: boolean
  portfolio_alerts: boolean
  collection_ids: string[] | null
  deal_min_discount: number | null
  deal_max_price: number | null
  deal_tiers: string[] | null
  unsubscribed_at: string | null
}

const COLLECTIONS = [
  { id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", label: "NBA Top Shot" },
  { id: "dee28451-5d62-409e-a1ad-a83f763ac070", label: "NFL All Day" },
  { id: "06248cc4-b85f-47cd-af67-1855d14acd75", label: "LaLiga Golazos" },
  { id: "7dd9dd11-e8b6-45c4-ac99-71331f959714", label: "Disney Pinnacle" },
  { id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", label: "UFC Strike" },
]

const TIERS = ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"]

export default function NotificationsPageWrapper() {
  return (
    <Suspense fallback={<main style={{ padding: "2rem", color: "#fafafa", background: "#0a0a0a", minHeight: "100vh" }}>Loading…</main>}>
      <NotificationsPage />
    </Suspense>
  )
}

function NotificationsPage() {
  const search = useSearchParams()
  const confirmStatus = search.get("confirm")
  const confirmDetail = search.get("detail")

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [sub, setSub] = useState<Subscriber | null>(null)

  // Local form state
  const [digestWeekly, setDigestWeekly] = useState(true)
  const [dealAlerts, setDealAlerts] = useState(false)
  const [badgeAlerts, setBadgeAlerts] = useState(false)
  const [portfolioAlerts, setPortfolioAlerts] = useState(false)
  const [minDiscount, setMinDiscount] = useState(20)
  const [maxPrice, setMaxPrice] = useState<string>("")
  const [collectionIds, setCollectionIds] = useState<string[]>([])
  const [dealTiers, setDealTiers] = useState<string[]>([])

  useEffect(() => {
    fetch("/api/email/subscribe", { credentials: "include" })
      .then(r => r.json())
      .then(j => {
        if (j.error) throw new Error(j.error)
        const s = j.subscriber as Subscriber | null
        setSub(s)
        if (s) {
          setDigestWeekly(s.digest_weekly)
          setDealAlerts(s.deal_alerts)
          setBadgeAlerts(s.badge_alerts)
          setPortfolioAlerts(s.portfolio_alerts)
          setMinDiscount(s.deal_min_discount ?? 20)
          setMaxPrice(s.deal_max_price != null ? String(s.deal_max_price) : "")
          setCollectionIds(s.collection_ids ?? [])
          setDealTiers(s.deal_tiers ?? [])
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  function toggleArray(value: string, arr: string[], setter: (a: string[]) => void) {
    setter(arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value])
  }

  async function onSave() {
    setSaving(true)
    setError(null)
    setSavedNote(null)
    try {
      const res = await fetch("/api/email/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digest_weekly: digestWeekly,
          deal_alerts: dealAlerts,
          badge_alerts: badgeAlerts,
          portfolio_alerts: portfolioAlerts,
          deal_min_discount: minDiscount,
          deal_max_price: maxPrice ? Number(maxPrice) : null,
          collection_ids: collectionIds.length ? collectionIds : null,
          deal_tiers: dealTiers.length ? dealTiers : null,
        }),
      })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setSub({
        ...(sub ?? { id: j.id, email: j.email } as Subscriber),
        id: j.id,
        email: j.email,
        verified: j.verified,
        wallet_address: sub?.wallet_address ?? null,
        digest_weekly: digestWeekly,
        deal_alerts: dealAlerts,
        badge_alerts: badgeAlerts,
        portfolio_alerts: portfolioAlerts,
        collection_ids: collectionIds.length ? collectionIds : null,
        deal_min_discount: minDiscount,
        deal_max_price: maxPrice ? Number(maxPrice) : null,
        deal_tiers: dealTiers.length ? dealTiers : null,
        unsubscribed_at: null,
      })
      if (!j.verified && j.confirmation_email_sent) {
        setSavedNote("Preferences saved. Confirmation email sent — click the link to activate alerts.")
      } else if (!j.verified && j.confirmation_email_error) {
        setSavedNote(`Saved, but confirmation email failed: ${j.confirmation_email_error}`)
      } else {
        setSavedNote("Preferences saved.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <main style={{ padding: "2rem", color: "#fafafa", background: "#0a0a0a", minHeight: "100vh" }}>Loading…</main>
  }

  return (
    <main style={{ padding: "2rem", color: "#fafafa", background: "#0a0a0a", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ fontFamily: "var(--font-display, 'Barlow Condensed')", fontSize: "2rem", letterSpacing: "0.04em", margin: "0 0 1rem", color: "var(--rpc-red, #E03A2F)" }}>Email notifications</h1>

        {confirmStatus === "ok" && (
          <div style={{ background: "#064e3b", color: "#a7f3d0", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Email confirmed — you're all set.</div>
        )}
        {confirmStatus === "missing" && (
          <div style={{ background: "#7c2d12", color: "#fed7aa", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Missing confirmation token.</div>
        )}
        {confirmStatus === "unknown_token" && (
          <div style={{ background: "#7c2d12", color: "#fed7aa", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>That confirmation link is invalid or already used.</div>
        )}
        {confirmStatus === "error" && (
          <div style={{ background: "#7f1d1d", color: "#fecaca", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Confirmation failed: {confirmDetail ?? "unknown"}.</div>
        )}

        {sub && (
          <p style={{ color: "rgba(255,255,255,0.65)", margin: "0 0 24px" }}>
            <strong>{sub.email}</strong> — {sub.verified ? "verified" : "pending confirmation"}
          </p>
        )}

        <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>What to receive</h2>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <input type="checkbox" checked={digestWeekly} onChange={e => setDigestWeekly(e.target.checked)} />
            <span>Weekly digest</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <input type="checkbox" checked={dealAlerts} onChange={e => setDealAlerts(e.target.checked)} />
            <span>Deal alerts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <input type="checkbox" checked={badgeAlerts} onChange={e => setBadgeAlerts(e.target.checked)} />
            <span>Badge alerts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <input type="checkbox" checked={portfolioAlerts} onChange={e => setPortfolioAlerts(e.target.checked)} />
            <span>Portfolio alerts</span>
          </label>
        </section>

        {dealAlerts && (
          <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 24, marginBottom: 24 }}>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>Deal filters</h2>
            <label style={{ display: "block", margin: "0 0 12px" }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginBottom: 4 }}>Minimum discount % below FMV</div>
              <input type="number" min={5} max={90} value={minDiscount} onChange={e => setMinDiscount(parseInt(e.target.value, 10) || 20)} style={{ background: "#0a0a0a", color: "#fafafa", border: "1px solid #27272a", padding: 8, borderRadius: 6, width: 120 }} />
            </label>
            <label style={{ display: "block", margin: "0 0 12px" }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginBottom: 4 }}>Max price (USD, blank = no cap)</div>
              <input type="number" min={1} value={maxPrice} onChange={e => setMaxPrice(e.target.value)} style={{ background: "#0a0a0a", color: "#fafafa", border: "1px solid #27272a", padding: 8, borderRadius: 6, width: 120 }} />
            </label>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginBottom: 8 }}>Tiers</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {TIERS.map(t => (
                <button key={t} type="button" onClick={() => toggleArray(t, dealTiers, setDealTiers)} style={{ padding: "4px 12px", borderRadius: 999, border: "1px solid #27272a", background: dealTiers.includes(t) ? "var(--rpc-red, #E03A2F)" : "#0a0a0a", color: dealTiers.includes(t) ? "#0a0a0a" : "#fafafa", cursor: "pointer" }}>{t}</button>
              ))}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginBottom: 8 }}>Collections</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {COLLECTIONS.map(c => (
                <button key={c.id} type="button" onClick={() => toggleArray(c.id, collectionIds, setCollectionIds)} style={{ padding: "4px 12px", borderRadius: 999, border: "1px solid #27272a", background: collectionIds.includes(c.id) ? "var(--rpc-red, #E03A2F)" : "#0a0a0a", color: collectionIds.includes(c.id) ? "#0a0a0a" : "#fafafa", cursor: "pointer" }}>{c.label}</button>
              ))}
            </div>
          </section>
        )}

        {savedNote && <div style={{ background: "#064e3b", color: "#a7f3d0", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>{savedNote}</div>}
        {error && <div style={{ background: "#7f1d1d", color: "#fecaca", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>{error}</div>}

        <button onClick={onSave} disabled={saving} style={{ padding: "12px 24px", background: "var(--rpc-red, #E03A2F)", color: "#0a0a0a", border: 0, borderRadius: 8, fontWeight: 700, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </main>
  )
}
