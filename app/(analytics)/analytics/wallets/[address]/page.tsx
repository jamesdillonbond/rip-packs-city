// SEO-indexable wallet profile page.
// Generates one page per active wallet on the Flowty loan book — visiting
// /analytics/wallets/0x... renders that wallet's role-specific stats,
// recent loan activity, and counterparty links.
//
// Uses ISR (revalidate=600) so each page picks up new loan activity
// without rebuilding. dynamicParams: true means we generate on first
// request rather than statically pre-rendering all 60+ wallets at build.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveUsernames, displayName } from "@/lib/flowty-username"
import WalletProfile from "@/components/analytics/WalletProfile"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"
import type { WalletDetailResponse } from "@/lib/analytics-types"

export const revalidate = 600
export const dynamicParams = true

const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i

interface PageParams {
  params: Promise<{ address: string }>
}

async function loadWallet(addr: string): Promise<WalletDetailResponse | null> {
  if (!FLOW_ADDR_RE.test(addr)) return null
  try {
    const { data, error } = await (supabaseAdmin.rpc as any)(
      "flowty_analytics_wallet_detail",
      { p_addr: addr }
    )
    if (error) {
      console.log("[wallet/page] rpc_error", error.message)
      return null
    }
    return (data as WalletDetailResponse) ?? null
  } catch (e: any) {
    console.log("[wallet/page] error", e?.message || e)
    return null
  }
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
    return { title: "Wallet not found — Rip Packs City" }
  }
  const data = await loadWallet(addr)
  if (!data) {
    return { title: "Wallet not found — Rip Packs City" }
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
    `${role} on Flowty NFT lending. ` +
    `$${Math.round(totalVolume).toLocaleString()} funded across ${totalLoans} loans` +
    (defaultRate != null ? `, ${defaultRate.toFixed(2)}% default rate` : "") +
    `, active since ${firstSeenLabel}.`

  return analyticsMetadata({
    title: `${display} — Flowty Loan Profile · Rip Packs City`,
    description,
    path: `/analytics/wallets/${addr}`,
  })
}

export default async function WalletPage({ params }: PageParams) {
  const { address } = await params
  const addr = (address || "").toLowerCase()
  if (!FLOW_ADDR_RE.test(addr)) notFound()
  const data = await loadWallet(addr)
  if (!data) notFound()

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
    name: `Flowty loan history for ${username || addr}`,
    description:
      `On-chain Flowty loan history for Flow address ${addr}. ` +
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
      <WalletProfile data={data} username={username} />
    </>
  )
}
