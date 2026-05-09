// app/blog/pinnacle-star-wars-day-2026/page.tsx
//
// Star Wars Day 2026 — what's actually moving on Disney Pinnacle.
// Written 2026-05-07; live for the May 4 → May 11 promotional window.
// Numbers in this post were pulled from pinnacle_editions, pinnacle_sales,
// and pinnacle_fmv_snapshots on 2026-05-07 16:30 UTC. They're a snapshot,
// not a live feed — which is the whole point of the post.

import Link from "next/link"

export const dynamic = "force-static"
export const revalidate = 86400

export const metadata = {
  title: "Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving — Rip Packs City",
  description:
    "53 Star Wars editions, 14 sets, 408 historical sales. Where the Mandalorian peak buyers are now underwater, the only edition trading below FMV with HIGH confidence, and what we don't know yet.",
  openGraph: {
    title: "Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving",
    description:
      "Where Mandalorian peak buyers are underwater, the only edition trading below FMV with HIGH confidence, and what we don't know yet.",
    images: ["https://www.rippackscity.com/api/og/collection?id=disney-pinnacle"],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving",
    description:
      "Where Mandalorian peak buyers are underwater, the only edition trading below FMV with HIGH confidence.",
    images: ["https://www.rippackscity.com/api/og/collection?id=disney-pinnacle"],
  },
}

const PAGE: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 20px 72px",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  lineHeight: 1.75,
}

const KICKER: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: "var(--rpc-red, #E03A2F)",
  fontWeight: 700,
  margin: "0 0 12px",
}

const H1: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 40,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  lineHeight: 1.05,
  margin: "0 0 12px",
}

const SUBTITLE: React.CSSProperties = {
  margin: "0 0 32px",
  color: "var(--rpc-text-secondary)",
  fontSize: 16,
  lineHeight: 1.55,
}

const BYLINE: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-muted)",
  margin: "0 0 32px",
  paddingBottom: 16,
  borderBottom: "1px solid var(--rpc-border)",
}

const H2: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: "36px 0 12px",
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

const CALLOUT: React.CSSProperties = {
  margin: "20px 0",
  padding: "16px 18px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderLeft: "3px solid var(--rpc-red, #E03A2F)",
  borderRadius: 6,
  color: "var(--rpc-text-secondary)",
  fontSize: 13,
}

const TABLE: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  margin: "12px 0 18px",
}

const TH: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontWeight: 700,
}

const TD: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-secondary)",
}

const TD_NUM: React.CSSProperties = {
  ...TD,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
  color: "var(--rpc-text-primary)",
  fontVariantNumeric: "tabular-nums",
}

const CTA_BLOCK: React.CSSProperties = {
  marginTop: 40,
  padding: "20px 22px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-red, #E03A2F)",
  borderRadius: 8,
}

const CTA_LINK: React.CSSProperties = {
  display: "inline-block",
  marginTop: 10,
  padding: "10px 18px",
  background: "var(--rpc-red, #E03A2F)",
  color: "#fff",
  textDecoration: "none",
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 800,
  fontSize: 13,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  borderRadius: 6,
}

const FOOTNOTE: React.CSSProperties = {
  marginTop: 40,
  paddingTop: 16,
  borderTop: "1px solid var(--rpc-border)",
  fontSize: 11,
  color: "var(--rpc-text-muted)",
  letterSpacing: "0.04em",
  lineHeight: 1.7,
}

