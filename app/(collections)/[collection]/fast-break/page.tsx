// app/(collections)/[collection]/fast-break/page.tsx
//
// Fast Break optimizer page. Top Shot only — other collections see a
// "coming soon" gate. Server component that does the auth + saved-wallet
// lookup, fetches the run + slate, then defers the per-wallet lineup
// fetch to a client island so the optimize round-trip can use
// useWarmCache (60s TTL) and stays responsive after a Save This Lineup.

import Link from "next/link"
import { redirect } from "next/navigation"
import { getCollection } from "@/lib/collections"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import FastBreakClient from "@/components/fast-break/FastBreakClient"
import SlateRow from "@/components/fast-break/SlateRow"

export const dynamic = "force-dynamic"

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function todayInET(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

interface ActiveRun {
  id: string
  name: string
  lineup_size: number
  has_captain: boolean
  start_date: string
  end_date: string
}

interface SlateGame {
  gameId: string
  homeTeam: string
  awayTeam: string
  tipoffAt: string | null
  status: string
}

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

export default async function FastBreakPage(props: {
  params: Promise<{ collection: string }>
}) {
  const params = await props.params
  const collectionId = params.collection

  // 1. Collection gate — Top Shot only for now.
  if (collectionId !== "nba-top-shot") {
    const c = getCollection(collectionId)
    return (
      <section style={{ padding: "40px 0", maxWidth: 760, margin: "0 auto" }}>
        <h1 style={PAGE_HEADER_STYLE}>Fast Break Optimizer</h1>
        <div style={{ ...CARD_STYLE, marginTop: 24, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>{c?.icon ?? "🏀"}</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
            Coming soon for {c?.label ?? "this collection"}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, maxWidth: 440, margin: "0 auto" }}>
            Fast Break is currently only available for NBA Top Shot — coming soon for other collections.
          </div>
          <Link
            href="/nba-top-shot/fast-break"
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
            Open Top Shot Fast Break
          </Link>
        </div>
      </section>
    )
  }

  // 2. Active run + tonight's slate — read directly from supabaseAdmin so
  // there's no extra HTTP hop on the server-rendering path.
  const { data: run } = await supabaseAdmin
    .from("fast_break_runs")
    .select("id, name, lineup_size, has_captain, start_date, end_date")
    .eq("is_active", true)
    .maybeSingle<ActiveRun>()

  const gameDate = todayInET()
  const { data: gameRows } = await supabaseAdmin
    .from("nba_games")
    .select("id, home_team_abbr, away_team_abbr, tipoff_at, status")
    .eq("game_date", gameDate)
    .order("tipoff_at", { ascending: true })

  const games: SlateGame[] = (gameRows ?? []).map(g => ({
    gameId: g.id as string,
    homeTeam: g.home_team_abbr as string,
    awayTeam: g.away_team_abbr as string,
    tipoffAt: g.tipoff_at as string | null,
    status: g.status as string,
  }))

  // 3. Auth + Top Shot wallet lookup. Sign-in card if no user, then
  // connect-wallet card if no Top Shot wallet pinned.
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

  // 4. Header — same shape regardless of auth state, so the page never jumps.
  const subtitle = run
    ? `${run.name} · ${run.lineup_size} players${run.has_captain ? " + Captain" : ""}`
    : "No active run"

  return (
    <section style={{ paddingBottom: 60 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={PAGE_HEADER_STYLE}>Fast Break Optimizer</h1>
        <div style={SUBTITLE_STYLE}>{subtitle}</div>
      </div>

      {!user ? (
        <SignInCard />
      ) : !topShotWallet ? (
        <ConnectWalletCard />
      ) : !run ? (
        <NoRunCard />
      ) : (
        <>
          <SlateRow games={games} gameDate={gameDate} />
          <FastBreakClient
            walletAddr={topShotWallet}
            runId={run.id}
            runName={run.name}
            lineupSize={run.lineup_size as 2 | 3}
            hasCaptain={run.has_captain}
            gameDate={gameDate}
          />
        </>
      )}
    </section>
  )

  // Local helpers — kept inside the file so they share the same design
  // tokens without growing the components/ surface for one-off cards.
  function SignInCard() {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          Sign in to save your Fast Break lineups
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
          Lineups, use counters, and run progress live on your account. Connect a Top Shot wallet after signing in to start building.
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
          Connect your Top Shot wallet to see your optimal lineup
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
          The optimizer reads your eligible moments, joins them against tonight&apos;s DraftKings projections, and recommends a 3-player lineup ranked by Fantasy Points and serial sum.
        </div>
        <Link href="/dashboard" className="rpc-btn-primary" style={{ display: "inline-block", textDecoration: "none" }}>
          Pin a wallet on your dashboard
        </Link>
      </div>
    )
  }

  function NoRunCard() {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          No active Fast Break run
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
          We&apos;ll surface the next run here as soon as Top Shot opens it.
        </div>
      </div>
    )
  }
}

// Suppress the redirect-import warning when running TypeScript without an
// active call site for it. Kept available so Sign-in flows can be redirected
// from this file in a follow-up if we want a server-side bounce instead of a
// client-side click.
void redirect
