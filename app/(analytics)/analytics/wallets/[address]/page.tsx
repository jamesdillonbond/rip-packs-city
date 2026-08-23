// SEO-indexable wallet profile page.
// Generates one page per active wallet on the Flowty loan book — visiting
// /analytics/wallets/0x... renders that wallet's role-specific stats,
// recent loan activity, and counterparty links.
//
// Uses ISR (revalidate=600) so each page picks up new loan activity
// without rebuilding. dynamicParams: true means we generate on first
// request rather than statically pre-rendering all 60+ wallets at build.

import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { resolveUsernames, displayName } from "@/lib/flowty-username"
import WalletProfile from "@/components/analytics/WalletProfile"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"
import {
  FLOW_ADDR_RE,
  loadWallet,
  loadPositionTransfers,
  lookupUsername,
} from "@/lib/analytics/wallets/detail-fetchers"

export const revalidate = 600
export const dynamicParams = true

interface PageParams {
  params: Promise<{ address: string }>
}

export async function generateStaticParams() {
  // We don't pre-render — let each page generate on first request, then
  // cache via ISR. Returning an empty list means dynamicParams=true takes
  // over for any address requested at runtime.
  return []
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { address } = await params
  const addr = (address || "").toLowerCase()
  if (!FLOW_ADDR_RE.test(addr)) {
    // Username path — let the page handler resolve / 404 below.
    return { title: "Wallet" }
  }
  const { data, ok } = await loadWallet(addr)
  // ⚠ A FAILED read must not publish "not found", and must not let a transient
  // blip de-index a real wallet. `noindex, follow` mirrors /moment/[id].
  if (!ok) {
    return {
      title: "Wallet",
      robots: { index: false, follow: true },
    }
  }
  if (!data) {
    return { title: "Wallet not found" }
  }

  const names = await resolveUsernames([addr])
  const display = displayName(addr, names)

  const totalVolume =
    (data.as_borrower?.total_principal_usd ?? 0) +
    (data.as_lender?.total_principal_usd ?? 0)
  const totalLoans =
    (data.as_borrower?.loan_count ?? 0) + (data.as_lender?.loan_count ?? 0)
  const defaultRate =
    data.as_lender?.default_rate_pct ?? data.as_borrower?.default_rate_pct ?? null

  const isLender = (data.as_lender?.loan_count ?? 0) > 0
  const isBorrower = (data.as_borrower?.loan_count ?? 0) > 0
  const role = isLender && isBorrower ? "Lender + borrower" : isLender ? "Lender" : "Borrower"

  const firstSeen =
    data.as_borrower?.first_seen_at ||
    data.as_lender?.first_seen_at ||
    null
  const firstSeenLabel = firstSeen
    ? new Date(firstSeen).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : "recently"

  const description =
    `${role} on Flowty NFT lending (historical archive). ` +
    `$${Math.round(totalVolume).toLocaleString()} funded across ${totalLoans} loans` +
    (defaultRate != null ? `, ${defaultRate.toFixed(2)}% default rate` : "") +
    `, active since ${firstSeenLabel}.`

  return analyticsMetadata({
    title: `${display} — Flowty Loan Profile (Historical)`,
    description,
    path: `/analytics/wallets/${addr}`,
  })
}

export default async function WalletPage({ params }: PageParams) {
  const { address } = await params
  const raw = (address || "").trim()
  const addr = raw.toLowerCase()

  // Non-hex handle path — try to resolve as a username and redirect.
  if (!FLOW_ADDR_RE.test(addr)) {
    if (!raw || raw.startsWith("0x")) notFound()
    const { data: resolved, ok: lookupOk } = await lookupUsername(raw)
    // ⚠ A failed LOOKUP is not an absent handle. 404ing here tells a visitor the
    // handle does not exist because the RPC blipped — and ISR caches that.
    if (!lookupOk) return <WalletUnavailableCard label={raw} />
    if (!resolved) notFound()
    redirect(`/analytics/wallets/${resolved}`)
  }

  const [walletRes, transfersRes] = await Promise.all([
    loadWallet(addr),
    loadPositionTransfers(addr),
  ])
  // ⚠ A FAILED read must never become a 404. This page is explicitly
  // SEO-indexable and served under ISR (revalidate=600), so a single statement
  // timeout would not 404 one request — it would CACHE that 404 for ten minutes,
  // for every visitor and every crawler. `ok && !data` is a real "no such
  // wallet" and still 404s. See lib/analytics/wallets/detail-fetchers.ts.
  if (!walletRes.ok) return <WalletUnavailableCard label={addr} />
  const data = walletRes.data
  if (!data) notFound()
  // The transfers leg fails INDEPENDENTLY — losing a supplementary section must
  // not take down a page whose primary read succeeded.
  const positionTransfers = transfersRes.data

  const names = await resolveUsernames([addr])
  const username = names.get(addr) ?? null

  const totalVolume =
    (data.as_borrower?.total_principal_usd ?? 0) +
    (data.as_lender?.total_principal_usd ?? 0)
  const totalLoans =
    (data.as_borrower?.loan_count ?? 0) + (data.as_lender?.loan_count ?? 0)

  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    identifier: addr,
    name: username || addr,
    url: `${ANALYTICS_BASE_URL}/analytics/wallets/${addr}`,
  }

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Flowty loan history for ${username || addr} (historical archive)`,
    description:
      `Historical on-chain Flowty loan history for Flow address ${addr} (marketplace closed May 2026). ` +
      `${totalLoans} funded loans totaling $${Math.round(totalVolume).toLocaleString()} of principal.`,
    creator: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/wallets/${addr}`,
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/wallet/${addr}`,
      },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <WalletProfile
        data={data}
        username={username}
        positionTransfers={positionTransfers}
      />
    </>
  )
}

/**
 * Shown when a wallet READ failed — never when the wallet genuinely has no loan
 * activity (that is a real answer and renders the normal profile) and never when
 * the address does not exist (that is still `notFound()`).
 *
 * ⚠ Deliberately NOT a 404. This page is explicitly SEO-indexable and served
 * under ISR with `revalidate = 600`, so a 404 emitted during a statement timeout
 * is CACHED for the next ten minutes — a real, linked wallet reads as deleted to
 * every visitor and crawler that arrives in that window. The metadata branch
 * carries `robots: noindex, follow` for the same reason. Mirrors
 * MomentUnavailableCard in app/moment/[id]/page.tsx.
 */
function WalletUnavailableCard({ label }: { label: string }) {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 28,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rpc-text-primary)",
        }}
      >
        This wallet didn&apos;t load
      </h1>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--rpc-text-secondary)" }}>
        The loan archive is under heavy load right now. This says nothing about whether the
        wallet has activity — only that we couldn&apos;t read it. Reload in a moment.
      </p>
      <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
        {label}
      </p>
    </main>
  )
}
