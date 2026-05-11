// app/pricing/page.tsx
//
// Public conversion surface (proxy.ts allows unauth'd visitors). Reads
// feature_quotas at request time so quotas reflect Trevor's live tuning.
//
// Layout: hero with price + value prop above the fold, side-by-side Free
// vs Pro comparison with the 4 differentiators highlighted, then a
// "What's included" detail section. Brand tokens only.

import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"
import StripeSubscribeButton from "@/components/pricing/StripeSubscribeButton"

export const dynamic = "force-dynamic"
export const revalidate = 60

type QuotaRow = {
  plan: string
  feature_name: string
  daily_limit: number | null
  notes: string | null
}

async function loadQuotas(): Promise<QuotaRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("feature_quotas")
    .select("plan, feature_name, daily_limit, notes")
  return (data ?? []) as QuotaRow[]
}

function quota(rows: QuotaRow[], plan: string, feature: string): { display: string; raw: number | null } {
  const row = rows.find((r) => r.plan === plan && r.feature_name === feature)
  if (!row) return { display: "—", raw: null }
  if (row.daily_limit === null) return { display: "Unlimited", raw: null }
  return { display: row.daily_limit.toLocaleString("en-US"), raw: row.daily_limit }
}

export const metadata = {
  title: "Pricing — Rip Packs City",
  description:
    "Free vs Pro for the Bloomberg Terminal of Flow collectibles. $9.99/mo unlocks unlimited saved wallets, 200 AI Concierge messages, 25 custom alerts, real-time sniper, and full FMV access.",
}

