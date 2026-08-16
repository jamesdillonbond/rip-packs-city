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
import { fetchActiveRun, fetchSlate, type SlateGame } from "@/lib/fast-break/page-data"
import { fetchPinnedWallet } from "@/lib/wallet/pinned-wallet"
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

const PAGE_HEADER_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-display)",
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
          <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
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
  const gameDate = todayInET()
  const [{ run, ok: runOk }, { games, ok: slateOk }] = await Promise.all([
    fetchActiveRun(),
    fetchSlate(gameDate),
  ])

  // 3. Auth + Top Shot wallet lookup. Sign-in card if no user, then
  // connect-wallet card if no Top Shot wallet pinned.
  const user = await getCurrentUser()

  let topShotWallet: string | null = null
  let walletOk = true
  if (user) {
    ;({ wallet: topShotWallet, ok: walletOk } = await fetchPinnedWallet(user.id, NBA_TOP_SHOT_UUID))
  }

  // 4. Header — same shape regardless of auth state, so the page never jumps.
  // "No active run" is a claim about Top Shot's schedule. A failed read must
  // not make it — the em-dash says nothing rather than something false.
  const subtitle = run
    ? `${run.name} · ${run.lineup_size} players${run.has_captain ? " + Captain" : ""}`
    : runOk
      ? "No active run"
      : "—"

  return (
    <section style={{ paddingBottom: 60 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={PAGE_HEADER_STYLE}>Fast Break Optimizer</h1>
        <div style={SUBTITLE_STYLE}>{subtitle}</div>
      </div>

      {!user ? (
        <SignInCard />
      ) : !walletOk ? (
        /* BEFORE the connect-wallet card: an unread wallet is not an absent
           one, and that card tells a collector who HAS pinned one to go connect
           it — a claim about their own account made out of our outage. */
        <UnavailableCard what="your pinned wallet" />
      ) : !topShotWallet ? (
        <ConnectWalletCard />
      ) : !runOk ? (
        /* BEFORE NoRunCard, whose copy promises we would surface a run if there
           were one — the strongest possible form of this false claim. */
        <UnavailableCard what="tonight's Fast Break run" />
      ) : !run ? (
        <NoRunCard />
      ) : (
        <>
          {slateOk ? (
            <SlateRow games={games} gameDate={gameDate} />
          ) : (
            /* An empty slate is a real answer (the NBA does not play nightly),
               so a failed read must not borrow it. */
            <div style={{ ...CARD_STYLE, marginBottom: 16 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-muted)" }}>
                Tonight&rsquo;s slate couldn&rsquo;t be loaded. This says nothing about whether games are on.
              </div>
            </div>
          )}
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
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
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
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
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

  /**
   * The failure card, distinct from every "absent" card above it. The copy must
   * not assert anything about the reader's account or Top Shot's schedule — it
   * says only that WE could not read.
   */
  function UnavailableCard({ what }: { what: string }) {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          Couldn&apos;t load {what}
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
          This is a problem on our side, not a statement about what&apos;s there. Reload in a moment.
        </div>
      </div>
    )
  }

  function NoRunCard() {
    return (
      <div style={{ ...CARD_STYLE, maxWidth: 520 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
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
