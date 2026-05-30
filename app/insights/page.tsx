// app/insights/page.tsx
//
// Public landing page for the /insights surface. Free, no signup. Per the
// 2026-05-29 4-week launch plan: this is the entry door to the public wedge
// surfaces. As of 2026-05-30 five surfaces are live — A (squeeze), B
// (pack-reality), C (rookies), D (first-mint), E (cross-collection).

import Link from "next/link"

export const dynamic = "force-static"

type Card = {
  slug: string | null
  eyebrow: string
  title: string
  blurb: string
  cta: string
  available: boolean
}

const CARDS: Card[] = [
  {
    slug: "/insights/squeeze",
    eyebrow: "Surface A · Live",
    title: "The Lock-Rate Squeeze Board",
    blurb:
      "Top Shot's site shows you circulation. We show you effective supply — circulation minus the moments locked in challenges and the moments already burned. Editions over 50% squeeze.",
    cta: "Open squeeze board",
    available: true,
  },
  {
    slug: "/insights/pack-reality",
    eyebrow: "Surface B · Live",
    title: "Pack Reality",
    blurb:
      "We audited every Top Shot pack ripped in the last 60 days. 128,220 rips. Median pull value $0. Honest pack ranker with confidence flags on every +EV claim.",
    cta: "Open pack reality",
    available: true,
  },
  {
    slug: "/insights/rookies",
    eyebrow: "Surface C · Live",
    title: "2025 Rookie Class Index",
    blurb:
      "The 2025 NBA rookie class as a cohort. 30-day GMV, lock-rate, average price, first-mint trophy multipliers. Dylan Harper $21k GMV, Kon Knueppel 54% locked.",
    cta: "Open rookie index",
    available: true,
  },
  {
    slug: "/insights/first-mint",
    eyebrow: "Surface D · Live",
    title: "First-Mint Trophy Tracker",
    blurb:
      "Trophies aren't a vibe — they're math. Every TS serial #1 sale of the last 90 days vs the average-serial price for the same edition. Avg 15.8×, max 248×.",
    cta: "Open trophy tracker",
    available: true,
  },
  {
    slug: "/insights/cross-collection",
    eyebrow: "Surface E · Live",
    title: "Cross-Collection Whale Map",
    blurb:
      "143 wallets hold 3+ Flow blockchain collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. Cohort distribution, top wallets, what they actually collect.",
    cta: "Open whale map",
    available: true,
  },
  {
    slug: "/insights/set-squeeze",
    eyebrow: "Surface G · Live",
    title: "Set Squeeze Leaderboard",
    blurb:
      "Drill-down companion to Surface A. Top Shot sets ranked by average lock + burn across editions. WNBA Squad Goals 76% avg, 2023 NBA Playoffs 76%, Metallic Gold LE 74%.",
    cta: "Open set leaderboard",
    available: true,
  },
  {
    slug: "/insights/pinnacle-scarcity",
    eyebrow: "Surface H · Live",
    title: "Disney Pinnacle Scarcity Board",
    blurb:
      "Pinnacle doesn't have lock + burn. Its scarcity is mint count + variant family + chaser status. Editions ranked by how far below their variant family's average mint they sit.",
    cta: "Open Pinnacle board",
    available: true,
  },
  {
    slug: "/insights/squeeze-check",
    eyebrow: "Tool · Live",
    title: "What's Liquid In Your Bag?",
    blurb:
      "Paste your Flow wallet, see how much of your Top Shot collection is actually liquid vs sitting in challenge-locked or burned editions. Personal, free, no signup.",
    cta: "Check your wallet",
    available: true,
  },
]