export default function PinnacleStarWarsDay2026() {
  return (
    <article style={PAGE}>
      <p style={KICKER}>Disney Pinnacle · May 7, 2026</p>
      <h1 style={H1}>Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving</h1>
      <p style={SUBTITLE}>
        53 editions, 14 sets, 408 historical sales. Here's where the Mandalorian
        peak buyers are now underwater, the only edition trading below FMV with
        HIGH confidence, and what we still don't know yet.
      </p>
      <p style={BYLINE}>
        By Trevor Dillon-Bond · 8 min read · Numbers as of 2026-05-07 16:30 UTC
      </p>

      <h2 style={H2}>What we're looking at</h2>
      <p style={P}>
        Star Wars Day landed Sunday and runs through May 11. Pinnacle's Star
        Wars catalog isn't dropping a one-time celebration set this year, so the
        relevant question for collectors isn't <em>"what's the new mint?"</em>{" "}
        — it's <em>"what's the existing catalog actually worth right now?"</em>
      </p>
      <p style={P}>
        We have 53 Star Wars editions on Pinnacle today, spanning 14 sets from{" "}
        <strong style={STRONG}>Star Wars Saga Vol.1–3</strong> through the{" "}
        <strong style={STRONG}>Mandalorian</strong>,{" "}
        <strong style={STRONG}>Boba Fett</strong>,{" "}
        <strong style={STRONG}>Rogue One</strong>,{" "}
        <strong style={STRONG}>Vehicles Vol.1–2</strong>, and three event-themed
        runs (<strong style={STRONG}>Celebration</strong>,{" "}
        <strong style={STRONG}>Holiday</strong>,{" "}
        <strong style={STRONG}>Comic Humor</strong>). 408 historical sales
        across the franchise. Most editions trade in a tight $1–$3 band today.
        A handful don't.
      </p>

      <h2 style={H2}>The Grogu Brushed Silver story</h2>
      <p style={P}>
        The most interesting data point in the whole catalog. Grogu's Brushed
        Silver pin from <strong style={STRONG}>The Mandalorian Vol.1</strong>{" "}
        (mint 736) has had{" "}
        <strong style={STRONG}>131 historical sales</strong> at an average of{" "}
        <strong style={STRONG}>$26.50</strong>, with one peak transaction at{" "}
        <strong style={STRONG}>$575</strong>. That's roughly the deepest paper
        history of any single Star Wars edition on the platform.
      </p>
      <p style={P}>
        It's also the worst-performing position in our coverage. The 30-day
        average sale price is <strong style={STRONG}>$2.00</strong> across 4
        sales — a{" "}
        <strong style={STRONG}>91.9% drawdown vs the platform's MEDIUM-confidence FMV ($24.83)</strong>{" "}
        and a much steeper drop from where the early buyers entered. Someone
        paid $575 for one of these. Today's floor is two dollars.
      </p>
      <div style={CALLOUT}>
        <strong style={STRONG}>Read it carefully.</strong> A 92% gap between
        FMV and current sale prints can mean two things. Either FMV is stale
        and needs to come down, or current sales are temporarily depressed and
        FMV is closer to right. We're flagging it so you can decide; we're not
        telling you to buy.
      </div>

      <h2 style={H2}>The volume leaders right now</h2>
      <p style={P}>
        These are the editions actually moving on Pinnacle this week. Volume
        means liquidity — if you want a Star Wars Day pickup that won't sit on
        your wallet for six months, this is where to start.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={TH}>Edition</th>
              <th style={TH}>Variant</th>
              <th style={{ ...TH, textAlign: "right" }}>Sales 30d</th>
              <th style={{ ...TH, textAlign: "right" }}>Avg sale</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={TD}>Luke Skywalker — Saga Vol.1</td>
              <td style={TD}>Standard</td>
              <td style={TD_NUM}>43</td>
              <td style={TD_NUM}>$1.84</td>
            </tr>
            <tr>
              <td style={TD}>Darth Vader — Saga Vol.3</td>
              <td style={TD}>Standard</td>
              <td style={TD_NUM}>30</td>
              <td style={TD_NUM}>$1.03</td>
            </tr>
            <tr>
              <td style={TD}>R2-D2 — Pixels Vol.1</td>
              <td style={TD}>Standard</td>
              <td style={TD_NUM}>24</td>
              <td style={TD_NUM}>$1.00</td>
            </tr>
            <tr>
              <td style={TD}>Admiral Ackbar — Alphabet Vol.1</td>
              <td style={TD}>Golden</td>
              <td style={TD_NUM}>20</td>
              <td style={TD_NUM}>$1.85</td>
            </tr>
            <tr>
              <td style={TD}>Boba Fett — Alphabet Vol.1</td>
              <td style={TD}>Silver Sparkle</td>
              <td style={TD_NUM}>19</td>
              <td style={TD_NUM}>$1.37</td>
            </tr>
            <tr>
              <td style={TD}>Chewbacca — Alphabet Vol.1</td>
              <td style={TD}>Standard</td>
              <td style={TD_NUM}>16</td>
              <td style={TD_NUM}>$1.00</td>
            </tr>
            <tr>
              <td style={TD}>Death Star — Vehicles Vol.1</td>
              <td style={TD}>Standard</td>
              <td style={TD_NUM}>15</td>
              <td style={TD_NUM}>$1.53</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={P}>
        Two takeaways. First, the floor is clamped at $1 across most of the
        Saga Standard catalog — Pinnacle's primary-market pricing has set the
        ceiling at the floor for these. Second, the only Standards trading at
        even a small premium are Luke and Admiral Ackbar — which tracks with
        the LiveToken-era heuristic that protagonists and named-but-rare
        secondary characters move first.
      </p>

      <h2 style={H2}>The one edition with a real signal</h2>
      <p style={P}>
        Out of 53 Star Wars editions, exactly one currently has a HIGH-confidence
        FMV computed against an active sales window:{" "}
        <strong style={STRONG}>C-3PO from Pixels Vol.1, Golden variant</strong>.
      </p>
      <ul style={UL}>
        <li>FMV (HIGH confidence): <strong style={STRONG}>$6.26</strong></li>
        <li>30-day average sale: <strong style={STRONG}>$5.43</strong> across 7 sales</li>
        <li>30-day max sale: <strong style={STRONG}>$15.00</strong></li>
        <li>Implied discount vs FMV: <strong style={STRONG}>~13% below</strong></li>
      </ul>
      <p style={P}>
        This is the only Star Wars edition where we're confident enough in the
        signal density to publish a HIGH-confidence FMV. It's also trading
        below that FMV with consistent volume. If you want one Star Wars Day
        position you can defend with the data, this is it.
      </p>

      <h2 style={H2}>What we don't know yet</h2>
      <p style={P}>
        Honesty pass on coverage gaps so you don't read confidence into numbers
        that aren't there:
      </p>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Mint counts:</strong> only 6 of 53 Star Wars
          editions have a verified mint count in our DB today. The rest show
          NULL — Pinnacle doesn't publish printing data uniformly across sets,
          and we haven't backfilled from on-chain enumeration yet for Pinnacle.
        </li>
        <li>
          <strong style={STRONG}>Ask floors:</strong> zero Star Wars editions
          currently have a real on-marketplace ask price above $1 in our cache.
          Most rows show NULL or the $1 stub. Until our Pinnacle ask-floor
          ingest matures, "discount vs ask" calls aren't trustworthy on this
          franchise — only "discount vs FMV" and historical sale prints are.
        </li>
        <li>
          <strong style={STRONG}>Capsule odds and EV:</strong> Pinnacle hasn't
          released a Star Wars Day capsule for 2026, and we don't compute
          synthetic capsule EV against secondary catalogs. If Disney does a
          surprise drop before May 11, we'll publish odds the same day.
        </li>
      </ul>

      <h2 style={H2}>The play</h2>
      <p style={P}>
        For the May 4 → May 11 window:
      </p>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>If you want signal:</strong> C-3PO Pixels
          Golden is the only HIGH-confidence opportunity in the catalog
          right now.
        </li>
        <li>
          <strong style={STRONG}>If you want liquidity:</strong> Luke Skywalker
          Saga Vol.1 Standard at $1–$2 is the most actively traded edition of
          the franchise.
        </li>
        <li>
          <strong style={STRONG}>If you want a contrarian read:</strong> Grogu
          Brushed Silver at the current $2 floor has 131 historical sales of
          paper interest behind it. The crowd that bid $575 in 2024 isn't
          buying it back at $2; whether that prints a bottom is the live
          question.
        </li>
      </ul>

      <div style={CTA_BLOCK}>
        <strong style={STRONG}>Browse the live Pinnacle sniper</strong>
        <p style={{ ...P, margin: "8px 0 0", fontSize: 13 }}>
          The platform updates floors, sales, and FMV continuously. The numbers
          in this post are a snapshot from 2026-05-07 16:30 UTC and will drift
          before May 11.
        </p>
        <Link href="/disney-pinnacle/sniper" style={CTA_LINK}>
          Open Pinnacle Sniper →
        </Link>
      </div>

      <p style={FOOTNOTE}>
        Methodology: Sales data sourced from{" "}
        <code>pinnacle_sales</code>, FMV from{" "}
        <code>pinnacle_fmv_snapshots</code> (latest computed_at per edition),
        edition metadata from <code>pinnacle_editions</code>. "30-day"
        windows are rolling and computed against NOW() at query time. Confidence
        labels (HIGH / MEDIUM / LOW) follow the same FMV methodology used
        across NBA Top Shot — see{" "}
        <Link href="/legal/fmv-methodology" style={{ color: "var(--rpc-red, #E03A2F)" }}>
          how we calculate FMV
        </Link>
        . Nothing in this post is investment advice. Trade your own book.
      </p>
    </article>
  )
}
