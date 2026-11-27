// app/help/new-to-collecting/page.tsx — "New to digital collectibles?" (2026-11-27).
//
// Trevor asked whether the site walks a brand-new visitor through what digital
// collectibles, blockchains and wallets are, how RPC works across every
// collection, and how to fund a wallet. /help (2026-10-24) answered how to use
// RPC but assumed the reader already collected; nothing on the site explained
// the basics or funding. This page is that primer.
//
// Rules this page must keep (all standing RPC product rules):
//  - RPC asks for IDENTIFIERS only (username / address). Never tell a reader to
//    connect a wallet to RPC or sign in with one (rpc-no-wallet-signin).
//  - Funding happens on each platform's own site; RPC sells nothing and holds nothing.
//  - Units: Top Shot / All Day / Golazos / UFC = Moments, Pinnacle = Pins,
//    Panini / Candy = Cards. Pinnacle subjects are characters. Non-parallel = "Standard".
//  - Dollar amounts are dollars (no token names for Dapper balance).
//  - No FMV confidence language. Nothing here is financial advice.
// Facts about other platforms (payment methods, wallets) were checked against
// their own help pages on 2026-11-27; when a platform changes, update this page,
// and send readers to the platform's own help for anything account-specific.
//
// It lives under /help/ so proxy.ts already serves it anonymously.

import Link from "next/link"
import type { Metadata } from "next"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import SupportChatConnected from "@/components/SupportChatConnected"
import { OG_INHERITED } from "@/lib/seo"

export function generateMetadata(): Metadata {
  return {
    title: "New to Digital Collectibles? Start Here",
    alternates: { canonical: "https://www.rippackscity.com/help/new-to-collecting" },
    description:
      "A plain-English guide to digital collectibles, blockchains and wallets — which wallet each collection uses, how to add funds, and how Rip Packs City works across all of them.",
    openGraph: {
      ...OG_INHERITED,
      title: "New to Digital Collectibles? Start Here — Rip Packs City",
      description: "Digital collectibles, blockchains, wallets and funding, explained in plain English.",
      images: [{ url: "https://www.rippackscity.com/api/og/default", width: 1200, height: 630, alt: "Rip Packs City" }],
    },
  }
}

const LINK: React.CSSProperties = { color: "var(--rpc-red-text)", textDecoration: "underline", textUnderlineOffset: 3 }
const H2: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 26,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  margin: "44px 0 12px",
  scrollMarginTop: 96,
}
const P: React.CSSProperties = { fontSize: 16, lineHeight: 1.7, color: "var(--rpc-text-secondary)", margin: "0 0 14px" }
const UL: React.CSSProperties = { ...P, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }
const CARD: React.CSSProperties = {
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md, 10px)",
  background: "var(--rpc-surface)",
  padding: "16px 18px",
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={LINK}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

const TOC: { id: string; label: string }[] = [
  { id: "collectibles", label: "What is a digital collectible?" },
  { id: "blockchain", label: "What is a blockchain?" },
  { id: "wallets", label: "What is a wallet?" },
  { id: "by-collection", label: "Each collection, its chain and its wallet" },
  { id: "funding", label: "Adding funds to buy" },
  { id: "using-rpc", label: "Using Rip Packs City across everything" },
  { id: "safety", label: "Staying safe" },
  { id: "glossary", label: "Words you'll see" },
]

type Row = {
  name: string
  unit: string
  chain: string
  wallet: React.ReactNode
  pay: React.ReactNode
  rpc: React.ReactNode
  home: { href: string; label: string }
}

