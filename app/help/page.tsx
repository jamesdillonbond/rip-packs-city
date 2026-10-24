// app/help/page.tsx — Help & contact (2026-10-24, CX audit P1).
//
// Before this page there was no help, FAQ or contact surface: the footer carried
// About / FMV Methodology / Terms / Privacy, the contact email lived only inside
// /privacy and /terms, and the only way to report a problem was the AI concierge.
// Every answer below names a page that exists today; keep it that way when a
// flow changes (the concierge's explain_ui_field dictionary is the in-chat twin).

import Link from "next/link"
import type { Metadata } from "next"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"
import { PageContentAnchor } from "@/components/SkipToContent"
import SiteFooter from "@/components/SiteFooter"
import SupportChatConnected from "@/components/SupportChatConnected"
import { OG_INHERITED } from "@/lib/seo"
import { publishedCollections } from "@/lib/collections"

const CONTACT_EMAIL = "rippackscity@gmail.com"

export function generateMetadata(): Metadata {
  return {
    title: "Help & Contact",
    alternates: { canonical: "https://www.rippackscity.com/help" },
    description:
      "Answers to common questions about Rip Packs City — adding your collection, how FMV works, alerts, your account — and how to reach the team.",
    openGraph: {
      ...OG_INHERITED,
      title: "Help & Contact — Rip Packs City",
      description: "How Rip Packs City works, and how to reach the team.",
      images: [{ url: "https://www.rippackscity.com/api/og/default", width: 1200, height: 630, alt: "Rip Packs City" }],
    },
  }
}

const COLLECTIONS = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
  publishedCollections().map((c) => c.label),
)

type Faq = { q: string; a: React.ReactNode }

const LINK: React.CSSProperties = { color: "var(--rpc-red-text)", textDecoration: "underline", textUnderlineOffset: 3 }

const FAQS: Faq[] = [
  {
    q: "What is Rip Packs City?",
    a: (
      <>
        Independent collector intelligence for {COLLECTIONS}: fair market values, live deals below FMV, pack EV,
        set and team checklists, squeeze and scarcity boards, and wallet breakdowns. It is <strong>read-only</strong> —
        RPC never holds your moments, never asks for a wallet connection, and you cannot buy or sell here. When you want
        to buy, our links take you to the marketplace that lists the moment.
      </>
    ),
  },
  {
    q: "Is it free?",
    a: <>Yes. Every page is free to browse, and a free account (email sign-in, no invite) adds saved wallets, alerts, watchlists and a public profile.</>,
  },
  {
    q: "How do I see my collection?",
    a: (
      <>
        Without an account, open any collection&apos;s <strong>Collection</strong> tab (for example{" "}
        <Link href="/nba-top-shot/collection" style={LINK}>NBA Top Shot</Link>) and paste your wallet address or username.
        To save it, <Link href="/login" style={LINK}>sign in</Link> and add it on your{" "}
        <Link href="/dashboard" style={LINK}>dashboard</Link>: a Dapper / Top Shot username or Flow address for the Flow
        collections, a Solana address for Candy MLB, and your Panini username for Panini. RPC only ever needs the
        identifier — never a password or a wallet connection.
      </>
    ),
  },
  {
    q: "How is FMV calculated?",
    a: (
      <>
        FMV is a modelled value built from real sales — the typical recent sale for that edition — not a listing price.
        The full method, including how thin and special-serial sales are handled, is on the{" "}
        <Link href="/legal/fmv-methodology" style={LINK}>FMV methodology</Link> page.
      </>
    ),
  },
  {
    q: "Why doesn't a price match the marketplace?",
    a: (
      <>
        FMV is what an edition typically sells for; the marketplace shows what sellers are asking right now. The two
        differ, especially on editions that rarely trade. Each edition page shows FMV, the low ask and recent sales side
        by side so you can compare — and the concierge can explain any number on the page.
      </>
    ),
  },
  {
    q: "How do alerts work?",
    a: (
      <>
        Set them on <Link href="/alerts" style={LINK}>Alerts</Link> (or the watch button on an edition page) for a price, a
        discount below FMV, or an FMV move. They arrive by email, Telegram or Discord. Email preferences live on{" "}
        <Link href="/dashboard/notifications" style={LINK}>Notifications</Link>. Alert emails also carry a one-tap pause link.
      </>
    ),
  },
  {
    q: "How do I delete my account or my data?",
    a: (
      <>
        Signed in, go to <Link href="/profile/edit" style={LINK}>Edit profile</Link> and use “Delete account”. You can
        also clear your concierge history from the chat header. Details are in the{" "}
        <Link href="/privacy" style={LINK}>privacy policy</Link>.
      </>
    ),
  },
]

export default function HelpPage() {
  return (
    <>
      <GlobalSiteHeader />
      <PageContentAnchor />
      <main style={{ background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", padding: "48px 20px 96px" }}>
        <article style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: "clamp(36px, 7vw, 56px)",
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              lineHeight: 1,
              margin: "0 0 12px",
            }}
          >
            Help &amp; contact
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: "var(--rpc-text-secondary)", margin: "0 0 36px" }}>
            Quick answers below. For anything else, ask the concierge (the chat button in the corner) — it can explain any
            number on a page, look up a moment, or log a bug for the team — or email us.
          </p>

          <section aria-labelledby="contact-h" style={{ border: "1px solid var(--rpc-border-hover)", borderRadius: "var(--radius-md, 10px)", padding: "18px 20px", marginBottom: 40, background: "var(--rpc-surface)" }}>
            <h2 id="contact-h" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 10px" }}>
              Reach the team
            </h2>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, fontSize: 15 }}>
              <li>
                Email: <a href={`mailto:${CONTACT_EMAIL}`} style={LINK}>{CONTACT_EMAIL}</a> — bugs, data corrections, account or privacy requests.
              </li>
              <li>
                X: <a href="https://twitter.com/RipPacksCity" target="_blank" rel="noopener noreferrer" style={LINK}>@RipPacksCity<span className="sr-only"> (opens in a new tab)</span></a>
              </li>
              <li>In the app: open the concierge and choose “Report a bug” — it records the page you were on.</li>
            </ul>
            <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--rpc-text-muted)" }}>
              RPC sells nothing, so a marketplace purchase, payment or delivery question belongs to that marketplace&apos;s support.
            </p>
          </section>

          <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 28, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 16px" }}>
            Common questions
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FAQS.map((f) => (
              <details key={f.q} style={{ border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm, 6px)", background: "var(--rpc-surface)" }}>
                <summary style={{ cursor: "pointer", padding: "14px 16px", fontWeight: 700, fontSize: 16, minHeight: 44 }}>{f.q}</summary>
                <div style={{ padding: "0 16px 16px", fontSize: 15, lineHeight: 1.65, color: "var(--rpc-text-secondary)" }}>{f.a}</div>
              </details>
            ))}
          </div>

          <p style={{ marginTop: 36, fontSize: 14, color: "var(--rpc-text-muted)" }}>
            See also: <Link href="/about" style={LINK}>About</Link> · <Link href="/terms" style={LINK}>Terms</Link> ·{" "}
            <Link href="/privacy" style={LINK}>Privacy</Link>. Nothing on RPC is financial advice.
          </p>
        </article>
      </main>
      <SiteFooter />
      <SupportChatConnected />
    </>
  )
}
