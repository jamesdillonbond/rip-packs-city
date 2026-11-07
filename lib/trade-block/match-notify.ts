// lib/trade-block/match-notify.ts
//
// "A new listing fits something you hold" (2026-11-02, Trade Block v2). When a listing is
// posted with wants, every OTHER collector who proved an account on the block and holds an
// asset that satisfies one of those wants gets one email — at most one per Pacific day,
// whatever the number of listings. Proving an account on the block is the opt-in; nobody
// who has not is ever matched or mailed.
//
// The day's claim (trade_block_match_notices) is written BEFORE the send, so two listings
// posted together cannot both mail the same collector; a claim that already exists for the
// day is a skip. A failed read or send is logged and dropped — it never fails the listing
// that triggered it. The email names the poster by username and links the listing; it
// carries no asset, price or wallet.

import type { SupabaseClient } from "@supabase/supabase-js"
import { holdingsForWants, wantKeys } from "@/lib/trade-block/match"
import { notifyBlock, type BlockNotifyOutcome } from "@/lib/trade-block/notify"
import type { LoadedListing } from "@/lib/trade-block/store"

/** At most this many collectors are mailed for one listing. */
export const MAX_MATCH_RECIPIENTS = 50

export function pacificDay(now: number): string {
  // en-CA gives YYYY-MM-DD
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
}

export interface MatchNotifySummary {
  wants: number
  members: number
  recipients: number
  sent: number
  skipped_today: number
  failed: number
  error?: string
}

export async function notifyMatchesForListing(
  db: SupabaseClient,
  loaded: LoadedListing,
  deps: { notify?: typeof notifyBlock; log?: (s: string) => void; now?: number } = {},
): Promise<MatchNotifySummary> {
  const log = deps.log ?? ((s: string) => console.log(s))
  const notify = deps.notify ?? notifyBlock
  const now = deps.now ?? Date.now()
  const summary: MatchNotifySummary = { wants: 0, members: 0, recipients: 0, sent: 0, skipped_today: 0, failed: 0 }
  try {
    const wants = wantKeys(loaded.items)
    summary.wants = wants.length
    if (wants.length === 0) return summary
    const poster = loaded.listing.user_id
    const { data, error } = await db.from("trade_block_wallets").select("user_id, source").neq("user_id", poster).order("user_id").order("source").limit(1000)
    if (error) throw new Error(`trade_block_wallets read: ${error.message}`)
    const owner = new Map<string, string>()
    for (const r of (data ?? []) as Array<{ user_id: string; source: string }>) owner.set(r.source, r.user_id)
    summary.members = new Set(owner.values()).size
    if (owner.size === 0) return summary
    const readMeta = { truncated: false }
    const holdings = await holdingsForWants(db, [...owner.keys()], wants, readMeta)
    // A capped read means some holders may not be mailed: a best-effort notice, so
    // say so in the log rather than fail the post (2026-11-07 review).
    if (readMeta.truncated) log("[trade-block/match-notify] a holdings read hit its cap — some holders may not be notified")
    const recipients = [...new Set(holdings.map((h) => owner.get(h.source)).filter((u): u is string => !!u && u !== poster))].slice(0, MAX_MATCH_RECIPIENTS)
    summary.recipients = recipients.length
    const day = pacificDay(now)
    for (const userId of recipients) {
      // claim the day first; a second listing the same day finds the claim and skips
      const { error: claimError } = await db.from("trade_block_match_notices").insert({ user_id: userId, day, listing_id: loaded.listing.id })
      if (claimError) {
        if (claimError.code === "23505") summary.skipped_today++
        else {
          summary.failed++
          log(`[trade-block/match-notify] claim failed: ${claimError.message}`)
        }
        continue
      }
      const out: BlockNotifyOutcome = await notify(db, userId, poster, "match", { listingCode: loaded.listing.code })
      if (out.status === "sent") summary.sent++
      else if (out.status === "failed") summary.failed++
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e)
  }
  log(`[trade-block/match-notify] listing=${loaded.listing.code} ${JSON.stringify(summary)}`)
  return summary
}
