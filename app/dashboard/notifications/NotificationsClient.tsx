"use client"

// app/dashboard/notifications/NotificationsClient.tsx
//
// Email subscription preferences. Hits /api/email/subscribe (GET to hydrate,
// POST to save). After the first POST the route fires a Resend confirmation
// email; the user clicks the link, which redirects back here with
// ?confirm=ok|missing|unknown_token|error.
//
// ⚠ SPLIT OUT OF page.tsx FOR MEASUREMENT, not for structure. A `"use client"`
// page.tsx is matched by NEITHER coverage gate — the primary gate is lib/** +
// app/api/**/route.ts, the component gate is components/** + app/**/*Client.tsx
// — so this state machine (hydrate, four confirm banners, two toggle arrays, a
// save path with three distinct success notes) was unmeasured despite being the
// only surface a collector uses to control what email we send them.
//
// The Suspense boundary that `useSearchParams` requires now lives in the server
// page.tsx. Keeping it there rather than re-wrapping here is what lets the
// tests render this component directly.

import { fetchJson } from "@/lib/analytics/fetch-json"
import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { accentText } from "@/lib/accent-text"

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


export default function NotificationsClient() {
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
  // ⛔ A failed LOAD leaves the form on its defaults. Saving it then wrote those
  // defaults over the real row (deal filters, tiers, collections, toggles) — a
  // failed read turned into a delete (2026-10-10). Save is refused until a load
  // has succeeded.
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    // ⚠ Was `.then(r => r.json())` with no status check. It degraded correctly
    // only BY ACCIDENT: `apiErrorResponse` happens to put an `error` field in the
    // envelope, and the next line throws on it. A failure body without that field
    // — a 500 from a layer that does not use the helper, or an HTML error page —
    // would fall straight through, leaving `j.subscriber` undefined and rendering
    // a subscribed collector as not subscribed. fetchJson gates the parse on the
    // status so the accident is not load-bearing.
    fetchJson<{ error?: string; subscriber?: Subscriber | null }>("/api/email/subscribe", {
      credentials: "include",
    })
      .then(res => {
        if (!res.ok) throw new Error("Couldn't load your notification settings")
        const j = res.json ?? {}
        if (j.error) throw new Error(j.error)
        const s = (j.subscriber ?? null) as Subscriber | null
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
      .catch(e => {
        setLoadFailed(true)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoading(false))
  }, [])

  async function onSave() {
    if (loadFailed) return
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
    return <main style={{ padding: "2rem", color: "var(--rpc-text-muted)", background: "var(--rpc-bg)", minHeight: "100vh", fontFamily: "var(--font-mono)" }}>Loading…</main>
  }

  return (
    <main style={{ padding: "24px 16px 96px", color: "var(--rpc-text-primary)", background: "var(--rpc-bg)", minHeight: "100vh", fontFamily: "var(--font-body)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>Email notifications</h1>
          <Link href="/dashboard" style={{ color: "var(--rpc-text-secondary)", fontSize: 13, textDecoration: "none" }}>
            ← Dashboard
          </Link>
        </div>
        <p style={{ color: "var(--rpc-text-secondary)", fontSize: 14, margin: "4px 0 20px", lineHeight: 1.5 }}>
          What RPC emails you, and how often. Listing alerts by player, set, team or price live on the{" "}
          <Link href="/alerts" style={{ color: "var(--rpc-red-text)" }}>Alerts</Link> page.
        </p>

        {confirmStatus === "ok" && (
          <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-success)", color: "var(--rpc-success-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Email confirmed — you&apos;re all set.</div>
        )}
        {confirmStatus === "missing" && (
          <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-danger)", color: "var(--rpc-danger-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Missing confirmation token.</div>
        )}
        {confirmStatus === "unknown_token" && (
          <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-danger)", color: "var(--rpc-danger-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>That confirmation link is invalid or already used.</div>
        )}
        {confirmStatus === "error" && (
          <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-danger)", color: "var(--rpc-danger-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>Confirmation failed: {confirmDetail ?? "unknown"}.</div>
        )}

        {sub && (
          <p style={{ color: "var(--rpc-text-secondary)", margin: "0 0 24px" }}>
            <strong>{sub.email}</strong> — {sub.verified ? "verified" : "pending confirmation"}
          </p>
        )}

        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>What to receive</h2>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0" }}>
            <input id="pref-digest-weekly" type="checkbox" checked={digestWeekly} onChange={e => setDigestWeekly(e.target.checked)} style={{ marginTop: 3 }} />
            <div>
              <label htmlFor="pref-digest-weekly" style={{ display: "block", fontWeight: 600, cursor: "pointer" }}>Weekly digest</label>
              <div style={{ fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.45 }}>
                One email a week with how your saved wallets&apos; value moved. RPC isn&apos;t sending it yet — this switch
                decides whether you&apos;re in from the first send.
              </div>
            </div>
          </div>
          {/*
            2026-11-06: the "Deal alerts" / "Badge alerts" / "Portfolio alerts"
            toggles and the deal-filter panel were REMOVED from this page. No
            sender reads email_subscribers.deal_alerts / badge_alerts /
            portfolio_alerts (the DB function that did, build_deal_alerts_for_subscriber,
            has no caller; prosrc + cron.job + repo grep 11-06), so a collector who
            switched them on was promised email that could never arrive. Listing
            alerts that DO send — email, Telegram, Discord — are the /alerts
            subscriptions. The columns stay and are posted back unchanged below, so
            nothing a collector saved is lost if a sender is ever wired.
          */}
        </section>

        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 8px" }}>Listing alerts</h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
            Deal, price, badge and serial alerts — by player, set, team, tier or discount, delivered to email, Telegram or
            Discord — are set up on the <Link href="/alerts" style={{ color: "var(--rpc-red-text)" }}>Alerts</Link> page,
            where you can also watch a single edition or a pack&apos;s chase odds.
          </p>
        </section>

        {savedNote && <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-success)", color: "var(--rpc-success-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>{savedNote}</div>}
        {error && <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-danger)", color: "var(--rpc-danger-text)", padding: "12px 16px", borderRadius: 8, marginBottom: 16 }}>{error}</div>}

        {loadFailed && (
          <div style={{ color: accentText("#fecaca"), fontSize: 14, marginBottom: 12 }}>
            Your saved settings couldn&apos;t be loaded, so saving is turned off — saving now would overwrite them with the defaults shown above. Reload the page to try again.
          </div>
        )}
        <button onClick={onSave} disabled={saving || loadFailed} style={{ padding: "12px 24px", background: "var(--rpc-red, #E03A2F)", color: "#0a0a0a", border: 0, borderRadius: 8, fontWeight: 700, cursor: saving || loadFailed ? "default" : "pointer", opacity: saving || loadFailed ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </main>
  )
}
