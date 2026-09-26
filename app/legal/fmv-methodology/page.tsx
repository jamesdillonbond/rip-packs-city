// app/legal/fmv-methodology/page.tsx
//
// Long-form FMV methodology disclosure. Linked from every FMV display
// surface (wallet table, sniper, pack EV, dashboard hero, footer) via
// the inline FmvDisclaimer "How is FMV calculated?" link.

import Link from "next/link"
import {
  ASK_CORROBORATION_BAND,
  MIN_SALES_30D_HIGH,
  MIN_SALES_30D_MEDIUM,
  MIN_SALES_ASK_CORROBORATION,
} from "@/lib/fmv-confidence"

export const dynamic = "force-static"
export const revalidate = 86400

export const metadata = {
  title: "FMV Methodology",
  alternates: { canonical: "https://www.rippackscity.com/legal/fmv-methodology" },
  description:
    "How Rip Packs City calculates Fair Market Value: signals, confidence levels, and the explicit limits of what FMV does and doesn't account for.",
}

const PAGE_STYLE: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 20px 72px",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  lineHeight: 1.75,
}

const H1: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 36,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: "0 0 32px",
}

const H2: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: "32px 0 12px",
}

const H3: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 700,
  fontSize: 16,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: "20px 0 8px",
}

const P: React.CSSProperties = {
  margin: "0 0 14px",
  color: "var(--rpc-text-secondary)",
}

const STRONG: React.CSSProperties = {
  color: "var(--rpc-text-primary)",
  fontWeight: 700,
}

const UL: React.CSSProperties = {
  margin: "0 0 14px",
  paddingLeft: 22,
  color: "var(--rpc-text-secondary)",
}

const FOOTNOTE: React.CSSProperties = {
  marginTop: 32,
  paddingTop: 16,
  borderTop: "1px solid var(--rpc-border)",
  fontSize: 11,
  color: "var(--rpc-text-muted)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
}