const ROWS: Row[] = [
  {
    name: "NBA Top Shot",
    unit: "Moments",
    chain: "Flow",
    wallet: "Dapper Wallet — made for you when you sign up on Top Shot",
    pay: "Dapper balance (in dollars), or pay at checkout",
    rpc: "Your Top Shot username or Flow address",
    home: { href: "https://nbatopshot.com", label: "nbatopshot.com" },
  },
  {
    name: "NFL All Day",
    unit: "Moments",
    chain: "Flow",
    wallet: "The same Dapper Wallet",
    pay: "Dapper balance, or pay at checkout",
    rpc: "Your Dapper username or Flow address",
    home: { href: "https://nflallday.com", label: "nflallday.com" },
  },
  {
    name: "LaLiga Golazos",
    unit: "Moments",
    chain: "Flow",
    wallet: "The same Dapper Wallet",
    pay: "Dapper balance, or pay at checkout",
    rpc: "Your Dapper username or Flow address",
    home: { href: "https://laligagolazos.com", label: "laligagolazos.com" },
  },
  {
    name: "Disney Pinnacle",
    unit: "Pins",
    chain: "Flow",
    wallet: "The same Dapper Wallet",
    pay: "Dapper balance, or pay at checkout",
    rpc: "Your Dapper username or Flow address",
    home: { href: "https://disneypinnacle.com", label: "disneypinnacle.com" },
  },
  {
    name: "UFC Strike",
    unit: "Moments",
    chain: "Flow and Aptos",
    wallet: "Older Moments may still be in your Dapper Wallet; migrated and new ones live in an Aptos wallet",
    pay: "On UFC Strike's own site and the Aptos marketplaces it uses",
    rpc: "Your Dapper username or Flow address, or search an Aptos address on the UFC Collection tab",
    home: { href: "https://ufcstrike.com", label: "ufcstrike.com" },
  },
  {
    name: "Panini Blockchain",
    unit: "Cards",
    chain: "Panini's own blockchain",
    wallet: "Your Panini account — no outside wallet needed",
    pay: "On Panini's site (PayPal in dollars, or a Panini wallet you top up)",
    rpc: "Your Panini username",
    home: { href: "https://nft.paniniamerica.net", label: "nft.paniniamerica.net" },
  },
  {
    name: "Candy",
    unit: "Cards",
    chain: "Solana",
    wallet: "A self-custody Solana wallet Candy creates for you when you log in",
    pay: "On candy.io, or on Solana marketplaces such as Magic Eden",
    rpc: "Your Solana address",
    home: { href: "https://www.candy.io", label: "candy.io" },
  },
]

const GLOSSARY: { term: string; def: React.ReactNode }[] = [
  { term: "Moment / Pin / Card", def: "What one collectible is called. Moments are video highlights (Top Shot, All Day, Golazos, UFC Strike), Pins are Disney Pinnacle's, Cards are Panini's and Candy's." },
  { term: "Edition", def: "Every copy of the same play, Pin or Card. One edition might have 99 copies or 40,000." },
  { term: "Serial", def: "Which copy you own — #12 of 99. Low serials, #1s and a serial matching the player's jersey number usually sell for more." },
  { term: "Parallel", def: "A special printing of the same edition (a different colour or finish), usually scarcer. The ordinary printing is the Standard." },
  { term: "Mint / burn", def: "Minting creates a collectible on a blockchain; burning destroys it for good. Burns make what's left scarcer." },
  { term: "Pack", def: "A sealed bundle of random collectibles bought from the publisher. Opening one is a rip." },
  { term: "Ask / low ask / floor", def: "An ask is what a seller wants. The low ask, or floor, is the cheapest one listed right now." },
  { term: "FMV", def: <>Fair market value — RPC&apos;s estimate of what an edition typically sells for, built from real sales. How it&apos;s made: <Link href="/legal/fmv-methodology" style={LINK}>FMV methodology</Link>.</> },
  { term: "Pack EV", def: "Expected value: what the contents of a pack are worth on average, compared with what the pack costs." },
  { term: "Custodial / self-custody", def: "Custodial means a company holds the keys for you (Dapper, Panini). Self-custody means you hold them yourself (Candy's Solana wallet, an Aptos wallet)." },
]

