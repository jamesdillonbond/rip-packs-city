// app/blog/premium-chance-hit-vs-chance-hit/page.tsx
//
// What "Premium Chance Hit" means on NBA Top Shot, answered from Dapper's own
// published pack contents (pack_distributions.metadata: total_pack_count and
// original_counts_by_tier, as Top Shot publishes them per drop). Written
// 2026-10-14 for the "premiumchance" Search Console query (docs/strategy/
// seo-2026-09-06-search-console-read.md). A dated SNAPSHOT, not a live feed:
// every figure is arithmetic on the counts Top Shot published at drop time.

import Link from "next/link"
import { OG_INHERITED, TWITTER_INHERITED, articleJsonLd } from "@/lib/seo"
import { getBlogPost, blogPostUrl, formatPostDate } from "@/lib/blog/posts"

export const dynamic = "force-static"
export const revalidate = 86400

const POST = getBlogPost("premium-chance-hit-vs-chance-hit")!
const POST_URL = blogPostUrl(POST)

export const metadata = {
  title: "Premium Chance Hit vs Chance Hit: What NBA Top Shot's Pack Contents Say",
  alternates: { canonical: "https://www.rippackscity.com/blog/premium-chance-hit-vs-chance-hit" },
  description:
    "What a Premium Chance Hit pack on NBA Top Shot actually contains: Rare-or-better Moments per pack across 10 paired drops, from Top Shot's own published pack contents — and the two drops where Premium cost more per hit.",
  openGraph: {
    ...OG_INHERITED,
    title: "Premium Chance Hit vs Chance Hit: What NBA Top Shot's Pack Contents Say",
    description:
      "Rare-or-better Moments per pack across 10 paired Top Shot drops, from the contents Top Shot published.",
    images: [POST.image],
    type: "article",
    url: POST_URL,
    publishedTime: POST.date,
    modifiedTime: POST.dateModified ?? POST.date,
    authors: ["Rip Packs City"],
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Premium Chance Hit vs Chance Hit on NBA Top Shot",
    description: "Rare-or-better Moments per pack across 10 paired drops, from Top Shot's published pack contents.",
    images: [POST.image],
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
  color: "var(--rpc-red)",
  fontWeight: 700,
  margin: "0 0 12px",
}

const H1: React.CSSProperties = {
  fontFamily: "var(--font-display)",
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
  fontFamily: "var(--font-display)",
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
  borderLeft: "3px solid var(--rpc-red)",
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
  border: "1px solid var(--rpc-red)",
  borderRadius: 8,
}

const CTA_LINK: React.CSSProperties = {
  display: "inline-block",
  marginTop: 10,
  padding: "10px 18px",
  background: "var(--rpc-red)",
  color: "#fff",
  textDecoration: "none",
  fontFamily: "var(--font-display)",
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

// Each pair: a Premium Chance Hit drop and the Chance Hit pack from the same
// release. "Hits" = Rare-or-better Moments (Rare, Legendary, Ultimate,
// Anthology, Autograph) per pack; "Legendary+" = Legendary-or-better Moments
// per 100 packs; cost = retail price / hits per pack. Pulled 2026-10-14.
const PAIRS = [
  { drop: "WNBA Fresh Gems", pch: 8641, pchPrice: 99, pchPacks: 200, pchPerPack: 5, pchHits: "2.00", pchLeg: "26.0", ch: 8642, chPrice: 5, chPerPack: 4, chHits: "0.024", chLeg: "1.1", pchCost: "$49.50", chCost: "$208" },
  { drop: "WNBA Metallic Gold LE", pch: 8599, pchPrice: 49, pchPacks: 710, pchPerPack: 5, pchHits: "1.00", pchLeg: "8.2", ch: 8600, chPrice: 10, chPerPack: 5, chHits: "0.043", chLeg: "0.3", pchCost: "$49.00", chCost: "$233" },
  { drop: "2026 NBA Finals", pch: 8550, pchPrice: 49, pchPacks: 500, pchPerPack: 5, pchHits: "2.00", pchLeg: "10.0", ch: 8549, chPrice: 5, chPerPack: 3, chHits: "0.153", chLeg: "0.1", pchCost: "$24.50", chCost: "$32.70" },
  { drop: "WNBA Rookie Debut", pch: 8528, pchPrice: 65, pchPacks: 200, pchPerPack: 7, pchHits: "0.60", pchLeg: "6.5", ch: 8527, chPrice: 10, chPerPack: 3, chHits: "0.005", chLeg: "0.05", pchCost: "$108", chCost: "$2,000" },
  { drop: "2026 NBA Playoffs", pch: 8511, pchPrice: 55, pchPacks: 600, pchPerPack: 6, pchHits: "3.00", pchLeg: "4.8", ch: 8512, chPrice: 5, chPerPack: 5, chHits: "0.041", chLeg: "0.04", pchCost: "$18.30", chCost: "$122" },
  { drop: "Rookie Revelation", pch: 7795, pchPrice: 95, pchPacks: 500, pchPerPack: 5, pchHits: "1.00", pchLeg: "37.6", ch: 7799, chPrice: 5, chPerPack: 3, chHits: "0.059", chLeg: "0.3", pchCost: "$95.00", chCost: "$84.70" },
  { drop: "Run It Back: Origins", pch: 5535, pchPrice: 29, pchPacks: 4999, pchPerPack: 2, pchHits: "1.26", pchLeg: "0.5", ch: 5540, chPrice: 9, chPerPack: 2, chHits: "0.251", chLeg: "0.1", pchCost: "$23.00", chCost: "$35.90" },
  { drop: "Holo Icon", pch: 5546, pchPrice: 39, pchPacks: 4999, pchPerPack: 3, pchHits: "0.13", pchLeg: "2.5", ch: 5554, chPrice: 19, chPerPack: 3, chHits: "0.040", chLeg: "1.0", pchCost: "$300", chCost: "$475" },
  { drop: "WNBA Metallic Gold LE 2025", pch: 5675, pchPrice: 15, pchPacks: 9799, pchPerPack: 3, pchHits: "0.11", pchLeg: "0.7", ch: 5710, chPrice: 5, chPerPack: 2, chHits: "0.022", chLeg: "0.2", pchCost: "$136", chCost: "$227" },
  { drop: "Rookie Revelation (2025)", pch: 5709, pchPrice: 15, pchPacks: 5999, pchPerPack: 3, pchHits: "0.09", pchLeg: "1.2", ch: 5727, chPrice: 5, chPerPack: 2, chHits: "0.037", chLeg: "0.2", pchCost: "$167", chCost: "$135" }
]

const A: React.CSSProperties = { color: "var(--rpc-text-primary)", textDecoration: "underline" }

export default function PremiumChanceHitVsChanceHit() {
  return (
    <article style={PAGE}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            articleJsonLd({
              headline: POST.title,
              description: POST.blurb,
              datePublished: POST.date,
              dateModified: POST.dateModified,
              url: POST_URL,
              image: POST.image,
            }),
          ),
        }}
      />
      <p style={KICKER}>NBA Top Shot · {formatPostDate(POST.date)}</p>
      <h1 style={H1}>Premium Chance Hit vs Chance Hit</h1>
      <p style={SUBTITLE}>
        What a Premium Chance Hit pack actually contains, taken from the
        contents Top Shot itself published for each drop, and how much you pay
        per Rare-or-better Moment compared with the regular Chance Hit pack from
        the same release.
      </p>
      <p style={BYLINE}>
        By Rip Packs City · {POST.readMin} min read · Pack contents as published by Top Shot, pulled Oct 14, 2026
      </p>

      <h2 style={H2}>The short answer</h2>
      <p style={P}>
        On NBA Top Shot, a <strong style={STRONG}>Chance Hit</strong> pack is a
        cheap pack ($3 to $20) that is mostly Common Moments, with a small
        chance of a Rare or better: the &ldquo;hit&rdquo;. A{" "}
        <strong style={STRONG}>Premium Chance Hit</strong> pack is the
        expensive, short-supply version from the same release ($9 to $99, often
        a few hundred packs), with far more Rare-or-better Moments per pack.
      </p>
      <p style={P}>
        What the name does <strong style={STRONG}>not</strong> do is promise a
        fixed amount. Across the Premium Chance Hit drops below, Rare-or-better
        Moments per pack range from <strong style={STRONG}>0.09</strong> to{" "}
        <strong style={STRONG}>3.00</strong>. Recent drops are built around a
        guaranteed hit: Top Shot&rsquo;s own description of a 2026 Premium
        Chance Hit pack reads &ldquo;Each Premium Chance Hit Pack contains 1
        Rare or higher tier Moment&rdquo;. Others were simply better odds: the
        Holo Icon, Rookie Revelation and 2025 WNBA Metallic Gold LE Premium
        packs held about one hit per 8 to 11 packs. Read the pack page for the drop in front of you, not the label.
      </p>

      <h2 style={H2}>Ten paired drops</h2>
      <p style={P}>
        Each row is one release, with its Premium Chance Hit pack beside the
        Chance Hit pack sold alongside it. Every number is arithmetic on Top
        Shot&rsquo;s published pack contents: how many packs and how many
        Moments of each tier the drop held.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={TH}>Release</th>
              <th style={{ ...TH, textAlign: "right" }}>Premium: price · hits/pack · $/hit</th>
              <th style={{ ...TH, textAlign: "right" }}>Chance Hit: price · hits/pack · $/hit</th>
            </tr>
          </thead>
          <tbody>
            {PAIRS.map((r) => (
              <tr key={r.pch}>
                <td style={TD}>
                  <Link href={`/nba-top-shot/pack/dist/${r.pch}`} style={A}>{r.drop}</Link>
                </td>
                <td style={TD_NUM}>
                  ${r.pchPrice} · {r.pchHits} · {r.pchCost}
                </td>
                <td style={TD_NUM}>
                  <Link href={`/nba-top-shot/pack/dist/${r.ch}`} style={A}>${r.chPrice}</Link> · {r.chHits} · {r.chCost}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={P}>
        &ldquo;Hits/pack&rdquo; is Rare-or-better Moments divided by packs.
        Where it lands on a whole number (1.00, 2.00, 3.00) the drop holds
        exactly that many hits per pack, which is consistent with a guaranteed
        slot. Where it does not, it is an average: a 0.13 means roughly one pack
        in eight.
      </p>

      <h2 style={H2}>What the table says</h2>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Per hit, Premium was cheaper in 8 of 10 releases.</strong>{" "}
          The 2026 NBA Playoffs Premium pack worked out to about $18 per
          Rare-or-better Moment; its $5 Chance Hit sibling to about $122.
        </li>
        <li>
          <strong style={STRONG}>Both Rookie Revelation drops went the other way.</strong>{" "}
          The $95 Premium pack cost about $95 per hit against
          about $85 on the $5 Chance Hit pack, and the 2025 $15 Premium pack
          about $167 against $135. A premium label is not a discount by
          default.
        </li>
        <li>
          <strong style={STRONG}>The big swing is in Legendary odds.</strong>{" "}
          Rookie Revelation&rsquo;s Premium pack held about 38 Legendary-or-better
          Moments per 100 packs, and WNBA Fresh Gems about 26, against roughly 1
          or fewer per 100 on most Chance Hit packs.
        </li>
        <li>
          <strong style={STRONG}>Supply is the catch.</strong> Recent Premium
          drops ran 200 to 710 packs. Chance Hit drops usually run 5,000 to
          20,000.
        </li>
      </ul>
      <div style={CALLOUT}>
        A hit is not a price. A Rare from one set can be worth many times a
        Rare from another, so cost per hit compares how many shots you get, not
        what they are worth. For what a drop&rsquo;s contents are worth at
        today&rsquo;s prices, each pack page shows expected value from live FMV.
      </div>

      <h2 style={H2}>How to read a pack before you buy</h2>
      <ul style={UL}>
        <li>Check the pack&rsquo;s tier counts, not its name: Rare + Legendary + Ultimate divided by pack count is your hits per pack.</li>
        <li>Divide the price by that number to get the cost per hit, and compare it with the sibling pack from the same release.</li>
        <li>Then look at which Moments the Rares are. That is where the value actually is.</li>
      </ul>

      <div style={CTA_BLOCK}>
        <strong style={STRONG}>See pack odds and EV for every Top Shot drop</strong>
        <p style={{ ...P, margin: "8px 0 0", fontSize: 13 }}>
          Each pack page shows tier counts, what has been pulled so far and
          expected value at live FMV. Pack Reality compares what packs held
          against what they sold for.
        </p>
        <Link href="/insights/pack-reality" style={CTA_LINK}>
          Open Pack Reality →
        </Link>
      </div>

      <p style={FOOTNOTE}>
        Methodology: pack counts and per-tier Moment counts are the original
        contents Top Shot published for each distribution (stored in{" "}
        <code>pack_distributions.metadata</code>), pulled Oct 14, 2026. Pairs
        match a Premium Chance Hit drop with the Chance Hit pack from the same
        release. Prices are Top Shot&rsquo;s retail price per pack. Nothing in
        this post is investment advice.
      </p>
    </article>
  )
}
