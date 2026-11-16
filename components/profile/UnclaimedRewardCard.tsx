"use client"

// components/profile/UnclaimedRewardCard.tsx
//
// Dashboard Overview card: a reward pack this account EARNED and has not claimed
// (2026-11-15). The weekly activity review found 6 of 27 Dame Time finishers had
// never claimed; knotbean opened the dashboard 14 times after finishing and none of
// the six ever reached /giveaways — the claim lived only on the challenge board and
// the giveaway page, and the dashboard said nothing.
//
// Renders NOTHING unless /api/profile/unclaimed-rewards answered ok AND listed a
// reward. A failed read renders nothing: "a pack is waiting" is a claim about the
// collector's own account, and so is its absence.

import { useEffect, useState } from "react"
import { track } from "@/lib/telemetry/track"

export interface RewardCardItem {
  dropSlug: string
  dropTitle: string
  challengeTitle: string
}

/** The rewards from one ok /api/profile/unclaimed-rewards answer; anything else is []. */
export function rewardsFromBody(body: unknown): RewardCardItem[] {
  if (!body || typeof body !== "object") return []
  const list = (body as { rewards?: unknown }).rewards
  if (!Array.isArray(list)) return []
  const out: RewardCardItem[] = []
  for (const r of list as { drop?: { slug?: unknown; title?: unknown }; challenge?: { title?: unknown } }[]) {
    const dropSlug = typeof r?.drop?.slug === "string" ? r.drop.slug : null
    const dropTitle = typeof r?.drop?.title === "string" ? r.drop.title : null
    const challengeTitle = typeof r?.challenge?.title === "string" ? r.challenge.title : null
    if (dropSlug && dropTitle && challengeTitle) out.push({ dropSlug, dropTitle, challengeTitle })
  }
  return out
}

// One "shown" event per page load, however often the Overview re-mounts.
const shownThisLoad = new Set<string>()

export default function UnclaimedRewardCard() {
  const [rewards, setRewards] = useState<RewardCardItem[]>([])

  useEffect(() => {
    let active = true
    fetch("/api/profile/unclaimed-rewards", { cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => {
        if (!active) return
        const list = rewardsFromBody(body)
        setRewards(list)
        const key = list.map((r) => r.dropSlug).join(",")
        if (list.length && !shownThisLoad.has(key)) {
          shownThisLoad.add(key)
          track("reward-claim-card-shown", { drops: key })
        }
      })
    return () => {
      active = false
    }
  }, [])

  if (rewards.length === 0) return null
  return (
    <>
      {rewards.map((r) => (
        <section
          key={r.dropSlug}
          className="rpc-card"
          data-rpc-unclaimed-reward
          style={{ padding: "16px 20px", border: "1px solid var(--rpc-red-border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 260px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
              Your {r.challengeTitle} reward pack is waiting
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
              You completed {r.challengeTitle}, so one {r.dropTitle} is yours. It isn&rsquo;t sent until you claim it.
            </span>
          </div>
          <a
            href={`/giveaways/${r.dropSlug}`}
            onClick={() => track("reward-claim-card-click", { drop: r.dropSlug })}
            // brand-exception: white label on the red CTA button — theme-independent
            style={{ padding: "12px 20px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}
          >
            Claim your pack →
          </a>
        </section>
      ))}
    </>
  )
}