export default function InsightsIndexPage() {
  return (
    <main className="rpc-ins-page">
      <style>{CSS}</style>

      <section className="rpc-ins-hero">
        <div className="rpc-ins-eyebrow">Rip Packs City · Public Insights</div>
        <h1 className="rpc-ins-h1">Things Top Shot won&apos;t tell you.</h1>
        <p className="rpc-ins-lede">
          Free, no signup. Built for the collector who wants the math, not
          the marketing. Seven wedges of intelligence the marketplace
          structurally can&apos;t (or won&apos;t) ship, plus a tool to
          check your own wallet.
        </p>
      </section>

      <section className="rpc-ins-grid">
        {CARDS.map((c) => {
          const Inner = (
            <article className={`rpc-ins-card ${c.available ? "" : "rpc-ins-card-soon"}`}>
              <div className="rpc-ins-card-eyebrow">{c.eyebrow}</div>
              <h2 className="rpc-ins-card-title">{c.title}</h2>
              <p className="rpc-ins-card-blurb">{c.blurb}</p>
              <div className="rpc-ins-card-cta">
                {c.cta}
                {c.available ? <span aria-hidden> →</span> : null}
              </div>
            </article>
          )
          return c.slug ? (
            <Link key={c.title} href={c.slug} className="rpc-ins-card-link">
              {Inner}
            </Link>
          ) : (
            <div key={c.title} className="rpc-ins-card-link rpc-ins-card-link-disabled">
              {Inner}
            </div>
          )
        })}
      </section>

      <section className="rpc-ins-footer">
        <div className="rpc-ins-footer-text">
          More analytics behind the login (free):{" "}
          <Link href="/login" className="rpc-ins-footer-link">
            sign in →
          </Link>
        </div>
      </section>
    </main>
  )
}

const CSS = `
.rpc-ins-page {
  min-height: 100vh;
  background: var(--rpc-black);
  color: var(--rpc-text-primary);
  font-family: var(--font-body);
  padding: 48px 20px 80px;
}
.rpc-ins-hero {
  max-width: 1180px;
  margin: 0 auto 40px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rpc-border-subtle);
}
.rpc-ins-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 14px;
}
.rpc-ins-h1 {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(40px, 6.5vw, 72px);
  line-height: 1;
  text-transform: uppercase;
  margin: 0 0 16px;
  letter-spacing: 0.5px;
}
.rpc-ins-lede {
  font-family: var(--font-body);
  font-size: 19px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  max-width: 760px;
  margin: 0;
}
.rpc-ins-grid {
  max-width: 1180px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
@media (min-width: 1100px) {
  .rpc-ins-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.rpc-ins-card-link {
  text-decoration: none;
  color: inherit;
  display: block;
}
.rpc-ins-card {
  background: var(--rpc-surface);
  border: 1px solid var(--rpc-border);
  border-radius: 4px;
  padding: 28px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  transition: border-color 120ms, transform 120ms, background 120ms;
}
.rpc-ins-card-link:hover .rpc-ins-card { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-2px); }
.rpc-ins-card-link-disabled { cursor: default; }
.rpc-ins-card-link-disabled:hover .rpc-ins-card { border-color: var(--rpc-border); background: var(--rpc-surface); transform: none; }
.rpc-ins-card-soon { opacity: 0.65; }
.rpc-ins-card-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 14px;
}
.rpc-ins-card-title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 26px;
  line-height: 1.1;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 12px;
}
.rpc-ins-card-blurb {
  font-size: 14px;
  line-height: 1.6;
  color: var(--rpc-text-secondary);
  margin: 0 0 22px;
  flex: 1;
}
.rpc-ins-card-cta {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-red);
}
.rpc-ins-card-soon .rpc-ins-card-cta { color: var(--rpc-text-muted); }

.rpc-ins-footer {
  max-width: 1180px;
  margin: 48px auto 0;
  padding-top: 24px;
  border-top: 1px solid var(--rpc-border-subtle);
}
.rpc-ins-footer-text {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
}
.rpc-ins-footer-link { color: var(--rpc-red); text-decoration: none; }
.rpc-ins-footer-link:hover { color: var(--rpc-red-hover); }

@media (max-width: 880px) {
  .rpc-ins-grid { grid-template-columns: 1fr; }
}
`
