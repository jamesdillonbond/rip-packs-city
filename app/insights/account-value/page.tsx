// app/insights/account-value/page.tsx
//
// Public SEO landing page targeting the "what's my <collection> account worth" /
// "<collection> account value" query cluster surfaced in GSC (the repeated
// account-value intent that was ranking page-4 on the generic /overview page).
// Server-rendered crawlable copy + the wallet-paste tool, which funnels to
// /share/<wallet> — the snapshot card that leads with the account's total FMV.
// Inherits the /insights layout chrome (email capture, footer, funnel tracker)
// and the proxy.ts public bypass for /insights/*. (2026-06-30 SEO acquisition.)

import Link from "next/link"
import AccountValueSearch from "@/components/insights/AccountValueSearch"

export const revalidate = 3600

const COLLECTIONS: Array<{ name: string; href: string }> = [
  { name: "NBA Top Shot", href: "/nba-top-shot/overview" },
  { name: "NFL All Day", href: "/nfl-all-day/overview" },
  { name: "Disney Pinnacle", href: "/disney-pinnacle/overview" },
  { name: "LaLiga Golazos", href: "/laliga-golazos/overview" },
  { name: "UFC Strike", href: "/ufc/overview" },
]

export default function AccountValuePage() {
  return (
    <main className="rpc-av-page">
      <style>{CSS}</style>

      <section className="rpc-av-hero">
        <div className="rpc-av-eyebrow">Free tool · No signup</div>
        <h1 className="rpc-av-h1">What&apos;s your account worth?</h1>
        <p className="rpc-av-lede">
          Paste your NBA Top Shot username or any Flow wallet and get your
          account&apos;s total value in seconds — every moment you own, priced at
          live fair-market value (FMV). Works across Top Shot, NFL All Day, Disney
          Pinnacle, LaLiga Golazos, and UFC Strike.
        </p>
        <AccountValueSearch />
        <div className="rpc-av-trust">
          No wallet connection. No signup. Read-only — we never touch your moments.
        </div>
      </section>

      <section className="rpc-av-body">
        <div className="rpc-av-block">
          <h2 className="rpc-av-h2">How your account value is calculated</h2>
          <p>
            We total every moment in the wallet at its current FMV — Rip Packs
            City&apos;s fair-market value, derived from recent verified sales, the
            live floor ask, and how recently it traded. It&apos;s the same pricing
            that powers our deal boards and per-edition pages — not a blended floor
            that undercounts what your collection is really worth.
          </p>
          <p>
            <Link href="/legal/fmv-methodology" className="rpc-av-link">
              How FMV is calculated →
            </Link>
          </p>
        </div>

        <div className="rpc-av-block">
          <h2 className="rpc-av-h2">What you&apos;ll see</h2>
          <ul className="rpc-av-list">
            <li>Your total account value, with a per-collection breakdown.</li>
            <li>Your most valuable moments, each priced at live FMV.</li>
            <li>Top Shot squeeze, rookie, and trophy intel for the wallet.</li>
            <li>A shareable card — send your collection value to anyone.</li>
          </ul>
          <p>
            Want the deep cut? Run the{" "}
            <Link href="/insights/tc-report" className="rpc-av-link">
              Top Collector Report →
            </Link>{" "}
            for set completion, cross-collection footprint, and recent acquisitions.
          </p>
        </div>

        <div className="rpc-av-block">
          <h2 className="rpc-av-h2">Check any collection</h2>
          <p>Account value works for every published Flow collection:</p>
          <div className="rpc-av-colls">
            {COLLECTIONS.map((c) => (
              <Link key={c.href} href={c.href} className="rpc-av-coll">
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="rpc-av-footer">
        <Link href="/insights" className="rpc-av-footer-link">
          ← All public insights
        </Link>
      </section>
    </main>
  )
}

const CSS = `
.rpc-av-page { min-height: 100vh; background: var(--rpc-black); color: var(--rpc-text-primary); font-family: var(--font-body); padding: 48px 20px 80px; }
.rpc-av-hero { max-width: 880px; margin: 0 auto 36px; padding-bottom: 28px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-av-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 14px; }
.rpc-av-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); line-height: 1; text-transform: uppercase; margin: 0 0 16px; letter-spacing: 0.5px; }
.rpc-av-lede { font-size: 19px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 720px; margin: 0; }
.rpc-av-trust { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); margin-top: 14px; }
.rpc-av-body { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
.rpc-av-block p { font-size: 15px; line-height: 1.7; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-av-h2 { font-family: var(--font-display); font-weight: 800; font-size: 24px; line-height: 1.1; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 14px; }
.rpc-av-list { margin: 0 0 12px; padding-left: 20px; }
.rpc-av-list li { font-size: 15px; line-height: 1.7; color: var(--rpc-text-secondary); margin-bottom: 6px; }
.rpc-av-link { color: var(--rpc-red); text-decoration: none; font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.5px; }
.rpc-av-colls { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.rpc-av-coll { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-primary); text-decoration: none; border: 1px solid var(--rpc-border); border-radius: 4px; padding: 8px 14px; transition: border-color 120ms; }
.rpc-av-coll:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-av-footer { max-width: 880px; margin: 48px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); }
.rpc-av-footer-link { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-red); text-decoration: none; }
`
