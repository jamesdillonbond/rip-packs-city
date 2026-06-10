// app/blog/permanent-moments-ipfs/page.tsx
//
// "Your Moments Just Became Permanent. Here's What That Actually Means."
// Written 2026-06-09, the day after Dapper announced full-catalog IPFS pinning
// for NBA Top Shot (blog.nbatopshot.com/posts/authentic-permanent, 2026-06-08).
// Facts verified against the announcement + our own topshot_ipfs_assets load
// (12,546 catalog rows; ~80% TS edition-page coverage on the Base join).

import Link from "next/link"

export const dynamic = "force-static"
export const revalidate = 86400

export const metadata = {
  title: "Your Moments Just Became Permanent. Here's What That Actually Means. — Rip Packs City",
  description:
    "Top Shot just pinned every Moment's video to IPFS. What content-addressing actually guarantees, how to verify a Moment yourself in 30 seconds, and what we built with the data.",
  openGraph: {
    title: "Your Moments Just Became Permanent. Here's What That Actually Means.",
    description:
      "Top Shot just pinned every Moment's video to IPFS. What content-addressing guarantees, how to verify a Moment yourself, and what we built with the data.",
    images: ["https://www.rippackscity.com/api/og/collection?id=nba-top-shot"],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Your Moments Just Became Permanent. Here's What That Actually Means.",
    description:
      "Top Shot pinned every Moment's video to IPFS. What content-addressing guarantees, and how to verify a Moment yourself in 30 seconds.",
    images: ["https://www.rippackscity.com/api/og/collection?id=nba-top-shot"],
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

const LINK: React.CSSProperties = { color: "var(--rpc-red, #E03A2F)", textDecoration: "none" }

const UPDATE_BOX: React.CSSProperties = {
  margin: "0 0 28px",
  padding: "16px 18px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderLeft: "3px solid var(--rpc-red, #E03A2F)",
  borderRadius: 6,
  color: "var(--rpc-text-secondary)",
  fontSize: 13,
  lineHeight: 1.7,
}

export default function PermanentMomentsIpfs() {
  return (
    <article style={PAGE}>
      <p style={KICKER}>NBA Top Shot · June 9, 2026</p>
      <h1 style={H1}>Your Moments Just Became Permanent. Here&apos;s What That Actually Means.</h1>
      <p style={SUBTITLE}>
        Top Shot just pinned every Moment&apos;s video to IPFS. What content-addressing
        actually guarantees, how to verify a Moment yourself in 30 seconds, and what
        we built with the data the next day.
      </p>
      <p style={BYLINE}>By Trevor Dillon-Bond · 6 min read</p>

      <div style={UPDATE_BOX}>
        <strong style={STRONG}>Update — June 10, 2026: it&apos;s already on-chain.</strong>{" "}
        The <code>TopShotIPFSResolver</code> contract now lives on the Top Shot account
        (0x0b2a3299cc857e29) with a public <code>getCIDs</code> function — give it a set ID,
        play ID, and subedition, and the chain itself returns the media fingerprints. No
        bundle, no intermediary, no Dapper server. We verified our entire indexed catalog
        against it, and it&apos;s actually <em>fresher</em> than the reference-app bundle —
        NBA Cup plays that aren&apos;t in the bundle yet resolve on-chain today. The map is no
        longer just drawn by Dapper; it&apos;s checkable by anyone, straight off Flow.
      </div>

      <p style={P}>
        On June 8, Dapper Labs announced that every NBA Top Shot Moment — the video
        highlight, the artwork, the metadata — is now preserved on IPFS, the
        InterPlanetary File System. Retroactively, across every Series, and at the
        point of mint for everything going forward.
      </p>
      <p style={P}>
        If you&apos;ve been around digital collectibles long enough, you know why this
        matters. If you stepped away from Top Shot because you weren&apos;t sure what
        &quot;owning&quot; a highlight actually meant, this is the announcement that
        answers the question.
      </p>

      <h2 style={H2}>The problem this solves</h2>
      <p style={P}>
        Your ownership record on Flow was always permanent. The blockchain entry saying
        you own serial #217 of a LeBron dunk was never going anywhere. But the dunk
        itself — the actual video file — lived on Dapper&apos;s servers, at Dapper&apos;s
        URLs, behind Dapper&apos;s CDN. The thing your Moment <em>is</em> depended on one
        company staying online and keeping that URL alive.
      </p>
      <p style={P}>
        That&apos;s not a hypothetical risk. Multiple platforms in this space sold people
        digital assets and then shut down. The ownership records survived; the assets
        became wallpaper pointing at dead links. Collectors learned the hard way that a
        token referencing a file is not the same as a file you can prove and retrieve
        yourself.
      </p>

      <h2 style={H2}>What content-addressing actually guarantees</h2>
      <p style={P}>
        IPFS stores files by what they <em>are</em>, not where they live. Every file gets
        a content identifier — a CID — that is a cryptographic fingerprint of the
        file&apos;s bytes. Same file, same CID, forever. Change one pixel and the CID
        changes.
      </p>
      <p style={P}>That gives you three guarantees no CDN URL ever could:</p>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Tamper-evidence.</strong> If anyone altered the video,
          the fingerprint wouldn&apos;t match. The content is its own proof of
          authenticity.
        </li>
        <li>
          <strong style={STRONG}>No single point of failure.</strong> Any node on the
          network can host the file. As long as one node pins it, it&apos;s retrievable —
          through Dapper&apos;s gateway, through public gateways like ipfs.io or dweb.link,
          or through your own node.
        </li>
        <li>
          <strong style={STRONG}>Permissionless verification.</strong> No account. No API
          key. No asking anyone. You can look up any Moment&apos;s media and confirm
          it&apos;s genuine with nothing but an internet connection.
        </li>
      </ul>
      <p style={P}>
        Assets are pinned at the Set level — whether you hold serial #1 or serial
        #15,000, the video and artwork are identical, so one pinned copy covers every
        Moment in the edition.
      </p>

      <h2 style={H2}>Verify a Moment yourself in 30 seconds</h2>
      <p style={P}>
        Dapper published a public reference app that maps every Top Shot play to its IPFS
        content:{" "}
        <a href="https://dapperlabs.github.io/dapperlabs-ipfs-reference-app/" target="_blank" rel="noopener noreferrer" style={LINK}>
          dapperlabs.github.io/dapperlabs-ipfs-reference-app
        </a>
        . Search a player, find the play, and you get the CIDs for the video and artwork.
        Paste any CID after ipfs.io/ipfs/ (or any other gateway) and the file comes back
        from the decentralized network.
      </p>
      <p style={P}>
        That&apos;s the whole point. Not &quot;trust us&quot; — verify it yourself.
      </p>
      <p style={P}>
        Dapper has now gone a step further: the CIDs are readable directly from a contract
        on Flow — <code>TopShotIPFSResolver.getCIDs</code> (see the update at the top of this
        post). The link between your Moment and its media is fully independent — readable
        straight off the chain, no bundle and no intermediary at all.
      </p>

      <h2 style={H2}>What we did with it</h2>
      <p style={P}>
        Rip Packs City is an intelligence platform, so we did what we always do with a new
        public dataset: we indexed it.
      </p>
      <p style={P}>
        Within a day of the announcement, the full IPFS catalog — 12,546 play-set-parallel
        combinations, each with video and artwork CIDs — is loaded into our database and
        joined against our edition catalog. Three things came out of it immediately:
      </p>
      <ul style={UL}>
        <li>
          <strong style={STRONG}>Verified-media on edition pages.</strong> Top Shot
          edition pages on RPC now show the IPFS CIDs for the Moment&apos;s video and
          artwork, with direct gateway links, on roughly 80 percent of editions (the
          newest drops will appear as Dapper&apos;s catalog refreshes).
        </li>
        <li>
          <strong style={STRONG}>Art recovery.</strong> A couple dozen editions in our
          catalog had no usable artwork from the standard CDN paths — mostly parallels
          like Diced and Coded. The IPFS catalog filled them.
        </li>
        <li>
          <strong style={STRONG}>A foundation for resilience.</strong> Because the catalog
          is content-addressed, we&apos;re no longer dependent on any single image host for
          Top Shot media. If a CDN URL dies, the CID doesn&apos;t.
        </li>
      </ul>
      <p style={P}>
        And because we hold the wallet-to-CID join, we can tell you exactly which media backs{" "}
        <em>your</em> collection. Signed-in collectors can now pull a personalized CID list and a
        ready-to-run pin script straight from the{" "}
        <Link href="/dashboard" style={LINK}>dashboard</Link> — your Moments&apos; video and artwork,
        the total size, and one command per file to host the whole thing on your own IPFS node. The
        full Top Shot corpus is about 784 GB — one hard drive. Your slice of it is almost certainly
        far smaller, and now you can see it and keep it.
      </p>

      <h2 style={H2}>Why this is bigger than Top Shot</h2>
      <p style={P}>
        Dapper says the same architecture is being built to extend across all of its
        products — which would put NFL All Day and Disney Pinnacle media on the same
        footing. And it sets a bar for the broader sports-collectibles space: if your
        platform can&apos;t show you a content hash, you&apos;re trusting a server.
      </p>
      <p style={P}>
        For collectors who held through the quiet years: this is the infrastructure
        investment you were promised. For everyone who left: your collection is more
        provably yours today than it was the day you bought it.
      </p>
      <p style={P}>Go verify a Moment. It&apos;s a good feeling.</p>

      <div style={CTA_BLOCK}>
        <strong style={STRONG}>See it on an edition page</strong>
        <p style={{ ...P, margin: "8px 0 0", fontSize: 13 }}>
          Every Top Shot edition page on RPC now carries the verified-on-IPFS block with
          live gateway links wherever Dapper&apos;s catalog covers it. Browse the
          collection and open any Moment.
        </p>
        <Link href="/nba-top-shot/overview" style={CTA_LINK}>
          Open NBA Top Shot →
        </Link>
      </div>

      <p style={FOOTNOTE}>
        Rip Packs City is a Flow blockchain digital collectibles intelligence platform. We
        index the data so you don&apos;t have to trust anyone — including us. Catalog facts
        in this post were verified against Dapper&apos;s 2026-06-08 announcement and our own
        IPFS catalog load on 2026-06-09. Nothing here is investment advice.
      </p>
    </article>
  )
}
