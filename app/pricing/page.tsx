// app/pricing/page.tsx
//
// Public page (proxy.ts allows unauth'd visitors). Phase 1 of RPC is a free
// beta — self-serve signup is open (no invite needed as of 2026-07-20); policy
// is NO paywall/monetization until 50+ WAU, so this
// page tells that truth instead of advertising a Pro tier that isn't shipping
// features today. The Stripe checkout plumbing stays in the repo but is gated
// behind NEXT_PUBLIC_PRO_CHECKOUT_ENABLED (default off) for the day the WAU
// gate clears — flip the env var, no code change, to re-light paid checkout.
//
// Feature list below is HONEST: only what's actually live today. Brand tokens only.

import Link from "next/link"
import type { Metadata } from "next"
import StripeSubscribeButton from "@/components/pricing/StripeSubscribeButton"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const dynamic = "force-dynamic"
export const revalidate = 60

const CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_PRO_CHECKOUT_ENABLED === "true"

// Title uses `absolute` deliberately: the root metadata template in lib/seo.ts
// appends " | Rip Packs City", so the previous hardcoded "Pricing — Rip Packs
// City" rendered as "Pricing — Rip Packs City | Rip Packs City". Same opt-out as
// app/insights/candy-mlb/layout.tsx. Canonical + page-specific OG added at the
// same time (2026-08-01) — this page is public, footer-linked and now in the
// sitemap, but every share of it inherited the site-default card.
export const metadata: Metadata = {
  title: { absolute: "Pricing — Rip Packs City" },
  description:
    "Rip Packs City is free. Every feature unlocked at no cost — no invite, no card, no catch. FMV across all five Flow collections, deal-finding, pack EV, wallet analytics, and a Claude-powered concierge.",
  alternates: { canonical: `${SITE_URL}/pricing` },
  openGraph: {
    title: "Pricing — Everything unlocked, free",
    description:
      "Rip Packs City is free. FMV, deal-finding, pack EV, wallet analytics and a Claude-powered concierge across all five Flow collections. No invite, no card, no catch.",
    url: `${SITE_URL}/pricing`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/default`,
        width: 1200,
        height: 630,
        alt: "Rip Packs City — everything unlocked, free",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — Everything unlocked, free",
    description:
      "Rip Packs City is free. No invite, no card, no catch.",
    images: [`${SITE_URL}/api/og/default`],
    creator: "@RipPacksCity",
  },
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
          collection. Everything is free. No invite, no card, no catch.
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
              Create your free account
            </Link>
          )}
        </div>

        {/* This block used to address "Phase 1 Beta invitees". Self-serve signup
            opened 2026-07-20 (see the front-door change to check_email_allowed),
            so invite language is not just stale — it tells a first-time visitor
            they need something they do not need, on the page whose entire job is
            removing friction. (2026-08-01) */}
        <div className="rpc-pr-grandfather">
          <strong>Already signed up?</strong> Full access is already on your
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
            {/* "Confidence labels" named an internal scoring enum a visitor has no
                way to calibrate — the standing no-confidence-UI policy. Describe
                what the reader actually gets instead. (2026-08-01) */}
            <li>Every price labelled by what it&rsquo;s derived from — recent sales, or a live ask</li>
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
            {/* The redemption shop is NOT live — app/rewards/layout.tsx notFound()s
                unconditionally, so /rewards is a hard 404. Credits genuinely accrue
                (resolve_wallet_challenge_match pays 500 on a verified wallet), so the
                honest claim is "earned and banked", not "redeem them in the shop". */}
            <li>Rewards: earn Status + Credits as you use RPC (the redemption shop isn&apos;t open yet)</li>
            <li>Verify a wallet with the listing challenge from your dashboard — earns 500 Credits</li>
            <li>Direct line for feature requests via @RipPacksCity</li>
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
              Create your free account
            </Link>
          )}
          <Link href="/legal/fmv-methodology" className="rpc-pr-cta-link">
            How is FMV calculated? →
          </Link>
        </div>
        <p className="rpc-pr-footnote">
          Everything is free. No invite, no card, no catch — sign up in seconds.
          Nothing is charged while RPC is pre-launch.
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