export default function NewToCollectingPage() {
  return (
    <>
      <GlobalSiteHeader />
      <PageContentAnchor />
      <main style={{ background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", padding: "48px 20px 96px" }}>
        <article style={{ maxWidth: 760, margin: "0 auto" }}>
          <p style={{ margin: "0 0 10px", fontSize: 13 }}>
            <Link href="/help" style={LINK}>← Help &amp; contact</Link>
          </p>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: "clamp(34px, 7vw, 54px)",
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              lineHeight: 1,
              margin: "0 0 14px",
            }}
          >
            New to digital collectibles?
          </h1>
          <p style={{ ...P, fontSize: 17 }}>
            Start here. This page explains, in plain English, what digital collectibles are, what a blockchain and a
            wallet are, which wallet each collection uses, how to add money to buy, and how Rip Packs City works across all
            of them. It takes about five minutes to read.
          </p>

          <nav aria-labelledby="toc-h" style={{ ...CARD, margin: "24px 0 8px" }}>
            <h2 id="toc-h" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" }}>
              On this page
            </h2>
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9, fontSize: 15 }}>
              {TOC.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} style={LINK}>{t.label}</a>
                </li>
              ))}
            </ol>
          </nav>

          <h2 id="collectibles" style={H2}>What is a digital collectible?</h2>
          <p style={P}>
            It&apos;s the digital version of a trading card. Each one is an officially licensed item — an NBA highlight, an NFL
            play, a Disney Pin, a Panini card — issued in a fixed number of copies, and each copy carries its own serial
            number. You buy them in packs from the publisher or from other collectors on a marketplace, and you can sell or
            trade them later.
          </p>
          <p style={P}>
            What makes them collectible is the same thing that makes paper cards collectible: <strong>scarcity and
            proof</strong>. A record of who owns each copy lives on a blockchain, so nobody can copy yours or print more of
            an edition than was announced. You may also hear them called NFTs (non-fungible tokens) — it means the same thing.
          </p>

          <h2 id="blockchain" style={H2}>What is a blockchain?</h2>
          <p style={P}>
            A blockchain is a shared public ledger — a record book that many computers keep in sync, so no single company
            can quietly change it. Every time a collectible is created, sold or moved, the ledger records it. That&apos;s how
            anyone (including RPC) can see every sale and who owns what without asking anyone&apos;s permission.
          </p>
          <p style={P}>Different collections live on different blockchains, and you don&apos;t have to understand any of them to collect:</p>
          <ul style={UL}>
            <li><strong>Flow</strong> — NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and older UFC Strike Moments.</li>
            <li><strong>Aptos</strong> — UFC Strike&apos;s home since its 2025 move off Flow.</li>
            <li><strong>Solana</strong> — Candy (MLB, DC and Candy&apos;s other licences).</li>
            <li><strong>Panini&apos;s own blockchain</strong> — a private chain run by Panini for Panini Blockchain cards.</li>
          </ul>

          <h2 id="wallets" style={H2}>What is a wallet?</h2>
          <p style={P}>
            A wallet is the account that holds your collectibles on a blockchain. It has a public <strong>address</strong>{" "}
            (a long string like <code>0x1a2b…</code>) that anyone can look up, like a mailing address, and private keys that
            prove it&apos;s yours, like the key to the mailbox. There are two kinds:
          </p>
          <ul style={UL}>
            <li>
              <strong>Custodial</strong> — a company keeps the keys for you and you sign in with an email and password. Dapper
              Wallet (the Flow collections) and your Panini account work this way. It&apos;s the easiest place to start: you can
              pay with a card and there&apos;s no recovery phrase to lose.
            </li>
            <li>
              <strong>Self-custody</strong> — you hold the keys yourself, usually backed up as a 12- or 24-word recovery
              phrase. Candy&apos;s Solana wallet and an Aptos wallet for UFC Strike work this way. Nobody can freeze it, but
              nobody can recover it for you either: if the phrase is lost or stolen, so are the collectibles.
            </li>
          </ul>
          <p style={P}>
            <strong>Rip Packs City never needs your wallet.</strong> To show your collection, RPC only needs the public
            username or address — the same information anyone can already see on the blockchain. RPC will never ask you to
            connect a wallet, sign anything, or share a password or recovery phrase.
          </p>

          <h2 id="by-collection" style={H2}>Each collection, its chain and its wallet</h2>
          <p style={P}>Where each collection lives, which wallet holds it, how you pay, and what to give RPC to see it:</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {ROWS.map((r) => (
              <section key={r.name} aria-label={r.name} style={CARD}>
                <h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800 }}>
                  {r.name} <span style={{ fontWeight: 500, fontSize: 14, color: "var(--rpc-text-muted)" }}>· {r.unit} · {r.chain}</span>
                </h3>
                <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(90px, max-content) 1fr", gap: "4px 14px", fontSize: 15, lineHeight: 1.55 }}>
                  <dt style={{ fontWeight: 700 }}>Wallet</dt>
                  <dd style={{ margin: 0, color: "var(--rpc-text-secondary)" }}>{r.wallet}</dd>
                  <dt style={{ fontWeight: 700 }}>Paying</dt>
                  <dd style={{ margin: 0, color: "var(--rpc-text-secondary)" }}>{r.pay}</dd>
                  <dt style={{ fontWeight: 700 }}>On RPC</dt>
                  <dd style={{ margin: 0, color: "var(--rpc-text-secondary)" }}>{r.rpc}</dd>
                  <dt style={{ fontWeight: 700 }}>Official site</dt>
                  <dd style={{ margin: 0 }}><Ext href={r.home.href}>{r.home.label}</Ext></dd>
                </dl>
              </section>
            ))}
          </div>
          <p style={{ ...P, marginTop: 14 }}>
            One Dapper account covers all four Flow collections, so if you already collect Top Shot you&apos;re set up for NFL
            All Day, LaLiga Golazos and Disney Pinnacle too.
          </p>

          <h2 id="funding" style={H2}>Adding funds to buy</h2>
          <p style={P}>
            RPC sells nothing and never touches your money — you buy on each collection&apos;s own site or marketplace. Here&apos;s how
            funding works on each. Payment options can change, and some depend on your country, so check the platform&apos;s own
            help pages before you deposit.
          </p>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: "20px 0 8px" }}>Dapper (Top Shot, All Day, Golazos, Pinnacle)</h3>
          <ul style={UL}>
            <li>
              Open your Dapper Wallet (on Top Shot, it&apos;s under your profile picture) and find <strong>Dapper Balance</strong>.
            </li>
            <li>
              Add funds by credit or debit card, PayPal, Apple Pay, crypto, or a US bank transfer (ACH). Your balance is in US
              dollars and works across every Dapper collection.
            </li>
            <li>
              You can also pay by card at checkout without a balance. For pack drops, a balance funded ahead of time is the
              quicker way to check out.
            </li>
            <li>
              Help: <Ext href="https://support.meetdapper.com/hc/en-us/articles/1500008826602">Funding your Dapper Balance</Ext>.
            </li>
          </ul>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: "20px 0 8px" }}>Panini Blockchain</h3>
          <ul style={UL}>
            <li>Sign in on Panini&apos;s site. Its main marketplace and auctions charge your linked PayPal in dollars.</li>
            <li>Its buy-now crypto market uses a Panini wallet that you top up on the site.</li>
            <li>
              Help: <Ext href="https://nftguide.paniniamerica.net/buying-and-selling-nfts">Panini&apos;s buying and selling guide</Ext>.
            </li>
          </ul>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: "20px 0 8px" }}>Candy (Solana)</h3>
          <ul style={UL}>
            <li>Log in on candy.io. The first time, Candy creates a self-custody Solana wallet for you.</li>
            <li>
              Buy packs on candy.io. To buy from other collectors on Solana marketplaces such as Magic Eden, you&apos;ll need SOL
              or USDC in that wallet, bought through a wallet&apos;s built-in purchase option or an exchange.
            </li>
            <li>Help: <Ext href="https://www.candy.io/faq">Candy&apos;s FAQ</Ext>.</li>
          </ul>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: "20px 0 8px" }}>UFC Strike (Aptos)</h3>
          <ul style={UL}>
            <li>
              UFC Strike moved to Aptos in 2025. Moments are bought and traded on Aptos marketplaces such as Rarible and
              Tradeport, so you&apos;ll need an Aptos wallet with APT (Aptos&apos;s currency) in it, bought in the wallet or on an exchange.
            </li>
            <li>Moving older Moments from Dapper to Aptos is optional and done on UFC Strike&apos;s own site.</li>
            <li>Help: <Ext href="https://ufcstrike.com">ufcstrike.com</Ext>.</li>
          </ul>
          <p style={P}>
            Before buying anything, it&apos;s worth checking it on RPC first: the edition page shows its FMV next to the low ask and
            recent sales, so you can see whether a price is fair. Set a budget you&apos;re comfortable losing — collectible prices
            go down as well as up, and nothing on RPC is financial advice.
          </p>

          <h2 id="using-rpc" style={H2}>Using Rip Packs City across everything</h2>
          <p style={P}>
            RPC is an independent, read-only research site. It reads every collection&apos;s public sales and listings and puts them
            in one place, with the same tools for each: fair market values, deals below FMV, pack EV, set and team checklists,
            and your whole collection in one binder.
          </p>
          <ol style={UL}>
            <li>
              <strong>Browse without an account.</strong> Pick a collection from the chip at the left of the header; the menus
              (Market, Packs, Insights, Collectors, Trade) work the same for every collection.
            </li>
            <li>
              <strong>Look up any collection.</strong> Paste a username or address on a collection&apos;s <strong>Collection</strong>{" "}
              tab — for example <Link href="/nba-top-shot/collection" style={LINK}>NBA Top Shot</Link>.
            </li>
            <li>
              <strong>Make a free account</strong> (<Link href="/login?intent=signup" style={LINK}>sign up with your email</Link>, no
              password) and save your Dapper username, Solana address and Panini username on your{" "}
              <Link href="/dashboard" style={LINK}>dashboard</Link>. Your binder then totals everything you own across every
              collection, and you can set alerts, watchlists and trophy cases.
            </li>
            <li>
              <strong>Ask the concierge.</strong> The chat button in the corner can explain any number on a page, look up a
              Moment, Pin or Card, or answer a question this page didn&apos;t.
            </li>
          </ol>
          <p style={P}>
            New to the numbers? Start with the <Link href="/insights" style={LINK}>Insights</Link> boards and the{" "}
            <Link href="/market" style={LINK}>Market</Link>, and read <Link href="/legal/fmv-methodology" style={LINK}>how FMV works</Link>.
          </p>

          <h2 id="safety" style={H2}>Staying safe</h2>
          <ul style={UL}>
            <li><strong>Never share a recovery phrase or password</strong> — not with RPC, a &quot;support agent&quot; or anyone else. No real support team will ask for one.</li>
            <li>RPC will never DM you first, ask you to connect a wallet, or ask you to sign a transaction to &quot;verify&quot; or &quot;claim&quot; something.</li>
            <li>Type marketplace addresses yourself or use the links above. Fake sites copy real ones to steal logins.</li>
            <li>Be wary of offers that look too good — a &quot;free airdrop&quot; or a private deal off-platform is the most common scam.</li>
            <li>Marketplaces charge fees when you sell, so a quick resale usually has to beat the price you paid by more than you&apos;d think.</li>
          </ul>

          <h2 id="glossary" style={H2}>Words you&apos;ll see</h2>
          <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {GLOSSARY.map((g) => (
              <div key={g.term} style={CARD}>
                <dt style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>{g.term}</dt>
                <dd style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--rpc-text-secondary)" }}>{g.def}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="next-h" style={{ ...CARD, marginTop: 40, borderColor: "var(--rpc-border-hover)" }}>
            <h2 id="next-h" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 8px" }}>
              Ready?
            </h2>
            <p style={{ ...P, margin: 0 }}>
              <Link href="/login?intent=signup" style={LINK}>Create a free account</Link> to save your collection, or keep browsing the{" "}
              <Link href="/market" style={LINK}>Market</Link>. More questions? See <Link href="/help" style={LINK}>Help &amp; contact</Link>.
            </p>
          </section>
        </article>
      </main>
      <SiteFooter />
      <SupportChatConnected />
    </>
  )
}