export default async function PricingPage() {
  const rows = await loadQuotas()

  const wallets = {
    free: quota(rows, "free", "saved_wallets_max"),
    pro: quota(rows, "pro_paid", "saved_wallets_max"),
  }
  const concierge = {
    free: quota(rows, "free", "concierge_messages"),
    pro: quota(rows, "pro_paid", "concierge_messages"),
  }
  const alerts = {
    free: quota(rows, "free", "custom_alerts_max"),
    pro: quota(rows, "pro_paid", "custom_alerts_max"),
  }
  const api = {
    free: quota(rows, "free", "api_requests"),
    pro: quota(rows, "pro_paid", "api_requests"),
  }

  return (
    <main style={S.page}>
      <style>{CSS}</style>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="rpc-pr-hero">
        <div className="rpc-pr-eyebrow">Rip Packs City Pro</div>
        <h1 className="rpc-pr-h1">Stop guessing. Start sniping.</h1>
        <p className="rpc-pr-lede">
          Real-time FMV across every Flow collection, institutional flow
          tracking, unlimited wallet analytics, and a Claude-powered concierge
          that talks to your collection. Built for serious collectors.
        </p>

        <div className="rpc-pr-price-row">
          <div className="rpc-pr-price">
            <span className="rpc-pr-price-amount">$9.99</span>
            <span className="rpc-pr-price-unit">/ month</span>
          </div>
          <StripeSubscribeButton />
        </div>

        <div className="rpc-pr-grandfather">
          <strong>Phase 1 Beta invitees:</strong> lifetime Pro already
          activated on your account. No action needed.
        </div>
      </section>

      {/* ── Comparison ─────────────────────────────────────────────────── */}
      <section className="rpc-pr-grid">
        {/* Free */}
        <div className="rpc-pr-card">
          <div className="rpc-pr-plan-name">Free</div>
          <div className="rpc-pr-price-secondary">
            <span className="rpc-pr-price-amount-sm">$0</span>
            <span className="rpc-pr-price-unit">/ month</span>
          </div>
          <ul className="rpc-pr-feature-list">
            <li><Bullet /> Wallet search lookup</li>
            <li><Bullet /> Public profile pages</li>
            <li><Bullet /> Basic FMV on every moment page</li>
            <li><Bullet /> <strong>{wallets.free.display}</strong> saved wallet</li>
            <li><Bullet /> <strong>{concierge.free.display}</strong> AI Concierge messages / day</li>
            <li><Bullet /> Sniper feed (5-min refresh)</li>
            <li><Bullet /> Basic Pack EV viewer</li>
            <li><Bullet muted /> {alerts.free.raw === 0 ? "No custom alerts" : `${alerts.free.display} custom alerts`}</li>
            <li><Bullet /> <strong>{api.free.display}</strong> API requests / day</li>
          </ul>
          <Link
            href="/login"
            className="rpc-pr-cta rpc-pr-cta-ghost"
          >
            Sign Up
          </Link>
        </div>

        {/* Pro */}
        <div className="rpc-pr-card rpc-pr-card-pro">
          <div className="rpc-pr-plan-row">
            <div className="rpc-pr-plan-name">Pro</div>
            <span className="rpc-pr-badge">Recommended</span>
          </div>
          <div className="rpc-pr-price-secondary">
            <span className="rpc-pr-price-amount-sm">$9.99</span>
            <span className="rpc-pr-price-unit">/ month</span>
          </div>
          <ul className="rpc-pr-feature-list">
            <li><Check /> <strong>{wallets.pro.display}</strong> saved wallets</li>
            <li><Check /> <strong>{concierge.pro.display}</strong> AI Concierge messages / day</li>
            <li><Check /> Real-time sniper feed (30-sec refresh)</li>
            <li><Check /> All collections fully enabled — Top Shot, All Day, Golazos, Pinnacle, UFC</li>
            <li><Check /> Full Fast Break optimizer + Pack EV w/ confidence intervals</li>
            <li><Check /> Full Pinnacle FMV (triple-key joins)</li>
            <li><Check /> <strong>Insider Signals</strong> — institutional flow tracking</li>
            <li><Check /> <strong>{alerts.pro.display}</strong> custom alerts (price drops, listing hits, watchlist)</li>
            <li><Check /> <strong>{api.pro.display}</strong> API requests / day</li>
            <li><Check /> Custom Discord roles</li>
          </ul>
          <StripeSubscribeButton style={{ marginTop: 4, width: "100%" }} />
          <div className="rpc-pr-cta-note">
            Cancel anytime · 30-day money-back · Stripe-secured
          </div>
        </div>
      </section>

      {/* ── Differentiators table ──────────────────────────────────────── */}
      <section className="rpc-pr-detail">
        <h2 className="rpc-pr-h2">The 4 things that change when you go Pro</h2>
        <div className="rpc-pr-diff-grid">
          <Diff
            title="Track everything"
            free={wallets.free.display + (wallets.free.raw === 1 ? " wallet" : " wallets")}
            pro={wallets.pro.display}
            blurb="Watch your whole collection across multiple wallets, plus track competitors and whales."
          />
          <Diff
            title="Custom alerts"
            free={alerts.free.raw === 0 ? "None" : alerts.free.display}
            pro={alerts.pro.display + " alerts"}
            blurb="Price-drop, listing, and watchlist alerts delivered via email or Telegram the moment they fire."
          />
          <Diff
            title="AI Concierge"
            free={concierge.free.display + " / day"}
            pro={concierge.pro.display + " / day"}
            blurb="Ask Claude about your collection: ROI, FMV trends, deal-of-the-day, set completion paths."
          />
          <Diff
            title="API access"
            free={api.free.display + " / day"}
            pro={api.pro.display + " / day"}
            blurb="100x the throughput for building bots, dashboards, and external integrations."
          />
        </div>
      </section>

      {/* ── What's included (deep list) ───────────────────────────────── */}
      <section className="rpc-pr-detail">
        <h2 className="rpc-pr-h2">What&apos;s included with Pro</h2>
        <div className="rpc-pr-included-grid">
          <Bucket title="Intelligence">
            <li>Insider Signals — institutional flow tracking</li>
            <li>Whale Watch — top-buyer leaderboards across 5 collections</li>
            <li>Hot Editions 24h — emerging-volume detection</li>
            <li>Daily portfolio FMV snapshots + 30-day history chart</li>
          </Bucket>
          <Bucket title="FMV + Pricing">
            <li>Full FMV across Top Shot, All Day, Golazos, Pinnacle, UFC</li>
            <li>Pinnacle triple-key joins (royalty:variant:printing)</li>
            <li>Pack EV with confidence intervals + depletion forecasting</li>
            <li>Fast Break optimizer (lineup ROI maximization)</li>
          </Bucket>
          <Bucket title="Tools">
            <li>Real-time sniper feed (30-sec refresh vs 5-min)</li>
            <li>{alerts.pro.display} custom alerts (any channel)</li>
            <li>Unlimited saved wallets + watchlists</li>
            <li>{api.pro.display.toLocaleString()} API req/day for automation</li>
          </Bucket>
          <Bucket title="Community">
            <li>{concierge.pro.display} AI Concierge messages / day</li>
            <li>Custom Discord role</li>
            <li>Priority support via @tdillonbond</li>
            <li>Direct line for feature requests</li>
          </Bucket>
        </div>
      </section>

      {/* ── Bottom CTA ─────────────────────────────────────────────────── */}
      <section className="rpc-pr-bottom-cta">
        <h2 className="rpc-pr-h2">Ready to upgrade?</h2>
        <div className="rpc-pr-bottom-row">
          <StripeSubscribeButton />
          <Link href="/login" className="rpc-pr-cta-link">
            Or stay on Free →
          </Link>
        </div>
        <p className="rpc-pr-footnote">
          Quotas above are read live from Supabase. If we tune a limit it
          reflects here within 60 seconds.{" "}
          <Link href="/legal/fmv-methodology" className="rpc-pr-cta-link">
            How is FMV calculated? →
          </Link>
        </p>
      </section>
    </main>
  )
}