export default function FmvMethodologyPage() {
  return (
    <article style={PAGE_STYLE}>
      <h1 style={H1}>How Rip Packs City Calculates Fair Market Value</h1>

      <h2 style={H2}>What FMV Means Here</h2>
      <p style={P}>
        Fair Market Value (FMV) on RPC is our best estimate of what a moment would
        realistically transact for if listed at fair price today. It is{" "}
        <strong style={STRONG}>
          not an appraisal, not investment advice, and not a guarantee of future sale price
        </strong>
        . We publish it to help you make better collecting decisions, not to set
        your expectations of what your moments are worth in dollar terms.
      </p>

      <h2 style={H2}>How We Compute It</h2>
      <p style={P}>
        Our FMV pipeline runs on every collection (NBA Top Shot, NFL All Day, Disney
        Pinnacle, LaLiga Golazos, UFC Strike) on a continuous cycle. For each unique
        edition, we look at three signal sources:
      </p>

      <h3 style={H3}>Recent sales (primary signal)</h3>
      <p style={P}>
        We pull every confirmed sale from the past 30 days, filter outliers (top
        and bottom 5% by price), and compute an average sales price where
        more recent sales count more than older ones (a recency-weighted average). Sales below 24 hours old
        carry the most weight; sales 28+ days old are discounted but still
        informative.
      </p>

      <h3 style={H3}>Active asks (secondary signal)</h3>
      <p style={P}>
        We snapshot the lowest active listing price across NBA Top Shot's native
        marketplace and Flowty's secondary market. The lowest ask sets a soft
        ceiling — if no one will pay above this, FMV shouldn't either.
      </p>

      <h3 style={H3}>Distributional shape</h3>
      <p style={P}>
        For editions with enough sales (&gt;10 in the past 30 days), we publish
        10th, 50th, and 90th percentile prices alongside the single FMV number,
        so you can see the full distribution rather than just a midpoint.
      </p>

      <h2 style={H2}>Confidence Levels</h2>
      <p style={P}>
        Every FMV we compute is graded with one of these confidence levels. We use
        the grade to decide how a price is shown — boards only surface deals on
        well-supported prices, and an ask-based estimate is marked as one — rather
        than printing a badge on every tile. The thresholds below are read from the
        same code that grades the prices.
      </p>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>HIGH</strong> — {MIN_SALES_30D_HIGH}+ sales in the
          last 30 days, and they agree closely once serial number is accounted
          for.
        </li>
        <li>
          <strong style={STRONG}>MEDIUM</strong> — {MIN_SALES_30D_MEDIUM}+ recent
          sales (from {MIN_SALES_30D_HIGH} on, their prices must also be reasonably
          consistent); or at least{" "}
          {MIN_SALES_ASK_CORROBORATION} sales whose median sits within ±
          {Math.round(ASK_CORROBORATION_BAND * 100)}% of a current listing (a live ask
          only ever raises confidence, never lowers a price).
        </li>
        <li>
          <strong style={STRONG}>LOW</strong> — directional, not precise. It
          means one of two opposite things, and it matters which:
          <ul style={UL}>
            <li>
              <strong style={STRONG}>Too few sales</strong> — fewer than{" "}
              {MIN_SALES_30D_MEDIUM} recent sales to price from.
            </li>
            <li>
              <strong style={STRONG}>Sales disagree</strong> — the edition trades
              actively ({MIN_SALES_30D_HIGH}+ recent sales), but the prices are
              spread too widely to call one number reliable: prices moving within
              the month, or sales far below the rest. Where we show a 30-day price range beside the price
              (for example <em>$4.00–$6.00 30d</em>, the typical spread of real
              sales), that range is the better guide.
            </li>
          </ul>
        </li>
        <li>
          <strong style={STRONG}>SALES_ONLY</strong> — Sales-based estimate where
          no live ask is available.
        </li>
        <li>
          <strong style={STRONG}>ASK_ONLY</strong> — Estimate based on lowest
          active ask only; no recent sales to validate. Treat with skepticism.
        </li>
        <li>
          <strong style={STRONG}>NO_DATA</strong> — No FMV available. We will not
          display a number rather than guess.
        </li>
        <li>
          <strong style={STRONG}>STALE</strong> — Underlying data is more than 7
          days old.
        </li>
        <li>
          <strong style={STRONG}>Editions that have stopped trading.</strong> When
          an edition has had no sale in 30 days and no live ask, its estimate is
          the median of its sales from the 90 days before its most recent sale
          (always at least its 3 most recent sales, at most 30), labelled STALE or
          SALES_ONLY. A price from a period when the edition traded higher is
          never carried forward past its latest market.
        </li>
      </ul>

      <h2 style={H2}>What FMV Does NOT Account For</h2>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Special serials.</strong> Jersey-match (#23 of
          LeBron), birthday matches, consecutive serials, or other
          serial-significance premiums are reflected via a separate{" "}
          <code>serialMultiplier</code> on each moment, not in the base edition
          FMV.
        </li>
        <li>
          <strong style={STRONG}>Badges.</strong> Top Shot Score badges, official
          badges, and challenge rewards are separately tracked and may add value
          above edition-level FMV.
        </li>
        <li>
          <strong style={STRONG}>Sentiment.</strong> A player getting traded or a
          viral moment of the week can spike prices in hours. FMV updates daily,
          so high-momentum events lag.
        </li>
        <li>
          <strong style={STRONG}>Locked moments.</strong> A locked moment cannot
          be sold during its lock period; we do not discount FMV for this.
        </li>
      </ul>

      <h2 style={H2}>Limitations and Disclaimer</h2>
      <p style={P}>
        FMV is generated by automated software using publicly-available
        marketplace data. We make no warranty as to its accuracy. Prices in any
        digital collectibles market can move rapidly.{" "}
        <strong style={STRONG}>
          Do not treat FMV as a basis for financial decisions of any consequence.
        </strong>{" "}
        If you are buying or selling, do your own research and consult an advisor
        for any meaningful transaction.
      </p>
      <p style={P}>
        For technical questions about how FMV is computed, contact us through the
        in-app concierge.
      </p>

      <div style={FOOTNOTE}>
        Last updated: May 2026. ·{" "}
        <Link href="/" style={{ color: "var(--rpc-text-muted)" }}>
          Back to home
        </Link>
      </div>
    </article>
  )
}
