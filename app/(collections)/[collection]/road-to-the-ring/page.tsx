// app/(collections)/[collection]/road-to-the-ring/page.tsx
//
// Road to the Ring page. Top Shot only — same gate pattern as
// /[collection]/fast-break/page.tsx. Server component does the auth
// check + Top Shot saved-wallet lookup, then defers the three sections
// (Tonight's Pick / Tier Progress / Lock ROI) to RTRClient.

import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import RTRClient from "@/components/rtr/RTRClient"

export const dynamic = "force-dynamic"

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const PAGE_HEADER_STYLE: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 28,
  letterSpacing: "0.06em",
  color: "var(--rpc-text-primary)",
  textTransform: "uppercase",
  margin: 0,
}

const SUBTITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-secondary)",
  letterSpacing: "0.1em",
  marginTop: 6,
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg)",
  padding: 24,
}

export default async function RoadToTheRingPage(props: {
  params: Promise<{ collection: string }>
}) {
  const params = await props.params
  const collectionId = params.collection

  // Collection gate — Top Shot only for now.
  if (collectionId !== "nba-top-shot") {
    const c = getCollection(collectionId)
    return (
      <section style={{ padding: "40px 0", maxWidth: 760, margin: "0 auto" }}>
        <h1 style={PAGE_HEADER_STYLE}>Road to the Ring</h1>
        <div style={{ ...CARD_STYLE, marginTop: 24, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>{c?.icon ?? "🏀"}</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
            Coming soon for {c?.label ?? "this collection"}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, maxWidth: 440, margin: "0 auto" }}>
            Road to the Ring is currently only available for NBA Top Shot — coming soon for other collections.
          </div>
          <Link
            href="/nba-top-shot/road-to-the-ring"
            style={{
              display: "inline-block",
              marginTop: 20,
              padding: "10px 20px",
              background: "var(--rpc-red)",
              color: "#fff",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            Open Top Shot Road to the Ring
          </Link>
        </div>
      </section>
    )
  }

  const user = await getCurrentUser()
  let topShotWallet: string | null = null
  if (user) {
    const { data: walletRow } = await supabaseAdmin
      .from("saved_wallets")
      .select("wallet_addr, pinned_at")
      .eq("user_id", user.id)
      .eq("collection_id", NBA_TOP_SHOT_UUID)
      .order("pinned_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const candidate = walletRow?.wallet_addr ?? null
    if (typeof candidate === "string" && /^0x[a-f0-9]{16}$/i.test(candidate)) {
      topShotWallet = candidate.toLowerCase()
    }
  }

  return (
    <section style={{ paddingBottom: 60 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={PAGE_HEADER_STYLE}>Road to the Ring</h1>
        <div style={SUBTITLE_STYLE}>Lock ROI · Tier progress · Nightly picks (coming soon)</div>
      </div>

      {!user ? (
        <SignInCard />
      ) : !topShotWallet ? (
        <ConnectWalletCard />
      ) : (
        <RTRClient walletAddr={topShotWallet} />
      )}
    </section>
  )

  // Mirror the gate cards used on /fast-break — duplicated rather than
  // factored out to a shared component since they're 30 lines and only
  // two consumers exist. Refactor to components/auth-gates/ when a
  // third surface needs them.
  function SignInCard() {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          Sign in to track your Road to the Ring run
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
          Tier progress, lock ROI per moment, and nightly Pick allocations live on your account.
        </div>
        <Link href="/login" className="rpc-btn-primary" style={{ display: "inline-block", textDecoration: "none" }}>
          Sign in
        </Link>
      </div>
    )
  }

  function ConnectWalletCard() {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          Connect your Top Shot wallet to see Lock ROI
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
          Lock ROI ranks every moment in your wallet by estimated playoff points per dollar — the most efficient locks bubble to the top.
        </div>
        <Link href="/dashboard" className="rpc-btn-primary" style={{ display: "inline-block", textDecoration: "none" }}>
          Pin a wallet on your dashboard
        </Link>
      </div>
    )
  }
}