// ─── Atoms ────────────────────────────────────────────────────────────────

function Bullet({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        color: muted ? "var(--rpc-text-ghost)" : "var(--rpc-text-muted)",
        marginRight: 6,
      }}
    >
      ·
    </span>
  )
}

function Check() {
  return (
    <span aria-hidden style={{ color: "var(--rpc-red, #E03A2F)", marginRight: 6, fontWeight: 700 }}>
      ✓
    </span>
  )
}

function Diff({ title, free, pro, blurb }: { title: string; free: string; pro: string; blurb: string }) {
  return (
    <div className="rpc-pr-diff">
      <div className="rpc-pr-diff-title">{title}</div>
      <div className="rpc-pr-diff-row">
        <span className="rpc-pr-diff-label">Free</span>
        <span className="rpc-pr-diff-val rpc-pr-diff-free">{free}</span>
      </div>
      <div className="rpc-pr-diff-row">
        <span className="rpc-pr-diff-label">Pro</span>
        <span className="rpc-pr-diff-val rpc-pr-diff-pro">{pro}</span>
      </div>
      <div className="rpc-pr-diff-blurb">{blurb}</div>
    </div>
  )
}

function Bucket({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rpc-pr-bucket">
      <div className="rpc-pr-bucket-title">{title}</div>
      <ul className="rpc-pr-bucket-list">{children}</ul>
    </div>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────

const S: { page: React.CSSProperties } = {
  page: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "48px 20px 80px",
    color: "var(--rpc-text-primary)",
  },
}

const CSS = `
  .rpc-pr-hero { display: flex; flex-direction: column; gap: 12px; margin-bottom: 36px; }
  .rpc-pr-eyebrow {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--rpc-red, #E03A2F);
  }
  .rpc-pr-h1 {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900;
    font-size: 56px; line-height: 1.05; letter-spacing: 0.02em;
    text-transform: uppercase; margin: 0; color: var(--rpc-text-primary);
  }
  .rpc-pr-lede {
    font-family: var(--font-mono); font-size: 14px; line-height: 1.7;
    color: var(--rpc-text-secondary); margin: 4px 0 0; max-width: 680px;
  }
  .rpc-pr-price-row {
    display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-top: 10px;
  }
  .rpc-pr-price { display: flex; align-items: baseline; gap: 4px; }
  .rpc-pr-price-amount {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 48px;
    color: var(--rpc-text-primary); letter-spacing: 0.01em;
  }
  .rpc-pr-price-amount-sm {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 32px;
    color: var(--rpc-text-primary);
  }
  .rpc-pr-price-unit {
    font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--rpc-text-muted); margin-left: 4px;
  }
  .rpc-pr-grandfather {
    background: rgba(255, 200, 87, 0.08);
    border: 1px solid rgba(255, 200, 87, 0.3);
    border-radius: var(--radius-md, 8px);
    padding: 12px 14px;
    font-family: var(--font-mono); font-size: 12px;
    color: var(--rpc-text-secondary); margin-top: 8px;
  }
  .rpc-pr-grandfather strong { color: var(--rpc-text-primary); }

  .rpc-pr-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 48px;
  }
  .rpc-pr-card {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-lg, 12px); padding: 28px;
    display: flex; flex-direction: column; gap: 14px;
    font-family: var(--font-mono); color: var(--rpc-text-secondary);
  }
  .rpc-pr-card-pro {
    border-color: var(--rpc-red-border, rgba(224,58,47,0.4));
    background: linear-gradient(180deg, rgba(224,58,47,0.05), var(--rpc-surface));
  }
  .rpc-pr-plan-row { display: flex; align-items: center; gap: 10px; }
  .rpc-pr-plan-name {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 24px;
    letter-spacing: 0.04em; text-transform: uppercase; color: var(--rpc-text-primary);
  }
  .rpc-pr-badge {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.14em;
    text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
    background: var(--rpc-red-bg, rgba(224,58,47,0.1));
    border: 1px solid var(--rpc-red-border, rgba(224,58,47,0.3));
    color: var(--rpc-red, #E03A2F);
  }
  .rpc-pr-price-secondary { display: flex; align-items: baseline; gap: 4px; }
  .rpc-pr-feature-list {
    margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;
    gap: 9px; font-size: 12.5px; line-height: 1.55;
  }
  .rpc-pr-feature-list li { display: flex; align-items: flex-start; gap: 4px; }
  .rpc-pr-feature-list strong { color: var(--rpc-text-primary); }

  .rpc-pr-cta {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--rpc-red, #E03A2F); color: #fff;
    padding: 12px 22px; border-radius: var(--radius-sm, 6px);
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase;
    text-decoration: none; margin-top: 6px;
  }
  .rpc-pr-cta-ghost {
    background: transparent; color: var(--rpc-text-primary);
    border: 1px solid var(--rpc-border);
  }
  .rpc-pr-cta-note {
    font-family: var(--font-mono); font-size: 10px; color: var(--rpc-text-muted);
    text-align: center; letter-spacing: 0.04em;
  }
  .rpc-pr-cta-link {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--rpc-text-secondary); text-decoration: none;
    border-bottom: 1px dotted var(--rpc-text-muted);
  }
  .rpc-pr-cta-link:hover { color: var(--rpc-red, #E03A2F); }

  .rpc-pr-detail { margin-bottom: 48px; }
  .rpc-pr-h2 {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900;
    font-size: 28px; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--rpc-text-primary); margin: 0 0 18px;
  }
  .rpc-pr-diff-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  }
  .rpc-pr-diff {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-md, 8px); padding: 16px;
    display: flex; flex-direction: column; gap: 6px;
    font-family: var(--font-mono);
  }
  .rpc-pr-diff-title {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--rpc-text-primary); margin-bottom: 4px;
  }
  .rpc-pr-diff-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; }
  .rpc-pr-diff-label { color: var(--rpc-text-muted); letter-spacing: 0.08em; text-transform: uppercase; font-size: 10px; }
  .rpc-pr-diff-val { font-weight: 700; }
  .rpc-pr-diff-free { color: var(--rpc-text-secondary); }
  .rpc-pr-diff-pro { color: var(--rpc-red, #E03A2F); }
  .rpc-pr-diff-blurb { font-size: 11px; line-height: 1.5; color: var(--rpc-text-secondary); margin-top: 6px; }

  .rpc-pr-included-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  }
  .rpc-pr-bucket {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-md, 8px); padding: 16px;
  }
  .rpc-pr-bucket-title {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--rpc-red, #E03A2F); margin-bottom: 10px;
  }
  .rpc-pr-bucket-list {
    margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 6px;
    font-family: var(--font-mono); font-size: 12px; line-height: 1.55;
    color: var(--rpc-text-secondary);
  }

  .rpc-pr-bottom-cta {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-lg, 12px); padding: 28px;
    text-align: center;
  }
  .rpc-pr-bottom-row {
    display: flex; align-items: center; justify-content: center; gap: 20px;
    flex-wrap: wrap; margin: 14px 0 8px;
  }
  .rpc-pr-footnote {
    font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted);
    margin: 8px 0 0; line-height: 1.6;
  }

  @media (max-width: 700px) {
    .rpc-pr-h1 { font-size: 36px; }
    .rpc-pr-h2 { font-size: 22px; }
    .rpc-pr-grid { grid-template-columns: 1fr; }
    .rpc-pr-price-row { gap: 14px; }
    .rpc-pr-price-amount { font-size: 36px; }
  }
`
