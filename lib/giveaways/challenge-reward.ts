// lib/giveaways/challenge-reward.ts
//
// The link between a trophy challenge and its reward drop (Trevor, 2026-11-10:
// "apply everything needed to the dame time challenge, so that afterwards we can
// have users claim these packs"). A drop with `eligible_challenge_id` set can only
// be claimed by an account with a COMPLETED case in that challenge
// (claim_giveaway_pack → not_eligible). Until now neither page said so: the
// challenge board had no way to the packs, and the claim page showed its form to
// everyone and refused non-finishers only after they pressed Claim.
//
// Three reads, each with THREE answers, never two: the thing · a successful read
// that found nothing (null / false) · a failed read (THROWN — the caller then
// shows nothing extra, never "no reward" or "not eligible").

interface Reader {
  from(table: string): {
    select(cols: string): Chain
  }
}
interface Chain extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  eq(col: string, v: string): Chain
  not(col: string, op: string, v: null): Chain
  order(col: string, o: { ascending: boolean }): Chain
  limit(n: number): Chain
}

export interface RewardChallenge {
  id: string
  slug: string
  title: string
}

export interface RewardDrop {
  slug: string
  title: string
}

const rows = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? (data as Record<string, unknown>[]) : [])
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

/** The challenge a drop's packs are limited to; null when anyone signed in may claim. */
export async function challengeOfDrop(db: Reader, dropId: string): Promise<RewardChallenge | null> {
  const d = await db.from("giveaway_drops").select("eligible_challenge_id").eq("id", dropId).limit(1)
  if (d.error) throw new Error(`giveaway_drops read failed: ${d.error.message}`)
  const challengeId = str(rows(d.data)[0]?.eligible_challenge_id)
  if (!challengeId) return null
  const c = await db.from("trophy_challenges").select("id, slug, title").eq("id", challengeId).limit(1)
  if (c.error) throw new Error(`trophy_challenges read failed: ${c.error.message}`)
  const row = rows(c.data)[0]
  const slug = str(row?.slug)
  const title = str(row?.title)
  // a drop pointing at a challenge we cannot name is a failed read, not "open to everyone"
  if (!slug || !title) throw new Error("the drop's challenge could not be read")
  return { id: challengeId, slug, title }
}

/** Whether this account has a COMPLETED case in the challenge — the same test claim_giveaway_pack applies. */
export async function hasCompletedChallenge(db: Reader, challengeId: string, userId: string): Promise<boolean> {
  const r = await db.from("trophy_cases").select("id").eq("challenge_id", challengeId).eq("user_id", userId).not("completed_at", "is", null).limit(1)
  if (r.error) throw new Error(`trophy_cases read failed: ${r.error.message}`)
  return rows(r.data).length > 0
}

/** The OPEN reward drop for a challenge (the newest, if there were ever two); null when there is none taking claims. */
export async function openRewardDropForChallenge(db: Reader, challengeSlug: string): Promise<RewardDrop | null> {
  const c = await db.from("trophy_challenges").select("id").eq("slug", challengeSlug).limit(1)
  if (c.error) throw new Error(`trophy_challenges read failed: ${c.error.message}`)
  const challengeId = str(rows(c.data)[0]?.id)
  if (!challengeId) return null
  const d = await db
    .from("giveaway_drops")
    .select("slug, title")
    .eq("eligible_challenge_id", challengeId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
  if (d.error) throw new Error(`giveaway_drops read failed: ${d.error.message}`)
  const row = rows(d.data)[0]
  const slug = str(row?.slug)
  const title = str(row?.title)
  return slug && title ? { slug, title } : null
}

export interface UnclaimedReward {
  drop: RewardDrop
  challenge: { slug: string; title: string }
  packsLeft: number
}

/**
 * Reward packs this account EARNED and has not claimed (2026-11-15 activity review:
 * 6 of 27 Dame Time finishers never claimed; knotbean opened the dashboard 14 times
 * after finishing and never reached /giveaways — nothing on the dashboard said a pack
 * was waiting). An earned reward = an OPEN drop whose eligible challenge this account
 * has a COMPLETED case in (claim_giveaway_pack's own test), with no claim by this
 * account and at least one pack left. [] is a successful read that found none; a
 * failed read THROWS, so the caller shows nothing rather than "no reward".
 */
export async function unclaimedRewardsForUser(db: Reader, userId: string): Promise<UnclaimedReward[]> {
  // 2026-11-15: an INTERNAL account (Trevor's, QA) is never invited to claim. Dame Time
  // ended with exactly 6 packs for 6 eligible members, and the founder's account also
  // holds a completed case — one tap on the card would have taken a member's pack.
  const internal = await db.from("internal_accounts").select("user_id").eq("user_id", userId).limit(1)
  if (internal.error) throw new Error(`internal_accounts read failed: ${internal.error.message}`)
  if (rows(internal.data).length > 0) return []
  const cases = await db.from("trophy_cases").select("challenge_id").eq("user_id", userId).not("completed_at", "is", null).limit(50)
  if (cases.error) throw new Error(`trophy_cases read failed: ${cases.error.message}`)
  const challengeIds = [...new Set(rows(cases.data).map((r) => str(r.challenge_id)).filter((s): s is string => s != null))]
  const out: UnclaimedReward[] = []
  for (const challengeId of challengeIds) {
    const drops = await db
      .from("giveaway_drops")
      .select("id, slug, title, pack_count")
      .eq("eligible_challenge_id", challengeId)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(10)
    if (drops.error) throw new Error(`giveaway_drops read failed: ${drops.error.message}`)
    const dropRows = rows(drops.data)
    if (dropRows.length === 0) continue
    let challenge: { slug: string; title: string } | null = null
    for (const d of dropRows) {
      const dropId = str(d.id)
      const slug = str(d.slug)
      const title = str(d.title)
      const packCount = typeof d.pack_count === "number" ? d.pack_count : null
      if (!dropId || !slug || !title || packCount == null) continue
      const mine = await db.from("giveaway_claims").select("id").eq("drop_id", dropId).eq("user_id", userId).limit(1)
      if (mine.error) throw new Error(`giveaway_claims read failed: ${mine.error.message}`)
      if (rows(mine.data).length > 0) continue
      const all = await db.from("giveaway_claims").select("id").eq("drop_id", dropId).limit(1000)
      if (all.error) throw new Error(`giveaway_claims read failed: ${all.error.message}`)
      const packsLeft = packCount - rows(all.data).length
      if (packsLeft <= 0) continue
      if (!challenge) {
        const c = await db.from("trophy_challenges").select("slug, title").eq("id", challengeId).limit(1)
        if (c.error) throw new Error(`trophy_challenges read failed: ${c.error.message}`)
        const cs = str(rows(c.data)[0]?.slug)
        const ct = str(rows(c.data)[0]?.title)
        if (!cs || !ct) throw new Error("the drop's challenge could not be read")
        challenge = { slug: cs, title: ct }
      }
      out.push({ drop: { slug, title }, challenge, packsLeft })
    }
  }
  return out
}
