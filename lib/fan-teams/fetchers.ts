// lib/fan-teams/fetchers.ts
//
// The reads behind /my-teams, the auth-gated cross-collection fan hub.
//
// ⚠ WHY THEY MOVED. They lived in a `page.tsx`, which neither coverage gate
// measures, and TWO of them turned a failed read into a false claim about the
// READER'S OWN ACCOUNT — the worst version of this class, because the reader is
// the one person who knows it is wrong and has no way to tell that we do not:
//
//   • `fetchFanTeams` returned `[]` on error, and the page renders zero teams as
//     "Follow a team to build your hub" with two suggested teams. A collector
//     who follows six was told they follow none and invited to start over. Same
//     shape as /alerts inviting a duplicate of an alert you already have.
//   • `fetchBoundWallet` returned `null` on error, and the page renders a null
//     wallet as "Add a wallet address or Top Shot username on your profile" —
//     told to add the wallet they already added.
//
// ⚠ These are behind sign-in, which is exactly why no sweep had reached them:
// the anon driver-message guard derives its file set from `isPublicPath`, so
// everything past the auth wall is outside it BY CONSTRUCTION. A signed-in user
// is still a member of the public.

import { supabaseAdmin } from "@/lib/supabase"

export interface FanTeam {
  league: string
  collection_slug: string
  collection_id: string
  team_name: string
  route_slug: string
  primary_color: string | null
  secondary_color: string | null
  abbreviation: string | null
  external_id: string | null
  is_primary: boolean
}

export interface TeamDetail {
  fmv_total_usd?: number | null
  floor_total_usd?: number | null
  edition_count?: number | null
  sales_30d?: number | null
  volume_30d_usd?: number | string | null
}

export interface TeamProgress {
  total?: number
  owned?: number
  completion_pct?: number
  cost_to_complete_usd?: number
  locked_owned?: number
  missing_count?: number
  wallet_cached?: boolean
}

export interface RpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>
}

/**
 * The teams this user follows.
 *
 * ⚠ `ok` is what stops the page telling a collector they follow nothing. An
 * empty list with `ok: true` is a real answer — a new account genuinely follows
 * no teams, and the follow prompt is the right thing to show THEM.
 */
export async function fetchFanTeams(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): Promise<{ teams: FanTeam[]; ok: boolean }> {
  const { data, error } = await (session as RpcClient).rpc("get_my_fan_teams", {})
  if (error) {
    console.error("[my-teams] get_my_fan_teams error:", error.message)
    return { teams: [], ok: false }
  }
  return { teams: Array.isArray(data) ? (data as FanTeam[]) : [], ok: true }
}

/**
 * The user's verified, most-recently-pinned saved wallet.
 *
 * ⚠ Three states, not two: a wallet, no wallet (`ok: true`), and we could not
 * ask (`ok: false`). The page prompts only on the middle one — an unread wallet
 * must not be reported to its owner as an absent one.
 */
export async function fetchBoundWallet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  userId: string,
): Promise<{ wallet: string | null; ok: boolean }> {
  const { data, error } = await session
    .from("saved_wallets")
    .select("wallet_addr, pinned_at")
    .eq("user_id", userId)
    .not("verified_at", "is", null)
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.log("[my-teams] saved wallet read error:", error.message)
    return { wallet: null, ok: false }
  }
  const addr = (data as { wallet_addr?: string } | null)?.wallet_addr
  return { wallet: addr && addr.trim() ? addr.trim() : null, ok: true }
}

/**
 * Public team detail + this user's checklist progress for one team.
 *
 * ⚠ Deliberately NO `ok` flag, and that is not an oversight. Both halves render
 * as an OMISSION — the stat row and the completion bar simply do not appear —
 * which understates, the safe direction, and neither makes a claim the reader
 * could mistake for a measurement. Adding a failure banner per card would put
 * up to N notices on one page for one transient blip; the two account-level
 * reads above are where the honesty actually has to live.
 */
export async function fetchTeamCard(
  team: FanTeam,
  wallet: string | null,
  db: RpcClient = supabaseAdmin as unknown as RpcClient,
): Promise<{ detail: TeamDetail | null; progress: TeamProgress | null }> {
  const [detailRes, progressRes] = await Promise.all([
    db.rpc("get_team_detail", { p_collection_id: team.collection_id, p_team_slug: team.route_slug }),
    db.rpc("get_team_checklist_progress", {
      p_collection_id: team.collection_id,
      p_team_slug: team.route_slug,
      p_scope: "all_time",
      p_wallet: wallet,
    }),
  ])
  const detail =
    detailRes.data && typeof detailRes.data === "object"
      ? Array.isArray(detailRes.data)
        ? (detailRes.data[0] as TeamDetail)
        : (detailRes.data as TeamDetail)
      : null
  // ⚠ `!Array.isArray` here where detail unwraps one: progress is a single row,
  // so an array means the RPC's shape changed and the object would be wrong.
  const progress =
    progressRes.data && typeof progressRes.data === "object" && !Array.isArray(progressRes.data)
      ? (progressRes.data as TeamProgress)
      : null
  return { detail, progress }
}
