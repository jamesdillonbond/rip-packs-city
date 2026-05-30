// app/insights/page.tsx
//
// Public landing page for the /insights surface. Free, no signup. Per the
// 2026-05-29 4-week launch plan: this is the entry door to the three wedge
// surfaces (squeeze, rookies, pack-reality). Only /insights/squeeze is live
// today (2026-05-30); the other two are shipped as "coming soon" cards so
// the index can launch alongside the first wedge.

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
    slug: null,
    eyebrow: "Surface B · Coming June",
    title: "Pack Reality",
    blurb:
      "We audited every Top Shot pack ripped in the last 60 days. 127,867 rips. Median pull value $0. Honest pack ranker with confidence bands and high-variance flags.",
    cta: "Coming soon",
    available: false,
  },
  {
    slug: null,
    eyebrow: "Surface C · Coming June",
    title: "2025 Rookie Class Index",
    blurb:
      "The 2025 NBA rookie class as a cohort. 30-day GMV, lock-rate, average price, first-mint trophy multipliers. Kon Knueppel 54% locked, $392 avg. Dylan Harper $21k GMV.",
    cta: "Coming soon",
    available: false,
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
          the marketing. Three wedges of intelligence the marketplace
          structurally can&apos;t (or won&apos;t) ship.
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
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
