// app/insights/page.tsx
//
// Public landing / index hub for the /insights surface. Free, no signup. The
// branded front door that ties every public wedge surface together, each card
// now carrying a LIVE headline stat pulled from its backing view via the
// get_insights_hub_stats RPC, plus a compact market-overview band. ISR-cached
// every 30 minutes so the numbers stay current without hitting the DB per hit.

import Link from "next/link"
import { createClient } from "@supabase/supabase-js"

export const revalidate = 1800

type HubStats = {
  insights: {
    squeezeEditions: number
    setSqueezeSets: number
    pinnacleEditions: number
    packZeroPct: number
    packRips60d: number
    rookieGmv30d: number
    rookieCount: number
    firstMintAvg: number
    firstMintMax: number
    crossCohort: number
  }
  market: { sales24h: number; gmv24h: number; sales7d: number; gmv7d: number }
  computedAt: string
}

async function getHubStats(): Promise<HubStats | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = createClient(url, key)
    const { data, error } = await sb.rpc("get_insights_hub_stats")
    if (error || !data) return null
    return data as HubStats
  } catch {
    return null
  }
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

function liveStat(slug: string | null, s: HubStats["insights"]): string | null {
  switch (slug) {
    case "/insights/squeeze":
      return `${s.squeezeEditions.toLocaleString()} editions ≥50% squeezed`
    case "/insights/pack-reality":
      return `${s.packZeroPct}% of rips pull $0 · ${s.packRips60d.toLocaleString()} rips/60d`
    case "/insights/rookies":
      return `${fmtUsd(s.rookieGmv30d)} GMV/30d · ${s.rookieCount} rookies`
    case "/insights/first-mint":
      return `avg ${s.firstMintAvg}× · max ${s.firstMintMax}×`
    case "/insights/cross-collection":
      return `${s.crossCohort} wallets hold 3+ collections`
    case "/insights/set-squeeze":
      return `${s.setSqueezeSets} sets ranked`
    case "/insights/pinnacle-scarcity":
      return `${s.pinnacleEditions} editions ranked`
    default:
      return null
  }
}

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
      "Top Shot's site shows you circulation. We show you effective supply — circulation minus the moments locked in challenges and the moments already burned. Every edition over 50% squeeze.",
    cta: "Open squeeze board",
    available: true,
  },
  {
    slug: "/insights/pack-reality",
    eyebrow: "Surface B · Live",
    title: "Pack Reality",
    blurb:
      "We audit every Top Shot pack ripped in the last 60 days. Honest pack ranker with a confidence flag on every +EV claim — and the median pull value the marketplace never advertises.",
    cta: "Open pack reality",
    available: true,
  },
  {
    slug: "/insights/rookies",
    eyebrow: "Surface C · Live",
    title: "2025 Rookie Class Index",
    blurb:
      "The 2025 NBA rookie class as a cohort. 30-day GMV, lock-rate, average price, and first-mint trophy multipliers, player by player.",
    cta: "Open rookie index",
    available: true,
  },
  {
    slug: "/insights/first-mint",
    eyebrow: "Surface D · Live",
    title: "First-Mint Trophy Tracker",
    blurb:
      "Trophies aren't a vibe — they're math. Every TS serial #1 sale of the last 90 days vs the average-serial price for the same edition.",
    cta: "Open trophy tracker",
    available: true,
  },
  {
    slug: "/insights/cross-collection",
    eyebrow: "Surface E · Live",
    title: "Cross-Collection Whale Map",
    blurb:
      "The wallets that hold 3+ Flow blockchain collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. Cohort distribution, top wallets, what they actually collect.",
    cta: "Open whale map",
    available: true,
  },
  {
    slug: "/insights/set-squeeze",
    eyebrow: "Surface G · Live",
    title: "Set Squeeze Leaderboard",
    blurb:
      "Drill-down companion to Surface A. Top Shot sets ranked by average lock + burn across their editions. The tightest sets, surfaced.",
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
    slug: "/insights/market",
    eyebrow: "Surface I · Live",
    title: "The RPC Index",
    blurb:
      "Top Shot's blended floor is a sub-$1 number dominated by commons. We segment the market by tier and index each to 100 — an honest read of what Legendary, Rare, Fandom, and Common moments are actually doing.",
    cta: "Open the index",
    available: true,
  },
  {
    slug: "/insights/offer-spread",
    eyebrow: "Surface J · Live",
    title: "Bid vs Floor",
    blurb:
      "Top Shot doesn't show you the top standing offer next to the floor ask. We do — ranked by how tightly the two meet. Liquidity vs a stale price, side by side.",
    cta: "Open bid vs floor",
    available: true,
  },
  {
    slug: "/insights/deals",
    eyebrow: "Surface K · Live",
    title: "Below FMV",
    blurb:
      "The public deals board, now cross-collection. Top Shot asks and Disney Pinnacle floors listed below a HIGH/MEDIUM-confidence FMV, ranked by discount. What's actually underpriced right now — the top-of-funnel counterpart to the sniper.",
    cta: "Open deals board",
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
  {
    slug: "/insights/tc-report",
    eyebrow: "Tool · Live",
    title: "Top Collector Report",
    blurb:
      "Full bag analytics for a wallet — squeeze exposure, set completion, cross-collection footprint, rookie + WNBA coverage, and recent acquisitions. Top Shot shows you what you own. We show you what it means.",
    cta: "Run the report",
    available: true,
  },
]

