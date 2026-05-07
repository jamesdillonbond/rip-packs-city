// app/pricing/page.tsx
//
// Free vs Pro comparison. Reads from public.feature_quotas at request
// time so the table self-updates whenever Trevor tunes the limits in
// Postgres — no redeploy needed.
//
// NFT-payment Pro: existing moments_payment flow. Send a moment ≥ minimum
// FMV → days of Pro proportional to FMV. Linked.
// Stripe Pro: pricing planned ($9.99/mo, $79/yr, $299 lifetime) but
// disabled until Phase 3 (June 2026). Disabled buttons + "Available in
// Phase 3" copy keeps users informed without committing the dates.

import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const revalidate = 60

type QuotaRow = {
  plan: string
  feature_name: string
  daily_limit: number | null
  notes: string | null
}

const FREE_FEATURES = [
  { label: "Wallet search lookup", available: true },
  { label: "Public profile pages", available: true },
  { label: "Basic FMV display on every moment page", available: true },
  { label: "1 saved wallet", available: true, source: "saved_wallets_max" as const },
  { label: "5 AI Concierge messages / day", available: true, source: "concierge_messages" as const },
  { label: "Sniper feed (5-min refresh)", available: true },
  { label: "Basic Pack EV viewer", available: true },
]

const PRO_FEATURES = [
  { label: "Unlimited saved wallets", source: "saved_wallets_max" as const },
  { label: "200 AI Concierge messages / day", source: "concierge_messages" as const },
  { label: "Real-time sniper feed (30-sec refresh)" },
  { label: "All collections fully enabled" },
  { label: "Full Fast Break optimizer" },
  { label: "Full Pinnacle FMV including triple-key joins" },
  { label: "Insider Signals — institutional flow tracking" },
  { label: "25 custom alerts (price drops, listing alerts, watchlist hits)", source: "custom_alerts_max" as const },
  { label: "10,000 API requests / day (vs free 100)", source: "api_requests" as const },
  { label: "Custom Discord roles" },
  { label: "Pack EV with confidence intervals + depletion forecasting" },
]

async function loadQuotas(): Promise<QuotaRow[]> {
  // deno-lint-ignore no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("feature_quotas")
    .select("plan, feature_name, daily_limit, notes")
  return (data ?? []) as QuotaRow[]
}

function quotaText(rows: QuotaRow[], plan: string, feature: string): string {
  const row = rows.find(r => r.plan === plan && r.feature_name === feature)
  if (!row) return "—"
  if (row.daily_limit == null) return "Unlimited"
  return String(row.daily_limit)
}

const PAGE: React.CSSProperties = {
  maxWidth: 980,
  margin: "0 auto",
  padding: "48px 20px 72px",
  color: "var(--rpc-text-primary)",
}

const H1: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 42,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  margin: "0 0 12px",
  color: "var(--rpc-text-primary)",
}

const SUB: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--rpc-text-secondary)",
  lineHeight: 1.7,
  marginBottom: 36,
  maxWidth: 640,
}

const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 20,
  marginBottom: 36,
}

const CARD: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg, 12px)",
  padding: 28,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  fontFamily: "var(--font-mono)",
  color: "var(--rpc-text-secondary)",
}

const CARD_PRO: React.CSSProperties = {
  ...CARD,
  borderColor: "var(--rpc-red-border, rgba(224,58,47,0.4))",
  background: "linear-gradient(180deg, rgba(224,58,47,0.05), var(--rpc-surface))",
}

const PLAN_NAME: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 24,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
}

const PRICE: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 36,
  color: "var(--rpc-text-primary)",
  letterSpacing: "0.02em",
}

const PRICE_UNIT: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--rpc-text-muted)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  marginLeft: 6,
}

const FEATURE_LIST: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: 12,
  lineHeight: 1.6,
}

const CTA_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--rpc-red, #E03A2F)",
  color: "#fff",
  padding: "12px 22px",
  borderRadius: "var(--radius-sm, 6px)",
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 800,
  fontSize: 13,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  textDecoration: "none",
  marginTop: 6,
}

const CTA_DISABLED: React.CSSProperties = {
  ...CTA_BTN,
  background: "rgba(255,255,255,0.05)",
  color: "var(--rpc-text-muted)",
  pointerEvents: "none",
  cursor: "not-allowed",
  border: "1px solid var(--rpc-border)",
}

const STRIPE_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 14,
  marginTop: 16,
}

const STRIPE_CARD: React.CSSProperties = {
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md, 8px)",
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--rpc-text-secondary)",
}

