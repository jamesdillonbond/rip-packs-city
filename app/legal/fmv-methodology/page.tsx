// app/legal/fmv-methodology/page.tsx
//
// Long-form FMV methodology disclosure. Linked from every FMV display
// surface (wallet table, sniper, pack EV, dashboard hero, footer) via
// the inline FmvDisclaimer "How is FMV calculated?" link.
//
// 2026-10-18 (Trevor: "We shouldn't have anything user-facing that shows our
// confidence in the pricing. That should just be for internal use."): this page
// no longer publishes the internal confidence tiers (their names, thresholds or
// per-tier hit rates). It still states the FACTS a reader can use — what a price
// is based on, that an ask-derived price is marked, and that we withhold a price
// we have too little data for. The grading itself is unchanged and internal.

import Link from "next/link"
import { FMV_RECENT_SALES_N, FMV_RECENT_SPAN_DAYS, FMV_RECENT_MIN_N } from "@/lib/fmv-recalc-math"
import { fetchFmvAccuracyGate } from "@/lib/fmv-accuracy/fetchers"
import FmvAccuracyTable from "@/components/legal/FmvAccuracyTable"

export const dynamic = "force-static"
// 2026-10-11: was 86400. The page now carries the live accuracy gate (below),
// whose source refreshes ~6-hourly; and ISR caches a FAILED read for the whole
// window (register #33), so a daily window could pin "unavailable" for a day
// over a 10 s blip. One hour bounds that; the prose is unaffected.
export const revalidate = 3600

export const metadata = {
  title: "FMV Methodology",
  alternates: { canonical: "https://www.rippackscity.com/legal/fmv-methodology" },
  description:
    "How Rip Packs City calculates Fair Market Value: signals, when we show a price, and the explicit limits of what FMV does and doesn't account for.",
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

export default async function FmvMethodologyPage() {
  // The accuracy gate, read from the trust-health precompute (one small table).
  // Never throws; a failed read renders "unavailable", never a number.
  const accuracy = await fetchFmvAccuracyGate()

  return (
    <main>
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
        Our FMV pipeline runs on NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga
        Golazos, UFC Strike and Candy MLB on a continuous cycle (Panini cards have
        their own engine, described below). For each unique edition, we look at
        three signal sources:
      </p>

      <h3 style={H3}>Recent sales (primary signal)</h3>
      <p style={P}>
        We pull every confirmed sale from the past 30 days, remove the prints that
        are not about the edition&apos;s typical value (a serial #1 or jersey-number
        sale carries a collector premium; a fat-finger or wash print is an outlier),
        and publish the <strong style={STRONG}>median of the {FMV_RECENT_SALES_N} most
        recent typical sales</strong>. A median follows a moving market within hours
        on an actively traded edition and is not moved by a single unusual print;
        we measured it against every realized sale each week and it beat the
        recency-weighted average we used before, which lagged a falling market.
        On a thinly traded edition we drop any of those sales that is more than{" "}
        {FMV_RECENT_SPAN_DAYS} days older than its newest one (always keeping at least
        its {FMV_RECENT_MIN_N} most recent), so a price is not anchored to a market
        that has since moved. With fewer than {FMV_RECENT_SALES_N} typical sales we
        take the median of what there is, and where we can we show how many recent
        sales a price rests on.
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

      <h2 style={H2}>When We Show a Price</h2>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Priced from sales.</strong> Most prices come
          from recent sales, as described above. Where we can, the price is shown
          with the number of sales behind it (for example <em>7 sales / 30d</em>)
          and when the edition last sold, so you can see how much market it
          rests on.
        </li>
        <li>
          <strong style={STRONG}>Priced from a listing.</strong> When an edition
          has no sales to price from, its estimate is based on the lowest active
          ask, and it is marked <em>from asks</em>. That is what one seller is
          asking, not a completed sale &mdash; check recent sales before acting
          on it.
        </li>
        <li>
          <strong style={STRONG}>No price.</strong> When we have too little data
          to price an edition, we withhold the price rather than guess.
        </li>
        <li>
          <strong style={STRONG}>Editions that have stopped trading.</strong> When
          an edition has had no sale in 30 days and no live ask, its estimate is
          the median of its sales from the 90 days before its most recent sale
          (always at least its 3 most recent sales, at most 30). A price from a
          period when the edition traded higher is never carried forward past its
          latest market. A price that has not refreshed recently is left out of
          the dashboard&rsquo;s headline portfolio total and noted separately.
        </li>
        <li>
          <strong style={STRONG}>Price ranges.</strong> Where we show a 30-day
          price range beside a price (for example <em>$4.00&ndash;$6.00 30d</em>,
          the typical spread of real sales), that range is the better guide on an
          edition whose sales disagree.
        </li>
      </ul>
      <p style={P}>
        Deal boards only surface deals on well-supported prices.
      </p>
      <p style={P}>
        <strong style={STRONG}>Panini cards</strong> are priced from their own
        sales on Panini&rsquo;s marketplace, on the same principle &mdash; the
        latest sales of that card edition.
      </p>

      <h2 id="accuracy" style={H2}>How Much of Our Pricing Rests on Sales</h2>
      <p style={P}>
        Our own gate for the whole platform is the share of priced editions whose
        current FMV is backed by enough recent sales &mdash; rather than by a
        listing alone or by too few prints. We publish it here, per collection,
        exactly as our monitoring
        computes it, because a reader deciding how much weight to give a price
        should see how much of the market it was priced from. A low figure is
        the honest state of a thin or closed market, not a number we tune.
      </p>
      <FmvAccuracyTable result={accuracy} />
      <p style={P}>
        Each figure is the share of editions, not of dollar value, over every
        edition that currently has a price in that collection, taken from the
        latest snapshot per edition. Disney Pinnacle (per pin) and Panini (per
        card edition) are each measured from their own price history, so their
        shares are on a different basis from the other collections and the
        figures are not averaged together.
        The &ldquo;as of&rdquo; time is when the figure was computed; a reading
        more than two days old is marked stale. When a figure cannot be read it
        says <em>unavailable</em> — we do not show a number we did not measure.
      </p>

      <h2 id="estimates" style={H2}>Estimated Value for Rarely-Traded Parallels</h2>
      <p style={P}>
        Some low-supply Top Shot parallels (a /10 Jukebox, say) go months
        without a sale, so their own FMV rests on a handful of old sales —
        sometimes all to the same collector. For those editions, when the full
        edition they are a parallel of still trades, we also show a separate{" "}
        <strong style={STRONG}>Estimated value</strong>: the full edition&rsquo;s
        FMV multiplied by the typical premium that parallel type carries over
        its full edition, and a likely range from the middle half of that
        premium.
      </p>
      <ul style={UL}>
        <li>
          The premium is measured from real sales: each parallel&rsquo;s monthly
          median price against its full edition&rsquo;s median in the same month,
          over the last year, pooled by parallel type and tier.
        </li>
        <li>
          We only use a premium that held up when tested on editions it was not
          built from (typically within 1.5×) and that rests on at least 30
          editions. Noisy combinations get no estimate at all, and neither do
          one-of-ones — a 1/1 is priced by who wants that card, not by a
          multiple of its full edition.
        </li>
        <li>
          An estimate is never above the lowest live ask, and it is always
          labelled with its basis. It is a guide, not a market price: it is not
          the FMV, and it is not used in portfolio values, deal boards or alerts.
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
        Last updated: October 2026. ·{" "}
        <Link href="/" style={{ color: "var(--rpc-text-muted)" }}>
          Back to home
        </Link>
      </div>
    </article>
    </main>
  )
}
