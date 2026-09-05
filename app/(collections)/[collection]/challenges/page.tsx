// app/(collections)/[collection]/challenges/page.tsx
//
// "Challenges" — active Top Shot Set/Crafting Challenges ranked by whether finishing
// is +EV. Reads get_active_challenges (reward value from pack-EV / reward-moment FMV
// × expected packs per completer minus floor cost-to-complete = netEv), the "should I do this?" signal nbatopshot.com's
// own challenge page and third-party trackers don't compute. Server component,
// service-role RPC. Wallet-agnostic here (cost/progress personalize when a wallet is
// passed to the API); the per-challenge plan drill-down lives at /api/topshot/challenge-plan.

import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { fetchActiveChallenges, fetchChallengeFeed } from "@/lib/challenges/hub-fetchers"

export const revalidate = 300


const TYPE_LABEL: Record<string, string> = {
  set_locking: "Set Lock",
  crafting: "Crafting",
  collecting: "Collecting",
}

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return v < 0 ? `-$${s}` : `$${s}`
}

function daysLeft(iso: string | null): string {
  if (!iso) return "—"
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff)) return "—"
  if (diff <= 0) return "ended"
  const d = Math.floor(diff / 86400000)
  if (d >= 1) return `${d}d left`
  const h = Math.floor(diff / 3600000)
  return `${h}h left`
}

export default async function ChallengesPage(props: { params: Promise<{ collection: string }> }) {
  const { collection: collectionId } = await props.params
  const collection = getCollection(collectionId)
  const accent = collection?.accent ?? "var(--rpc-red)"

  if (collectionId !== "nba-top-shot") {
    return (
      <div style={{ padding: "48px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: 14 }}>
        Challenges is a Top Shot feature. <Link href="/nba-top-shot/challenges" style={{ color: accent }}>View Top Shot Challenges →</Link>
      </div>
    )
  }

  // ⚠ The read lives in lib/ so it is BOUNDED and TESTABLE — see that module's
  // header. The `errored` distinction below is unchanged; what changed is that a
  // read which merely HANGS can now reach it.
  const { challenges, ok } = await fetchActiveChallenges()
  const errored = !ok
  // ⚠ Only read the feed's health when we are actually about to claim there are
  // none. A page that HAS challenges makes no promise about future ones, so the
  // probe would be a read taken for a caption nobody sees.
  const feed = !errored && challenges.length === 0 ? await fetchChallengeFeed() : null

  return (
    <div style={{ padding: "8px 0 40px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 26, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
          Challenges
        </h1>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.6, margin: "8px 0 0", maxWidth: 760 }}>
          Active Set &amp; Crafting Challenges, ranked by <strong style={{ color: "var(--rpc-text-primary)" }}>net EV</strong> — the reward&rsquo;s value
          (reward-pack EV or reward-moment FMV) minus the cost to complete the set at the current floor. Positive means finishing nets you value; negative means you&rsquo;d overpay for the reward.
        </p>
      </header>

      {errored && (
        <div style={{ color: "#fecaca", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          Couldn&rsquo;t load challenges right now. Try again shortly.
        </div>
      )}

      {/*
        THREE empty states, not one. The read succeeding and returning nothing
        does NOT license the promise that a new challenge will appear here —
        that depends on the INGEST, which is a different question and has been
        answering HTTP 530 since 2026-08-29. See `fetchChallengeFeed`.
          • current  — the feed is working, so the promise is keepable.
          • stale    — the feed is down; say so instead of promising.
          • unknown  — we could not check; state the fact, make no promise.
      */}
      {!errored && challenges.length === 0 && (
        <div style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16, border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          {feed?.state === "current" ? (
            <>No active challenges are being tracked right now. When Top Shot runs a Set-Locking or Crafting Challenge, it&rsquo;ll show up here with its cost-to-complete and whether finishing is +EV.</>
          ) : feed?.state === "stale" ? (
            <>
              No active challenges are being tracked right now — but our challenge feed is behind
              {feed.lastOkDay ? <> (last updated {feed.lastOkDay})</> : null}, so a challenge Top Shot
              has started since then would <strong style={{ color: "var(--rpc-text-primary)" }}>not</strong> be
              listed here yet. We&rsquo;re working on the connection. Check Top Shot directly if you&rsquo;re mid-challenge.
            </>
          ) : (
            <>No active challenges are being tracked right now.</>
          )}
        </div>
      )}

      {challenges.length > 0 && (
        <div style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                <th style={{ padding: "10px 12px" }}>Challenge</th>
                <th style={{ padding: "10px 12px" }}>Reward</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Required</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Cost to complete</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Reward value</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Net EV</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Ends</th>
              </tr>
            </thead>
            <tbody>
              {challenges.map((c) => {
                const netColor =
                  c.netEv == null ? "var(--rpc-text-muted)" : c.netEv > 0 ? "#34d399" : "#f87171"
                return (
                  <tr key={c.challengeId} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontWeight: 700, color: "var(--rpc-text-primary)" }}>{c.name}</span>
                        <span style={{ fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
                          {TYPE_LABEL[c.challengeType] ?? c.challengeType}
                          {c.completedCount != null && ` · ${c.completedCount.toLocaleString()} completed`}
                          {c.totalRewardAllocation != null && ` / ${c.totalRewardAllocation.toLocaleString()} packs`}
                        </span>
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--rpc-text-secondary)" }}>{c.rewardLabel ?? c.rewardKind ?? "—"}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                      {c.totalRequired}
                      {c.unresolvedSlots != null && c.unresolvedSlots > 0 && (
                        <span style={{ display: "block", fontSize: 10, color: "var(--rpc-text-muted)" }} title="Slots we couldn't price yet (edition not indexed)">
                          {c.unresolvedSlots} unpriced
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-primary)" }}>{usd(c.costToComplete)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-muted)" }}>{usd(c.rewardValue)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 800, color: netColor }}>
                      {c.netEv == null ? "—" : usd(c.netEv)}
                      {c.worthIt != null && (
                        <span style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: netColor }}>
                          {c.worthIt ? "WORTH IT" : "PREMIUM"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-muted)" }}>{daysLeft(c.endsAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", margin: "14px 2px 0", lineHeight: 1.6, maxWidth: 760 }}>
        These are Challenge Builder set challenges: each needs one locked moment per required slot (a specific player in the set), not the whole set. Cost to complete sums the <em>cheapest eligible moment for each slot</em> at the current floor (FMV estimate where no ask is indexed), so it reflects what finishing actually costs. &ldquo;Required&rdquo; is the number of slots. Search a wallet on any challenge to see that wallet&rsquo;s progress and only the slots it&rsquo;s still missing.
      </p>
    </div>
  )
}
