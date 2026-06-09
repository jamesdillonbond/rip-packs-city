// app/pricing/page.tsx
//
// Public page (proxy.ts allows unauth'd visitors). Phase 1 of RPC is a free
// invite-only beta — policy is NO paywall/monetization until 50+ WAU, so this
// page tells that truth instead of advertising a Pro tier that isn't shipping
// features today. The Stripe checkout plumbing stays in the repo but is gated
// behind NEXT_PUBLIC_PRO_CHECKOUT_ENABLED (default off) for the day the WAU
// gate clears — flip the env var, no code change, to re-light paid checkout.
//
// Feature list below is HONEST: only what's actually live today. Brand tokens only.

import Link from "next/link"
import StripeSubscribeButton from "@/components/pricing/StripeSubscribeButton"

export const dynamic = "force-dynamic"
export const revalidate = 60

const CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_PRO_CHECKOUT_ENABLED === "true"

export const metadata = {
  title: "Pricing — Rip Packs City",
  description:
    "Rip Packs City is in free invite-only beta — every feature unlocked at no cost for invitees. FMV across all five Flow collections, deal-finding, pack EV, wallet analytics, and a Claude-powered concierge.",
}

export default function PricingPage() {
  return (
    <main style={S.page}>
      <style>{CSS}</style>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="rpc-pr-hero">
        <div className="rpc-pr-eyebrow">Rip Packs City</div>
        <h1 className="rpc-pr-h1">Everything unlocked. Free in beta.</h1>
        <p className="rpc-pr-lede">
          RPC is the Flow blockchain digital-collectibles intelligence platform —
          real-time FMV across every collection, deal-finding, pack EV, wallet and
          portfolio analytics, and a Claude-powered concierge that talks to your
          collection. We&apos;re in Phase&nbsp;1 beta, so every feature is unlocked
          free for invitees while we build.
        </p>

        <div className="rpc-pr-price-row">
          {CHECKOUT_ENABLED ? (
            <>
              <div className="rpc-pr-price">
                <span className="rpc-pr-price-amount">$9.99</span>
                <span className="rpc-pr-price-unit">/ month</span>
              </div>
              <StripeSubscribeButton />
            </>
          ) : (
            <Link href="/login" className="rpc-pr-cta">
              Sign in / Request an invite
            </Link>
          )}
        </div>

        <div className="rpc-pr-grandfather">
          <strong>Phase 1 Beta invitees:</strong> full access is already on your
          account — nothing to buy. A paid Pro tier may arrive once RPC graduates
          beta; pricing is not set and nothing is charged today.
        </div>
      </section>

      {/* ── What you get (honest, live today) ──────────────────────────── */}
      <section className="rpc-pr-detail">
        <h2 className="rpc-pr-h2">What you get in the beta</h2>
        <div className="rpc-pr-included-grid">
          <Bucket title="FMV + Pricing">
            <li>Fair-market value on every edition across Top Shot, All Day, Golazos, UFC Strike, and Pinnacle</li>
            <li>Per-render Pinnacle FMV (each pin priced on its own sales)</li>
            <li>Confidence labels on every price, so you know how solid a number is</li>
            <li>Pack EV viewer — what a pack is worth vs. what it costs</li>
          </Bucket>
          <Bucket title="Insights surfaces">
            <li>Squeeze board — supply locked + burned</li>
            <li>Below-FMV deals across Top Shot + Pinnacle</li>
            <li>First-mint tracker, 2025 rookies, the RPC index</li>
            <li>Pack reality + Pinnacle scarcity boards</li>
          </Bucket>
          <Bucket title="Your collection">
            <li>Wallet + portfolio analytics with FMV and cost basis</li>
            <li>Shareable public profile with a trophy case</li>
            <li>Sniper feed with discount-vs-FMV deal scoring + outbound listing links</li>
            <li>Set / team / player / series browse with completion tracking</li>
          </Bucket>
          <Bucket title="Concierge + rewards">
            <li>AI Concierge (Claude) on every page — ask about ROI, FMV, deals, set paths</li>
            <li>Rewards: earn Status + Credits and redeem them in the shop</li>
            <li>Verify your wallet to unlock Moment + Pro rewards (earns 500 credits)</li>
            <li>Direct line for feature requests via @tdillonbond</li>
          </Bucket>
        </div>
      </section>

      {/* ── Bottom CTA ─────────────────────────────────────────────────── */}
      <section className="rpc-pr-bottom-cta">
        <h2 className="rpc-pr-h2">Get started</h2>
        <div className="rpc-pr-bottom-row">
          {CHECKOUT_ENABLED ? (
            <StripeSubscribeButton />
          ) : (
            <Link href="/login" className="rpc-pr-cta">
              Sign in / Request an invite
            </Link>
          )}
          <Link href="/legal/fmv-methodology" className="rpc-pr-cta-link">
            How is FMV calculated? →
          </Link>
        </div>
        <p className="rpc-pr-footnote">
          Phase 1 is a free invite-only beta. No card required; nothing is charged
          while RPC is pre-launch.
        </p>
      </section>
    </main>
  )
}

// ─── Atoms ────────────────────────────────────────────────────────────────

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
  .rpc-pr-hero { display: flex; flex-direction: column; gap: 12px; margin-bottom: 48px; }
  .rpc-pr-eyebrow {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--rpc-red, #E03A2F);
  }
  .rpc-pr-h1 {
    font-family: var(--font-display); font-weight: 900;
    font-size: 56px; line-height: 1.05; letter-spacing: 0.02em;
    text-transform: uppercase; margin: 0; color: var(--rpc-text-primary);
  }
  .rpc-pr-lede {
    font-family: var(--font-mono); font-size: 14px; line-height: 1.7;
    color: var(--rpc-text-secondary); margin: 4px 0 0; max-width: 720px;
  }
  .rpc-pr-price-row {
    display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-top: 10px;
  }
  .rpc-pr-price { display: flex; align-items: baseline; gap: 4px; }
  .rpc-pr-price-amount {
    font-family: var(--font-display); font-weight: 900; font-size: 48px;
    color: var(--rpc-text-primary); letter-spacing: 0.01em;
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
    font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
    color: var(--rpc-text-secondary); margin-top: 8px; max-width: 720px;
  }
  .rpc-pr-grandfather strong { color: var(--rpc-text-primary); }

  .rpc-pr-cta {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--rpc-red, #E03A2F); color: #fff;
    padding: 12px 22px; border-radius: var(--radius-sm, 6px);
    font-family: var(--font-display); font-weight: 800;
    font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase;
    text-decoration: none;
  }
  .rpc-pr-cta-link {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--rpc-text-secondary); text-decoration: none;
    border-bottom: 1px dotted var(--rpc-text-muted);
  }
  .rpc-pr-cta-link:hover { color: var(--rpc-red, #E03A2F); }

  .rpc-pr-detail { margin-bottom: 48px; }
  .rpc-pr-h2 {
    font-family: var(--font-display); font-weight: 900;
    font-size: 28px; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--rpc-text-primary); margin: 0 0 18px;
  }
  .rpc-pr-included-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
  }
  .rpc-pr-bucket {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-md, 8px); padding: 16px;
  }
  .rpc-pr-bucket-title {
    font-family: var(--font-display); font-weight: 800;
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
    .rpc-pr-price-row { gap: 14px; }
    .rpc-pr-price-amount { font-size: 36px; }
  }
`