const PHASE1_BANNER: React.CSSProperties = {
  background: "rgba(255, 200, 87, 0.08)",
  border: "1px solid rgba(255, 200, 87, 0.3)",
  borderRadius: "var(--radius-md, 8px)",
  padding: 16,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--rpc-text-secondary)",
  marginBottom: 28,
  lineHeight: 1.7,
}

export const metadata = {
  title: "Pricing — Rip Packs City",
  description: "Free vs Pro comparison for the Bloomberg Terminal of Flow collectibles.",
}

export default async function PricingPage() {
  const rows = await loadQuotas()

  return (
    <main style={PAGE}>
      <h1 style={H1}>Pricing</h1>
      <p style={SUB}>
        Discovery and sharing stays free. Daily-utility and exclusive intelligence
        is Pro. We don&apos;t paywall the front door — wallet search, public
        profiles, FMV on every moment, and the basic sniper are all free, forever.
      </p>

      <div style={PHASE1_BANNER}>
        <strong style={{ color: "var(--rpc-text-primary)" }}>Phase 1 Beta Invitees</strong> get
        <strong style={{ color: "var(--rpc-text-primary)" }}> lifetime Pro included</strong>
        — no payment required, no expiration. Already grandfathered into your account.
      </div>

      <div style={GRID}>
        {/* Free */}
        <div style={CARD}>
          <div style={PLAN_NAME}>Free</div>
          <div>
            <span style={PRICE}>$0</span>
            <span style={PRICE_UNIT}>/ month</span>
          </div>
          <ul style={FEATURE_LIST}>
            {FREE_FEATURES.map(f => (
              <li key={f.label} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span aria-hidden style={{ color: "var(--rpc-text-muted)" }}>·</span>
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
          <Link href="/login" style={{ ...CTA_BTN, background: "transparent", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)" }}>
            Sign up
          </Link>
        </div>

        {/* Pro */}
        <div style={CARD_PRO}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={PLAN_NAME}>Pro</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 999,
              background: "var(--rpc-red-bg, rgba(224,58,47,0.1))",
              border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.3))",
              color: "var(--rpc-red, #E03A2F)",
            }}>
              Recommended
            </span>
          </div>
          <div>
            <span style={PRICE}>NFT</span>
            <span style={PRICE_UNIT}>or Stripe (Phase 3)</span>
          </div>
          <ul style={FEATURE_LIST}>
            {PRO_FEATURES.map(f => {
              const cap = f.source ? quotaText(rows, "pro_paid", f.source) : null
              return (
                <li key={f.label} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span aria-hidden style={{ color: "var(--rpc-red, #E03A2F)" }}>✓</span>
                  <span>
                    {f.label}
                    {cap && cap !== "—" && cap !== "Unlimited" && (
                      <span style={{ color: "var(--rpc-text-muted)", marginLeft: 6 }}>
                        ({cap}/day)
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>

          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-primary)", marginTop: 4 }}>
            Pay with NFTs (live now)
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            Send any moment to RPC&apos;s Dapper merchant address. Days of Pro
            credit unlock proportional to the moment&apos;s FMV — high-value
            moments translate to months of access.
          </p>
          <Link href="/dashboard?tab=upgrade" style={CTA_BTN}>
            Pay with NFTs
          </Link>

          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-primary)", marginTop: 12 }}>
            Pay with Stripe (Phase 3)
          </div>
          <div style={STRIPE_GRID}>
            <div style={STRIPE_CARD}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)" }}>
                $9.99<span style={PRICE_UNIT}>/ mo</span>
              </div>
              <div>Monthly</div>
            </div>
            <div style={STRIPE_CARD}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)" }}>
                $79<span style={PRICE_UNIT}>/ yr</span>
              </div>
              <div>Annual · 35% off</div>
            </div>
            <div style={STRIPE_CARD}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)" }}>
                $299
              </div>
              <div>Lifetime · founders cohort</div>
            </div>
          </div>
          <span style={CTA_DISABLED} aria-disabled>
            Available in Phase 3 (June 2026)
          </span>
        </div>
      </div>

      <div style={{ ...CARD, padding: 18, borderColor: "var(--rpc-border)", background: "transparent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12 }}>
          Quotas above are read live from Supabase. If Trevor tunes a limit, this
          page reflects it within 60 seconds.
        </div>
        <Link href="/legal/fmv-methodology" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          How is FMV calculated? →
        </Link>
      </div>
    </main>
  )
}