export default async function InsightsIndexPage() {
  const stats = await getHubStats()

  return (
    <main className="rpc-ins-page">
      <style>{CSS}</style>

      <section className="rpc-ins-hero">
        <div className="rpc-ins-eyebrow">Rip Packs City · Public Insights</div>
        <h1 className="rpc-ins-h1">Things Top Shot won&apos;t tell you.</h1>
        <p className="rpc-ins-lede">
          Free, no signup. Built for the collector who wants the math, not
          the marketing. The wedges of intelligence the marketplace
          structurally can&apos;t (or won&apos;t) ship — plus tools to check
          your own wallet.
        </p>
      </section>

      {stats?.market ? (
        <section className="rpc-ins-market" aria-label="Flow market pulse">
          <div className="rpc-ins-market-label">Flow market pulse</div>
          <div className="rpc-ins-market-grid">
            <div className="rpc-ins-market-kpi">
              <div className="rpc-ins-market-val">{fmtUsd(stats.market.gmv24h)}</div>
              <div className="rpc-ins-market-cap">GMV · 24h</div>
            </div>
            <div className="rpc-ins-market-kpi">
              <div className="rpc-ins-market-val">{stats.market.sales24h.toLocaleString()}</div>
              <div className="rpc-ins-market-cap">Sales · 24h</div>
            </div>
            <div className="rpc-ins-market-kpi">
              <div className="rpc-ins-market-val">{fmtUsd(stats.market.gmv7d)}</div>
              <div className="rpc-ins-market-cap">GMV · 7d</div>
            </div>
            <div className="rpc-ins-market-kpi">
              <div className="rpc-ins-market-val">{stats.market.sales7d.toLocaleString()}</div>
              <div className="rpc-ins-market-cap">Sales · 7d</div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rpc-ins-grid">
        {CARDS.map((c) => {
          const stat = stats ? liveStat(c.slug, stats.insights) : null
          const Inner = (
            <article className={`rpc-ins-card ${c.available ? "" : "rpc-ins-card-soon"}`}>
              <div className="rpc-ins-card-eyebrow">{c.eyebrow}</div>
              {stat ? <div className="rpc-ins-card-stat">{stat}</div> : null}
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
  margin: 0 auto 28px;
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
.rpc-ins-market {
  max-width: 1180px;
  margin: 0 auto 32px;
  border: 1px solid var(--rpc-border);
  border-radius: 6px;
  background: var(--rpc-surface);
  padding: 16px 20px;
}
.rpc-ins-market-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-bottom: 12px;
}
.rpc-ins-market-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.rpc-ins-market-kpi { text-align: left; }
.rpc-ins-market-val {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 28px;
  line-height: 1;
  color: var(--rpc-text-primary);
}
.rpc-ins-market-cap {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--rpc-text-muted);
  margin-top: 6px;
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
  margin-bottom: 10px;
}
.rpc-ins-card-stat {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.35;
  letter-spacing: 0.3px;
  color: var(--rpc-red);
  margin-bottom: 12px;
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
  .rpc-ins-market-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
}
`
